"""ASRセグメント単位のLLM日本語校正 — 本番 correct.ts 移植 (パイプライン A 工程0).

本番 frontend/src/lib/pipeline/correct.ts の SYSTEM_PROMPT・修正ルールを移植。
講師の話し方が破綻した日本語 (主語述語不整合・逆接/順接の崩れ・ASR誤変換) を
セグメント全体の文脈で最小限修復する。意味・情報量は変えない (docs/ideas.md I-14)。

設計大原則 (CLAUDE.md): LLMの役割は「意味」側 (壊れた日本語を直す)。文字数・CPS
チェックはここでは行わない。

本番 (correct.ts) からの移植点:
  - id付きJSON入出力 ({"segments": [...]} -> {"corrections": [...]})
  - バッチ処理 (既定20件/req)
  - 件数不一致・パース失敗時の半分割リトライ (correctBatchWithFallback 相当)
  - few-shot 1組
本番との相違:
  - 強モデル役 (constants.STRONG_MODEL) を LLMBackend 経由で呼ぶ。LLMBackend は
    single-turn のため、本番が user/assistant 別ターンで渡す few-shot 例は
    SYSTEM_PROMPT 末尾に埋め込む。
  - 専門用語リスト (本番ルール2) は PoC に glossary が無いため省略。
  - 1件まで分割しても校正できないセグメントは原文を維持する (PoC方針: 1件の
    校正失敗で実行全体を止めない)。本番は例外送出。

この工程は optimizer.build_cues の工程0 として配線済み。校正・再分割は世代
ループの外で1回だけ実行し、全世代でキュー集合を固定する (進化対象外)。
"""

import json

from poc.subtitle_agent.llm import clean_llm_output
from poc.subtitle_agent.llm_backend import LLMBackend

DEFAULT_BATCH_SIZE = 20
_CORRECTION_TEMPERATURE = 0.1

# 本番 correct.ts の SYSTEM_PROMPT を移植 (専門用語リスト関連のルールは省略)。
_BASE_SYSTEM_PROMPT = (
    "あなたは日本語書き起こしテキストの校正専門家です。\n"
    "\n"
    'Input format:  {"segments": [{"id": N, "text": "..."}]}\n'
    'Output format: {"corrections": [{"id": N, "text": "..."}]}\n'
    "\n"
    "修正ルール:\n"
    "1. フィラー語を除去（えー、ええ、あの、あのー、えーと、そのー、まあ、"
    "ちょっと等）\n"
    "2. 口語表現を自然な書き言葉に整える\n"
    "3. ASR由来の明らかな誤変換・同音異義語ミス・文脈上不自然な語を、"
    "自然で意味の通る日本語に修正する\n"
    "4. 数量・件数・時制・主語述語の対応を文脈に合わせて整える"
    "（逆接で始まり順接で終わる等の破綻もここで直す）\n"
    "5. 文の意味・情報量は変えない（要約・追加は禁止）\n"
    "\n"
    "ASR誤変換の扱い:\n"
    "- 文として意味が通らない場合は、最も尤もらしい元の表現へ修正してよい\n"
    "- 例: 誤字、脱字、助詞抜け、同音異義語、専門語の聞き間違い、漢字変換ミス\n"
    "- ただし推測で新情報を足さない。文脈から強く支持される修正だけ行う\n"
    "\n"
    "CRITICAL: 入力セグメント1件につき正確に1件の correction を出力する。"
    "corrections 配列の長さは入力 segments 配列の長さと完全に一致させること。\n"
    "意味を大きく変える修正は絶対にしないこと。"
)

# 本番 correct.ts が user/assistant 別ターンで渡す few-shot 例。
_FEWSHOT_INPUT = {
    "segments": [
        {
            "id": 1,
            "text": "えーっと機械学習というのはですね、"
            "データから自動的に学習するアルゴリズムのことです。",
        },
        {"id": 2, "text": "現時点で出見中7件完了しています。"},
        {"id": 3, "text": "こちらはよやく機能のせっけいを進めています。"},
    ]
}
_FEWSHOT_OUTPUT = {
    "corrections": [
        {
            "id": 1,
            "text": "機械学習とは、データから自動的に学習するアルゴリズムのことです。",
        },
        {"id": 2, "text": "現時点で未提出7件を完了しています。"},
        {"id": 3, "text": "こちらは予約機能の設計を進めています。"},
    ]
}

