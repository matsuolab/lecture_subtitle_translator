"""字幕候補の定量評価器 (Phase 1 の土台).

「スコアが計算できる状態」を作ることがプロジェクトのゴールの一部。
この評価器は次を保証する:

- 評価結果は frozen dataclass `EvalResult` で返す。
  全フィールドが必ず埋まるため、呼び出し側で `dict.get(key, 0.0)` による
  キー欠落バグ (旧PoCの平均類似度 0.0000 の原因) が構造的に起こり得ない。
- 評価対象は全セグメント。違反ブロックに限定しない。
"""

import math
from dataclasses import dataclass

import openai

from poc.subtitle_agent import constants


@dataclass(frozen=True)
class EvalResult:
    """字幕候補1件の評価結果。全フィールドが常に埋まる。"""

    score: float
    similarity: float
    cps: float
    line_chars_max: int
    line_count: int
    segment_chars: int
    cps_ok: bool
    line_ok: bool
    segment_ok: bool
    compliant: bool
    rejected: bool
    reason: str


def cosine_similarity(vec_a: list[float], vec_b: list[float]) -> float:
    """ピュアPythonでのコサイン類似度算出 (環境依存回避)。"""
    dot = sum(a * b for a, b in zip(vec_a, vec_b))
    norm_a = math.sqrt(sum(a * a for a in vec_a))
    norm_b = math.sqrt(sum(b * b for b in vec_b))
    if norm_a == 0.0 or norm_b == 0.0:
        return 0.0
    return dot / (norm_a * norm_b)


def get_embedding(
    text: str,
    client: openai.OpenAI,
    model: str = constants.EMBEDDING_MODEL,
    instruction: str = constants.EMBED_TASK_INSTRUCTION,
) -> list[float]:
    """LM Studio の Qwen3-Embedding からベクトルを取得する。

    Qwen3-Embedding は instruction 付き入力を前提とするモデル。
    正規フォーマット "Instruct: {task}\\nQuery: {text}" を付与してから埋め込む。
    日英どちらも同じ instruction を使う (対称な意味類似度タスクのため)。

    フェイルファスト設計: 接続失敗時は曖昧な代替をせず即座に例外を投げる。
    """
    formatted = f"Instruct: {instruction}\nQuery: {text}"
    try:
        response = client.embeddings.create(input=[formatted], model=model)
        return response.data[0].embedding
    except Exception as e:
        print(
            "\n[CRITICAL ERROR] ローカル Embedding サーバーへの接続に失敗しました: "
            f"{e}"
        )
        print(
            "【対処法】LM Studio を起動し、ポート 1234 で "
            f"'{model}' をロードしてください。"
        )
        raise


def _char_count(text: str) -> int:
    """改行を除いた表示文字数。CPS・セグメント長判定に用いる。"""
    return len(text.replace("\n", ""))


def measure_constraints(
    candidate_en: str, start: float, end: float
) -> tuple[float, int, int, int]:
    """CPS・最大行長・行数・セグメント文字数を機械的に算出する。"""
    duration = max(0.1, end - start)
    chars = _char_count(candidate_en)
    cps = chars / duration
    lines = candidate_en.split("\n")
    line_chars_max = max((len(line) for line in lines), default=0)
    return cps, line_chars_max, len(lines), chars


def evaluate_subtitle(
    original_ja: str,
    candidate_en: str,
    start: float,
    end: float,
    llm_calls: int,
    client: openai.OpenAI,
    emb_model: str = constants.EMBEDDING_MODEL,
    similarity_threshold: float = constants.SIMILARITY_THRESHOLD,
) -> EvalResult:
    """字幕候補を多目的にスコアリングする。

    不動の基準 `original_ja` と候補英語 `candidate_en` の意味コサイン類似度を測定し、
    CPS・行長・セグメント長の制約違反ペナルティを差し引いた総合スコアを返す。
    """
    cps, line_chars_max, line_count, segment_chars = measure_constraints(
        candidate_en, start, end
    )
    cps_ok = cps <= constants.TARGET_CPS
    line_ok = line_chars_max <= constants.MAX_LINE_CHARS and line_count <= constants.MAX_LINES
    segment_ok = segment_chars <= constants.MAX_SEGMENT_CHARS

    vec_ja = get_embedding(original_ja, client, emb_model)
    vec_en = get_embedding(candidate_en, client, emb_model)
    similarity = cosine_similarity(vec_ja, vec_en)

    # 致命的なセマンティックロスは即却下 (Score=0)
    if similarity < similarity_threshold:
        return EvalResult(
            score=0.0,
            similarity=similarity,
            cps=cps,
            line_chars_max=line_chars_max,
            line_count=line_count,
            segment_chars=segment_chars,
            cps_ok=cps_ok,
            line_ok=line_ok,
            segment_ok=segment_ok,
            compliant=False,
            rejected=True,
            reason=(
                f"Semantic similarity ({similarity:.4f}) below threshold "
                f"({similarity_threshold})"
            ),
        )

    cps_penalty = max(0.0, (cps - constants.TARGET_CPS) / constants.TARGET_CPS)

    line_penalty = 0.0
    if line_count > constants.MAX_LINES:
        line_penalty += 0.5 * (line_count - constants.MAX_LINES)
    for line in candidate_en.split("\n"):
        if len(line) > constants.MAX_LINE_CHARS:
            line_penalty += (len(line) - constants.MAX_LINE_CHARS) / constants.MAX_LINE_CHARS

    segment_penalty = max(
        0.0, (segment_chars - constants.MAX_SEGMENT_CHARS) / constants.MAX_SEGMENT_CHARS
    )

    # 短尺ペナルティ: 快適下限 (COMFORT_MIN_CUE_DURATION) 未満のキューを減点する。
    # 7秒は理想ではなく上限なので「7秒からの距離」は使わない。短く読みやすい
    # キューは良いキュー。これは optimizer に merge する勾配を与える項。
    duration = max(0.1, end - start)
    short_penalty = 0.0
    if duration < constants.COMFORT_MIN_CUE_DURATION:
        short_penalty = (
            constants.COMFORT_MIN_CUE_DURATION - duration
        ) / constants.COMFORT_MIN_CUE_DURATION

    time_penalty = llm_calls * constants.W_TIME

    score = (
        constants.W_ALIGN * similarity
        - constants.W_CPS * cps_penalty
        - constants.W_LINE * line_penalty
        - constants.W_SEGMENT * segment_penalty
        - constants.W_DURATION * short_penalty
        - time_penalty
    )
    score = max(0.01, score)

    return EvalResult(
        score=score,
        similarity=similarity,
        cps=cps,
        line_chars_max=line_chars_max,
        line_count=line_count,
        segment_chars=segment_chars,
        cps_ok=cps_ok,
        line_ok=line_ok,
        segment_ok=segment_ok,
        compliant=cps_ok and line_ok and segment_ok,
        rejected=False,
        reason="",
    )