SYSTEM_PROMPT = (
    _BASE_SYSTEM_PROMPT
    + "\n\n例:\n入力: "
    + json.dumps(_FEWSHOT_INPUT, ensure_ascii=False)
    + "\n出力: "
    + json.dumps(_FEWSHOT_OUTPUT, ensure_ascii=False)
)


def _source_text(seg: dict) -> str:
    """校正対象テキスト。決定論校正済みの ja_corrected を優先する。"""
    return seg.get("ja_corrected") or seg.get("text") or seg.get("ja", "")


def _extract_json_object(content: str) -> dict:
    """LLM応答テキストから最初のJSONオブジェクトを取り出す。"""
    cleaned = clean_llm_output(content)
    start = cleaned.find("{")
    end = cleaned.rfind("}")
    if start == -1 or end == -1 or end < start:
        raise ValueError(f"JSONオブジェクトが見つかりません: {cleaned[:200]}")
    return json.loads(cleaned[start : end + 1])


def _call_correction(
    batch: list[tuple[int, str]], backend: LLMBackend
) -> list[str]:
    """1バッチを校正LLMに投げ、入力順の校正テキスト列を返す。

    件数不一致・JSONパース失敗は ValueError を投げる (呼び出し側が半分割再試行)。
    応答に欠落した id は原文のまま埋める。
    """
    user = json.dumps(
        {"segments": [{"id": i, "text": t} for i, t in batch]},
        ensure_ascii=False,
    )
    content = backend.complete(SYSTEM_PROMPT, user, _CORRECTION_TEMPERATURE)
    parsed = _extract_json_object(content)
    corrections = parsed.get("corrections")
    if not isinstance(corrections, list):
        raise ValueError("応答に corrections 配列がありません")
    if len(corrections) != len(batch):
        raise ValueError(
            f"corrections {len(corrections)} 件 / 入力 {len(batch)} 件 — 件数不一致"
        )
    by_id: dict[int, str] = {}
    for c in corrections:
        if isinstance(c, dict) and "id" in c and "text" in c:
            by_id[int(c["id"])] = str(c["text"]).strip()
    return [by_id.get(i) or original for i, original in batch]


def _correct_batch_with_fallback(
    batch: list[tuple[int, str]], backend: LLMBackend
) -> list[str]:
    """バッチを校正する。失敗時は半分割で再試行する (本番 correctBatchWithFallback 相当).

    1件まで分割しても校正できないセグメントは原文のまま返す
    (PoC方針: 1件の校正失敗で実行全体を止めない)。
    """
    if not batch:
        return []
    try:
        return _call_correction(batch, backend)
    except (ValueError, RuntimeError) as e:
        if len(batch) == 1:
            print(f"  [correct] seg {batch[0][0]}: 校正失敗 -> 原文を維持 ({e})")
            return [batch[0][1]]
    mid = (len(batch) + 1) // 2
    left = _correct_batch_with_fallback(batch[:mid], backend)
    right = _correct_batch_with_fallback(batch[mid:], backend)
    return left + right


def correct_segments(
    asr_segments: list[dict],
    backend: LLMBackend,
    batch_size: int = DEFAULT_BATCH_SIZE,
) -> list[dict]:
    """ASRセグメント群をLLM校正し、`ja_corrected` を更新した新リストを返す。

    入力は変更せず、各セグメントの dict を浅コピーして `ja_corrected` を
    校正後テキストに差し替える (CLAUDE.md: イミュータブル更新)。
    """
    if not asr_segments:
        return []

    inputs: list[tuple[int, str]] = [
        (i, _source_text(seg)) for i, seg in enumerate(asr_segments)
    ]
    corrected: list[str] = []
    for start in range(0, len(inputs), batch_size):
        batch = inputs[start : start + batch_size]
        corrected.extend(_correct_batch_with_fallback(batch, backend))
        done = min(start + batch_size, len(inputs))
        print(f"  [correct] {done}/{len(inputs)} セグメント校正済み")

    return [
        {**seg, "ja_corrected": corrected[i]}
        for i, seg in enumerate(asr_segments)
    ]
