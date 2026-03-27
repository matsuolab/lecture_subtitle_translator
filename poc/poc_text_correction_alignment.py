"""
PoC: LLM全文一括補正 + diff-based アライメント + ギャップ/句点分割

処理フロー:
  WhisperX JSON
    ↓ ① Gemini で全文一括補正（全文in → 全文out）
        ← セグメント境界跨ぎの誤字・文脈を正確に処理
    ↓ ② diff-based アライメント（全文単位）
        ← 補正前後の文字対応をとってタイムスタンプを引き継ぐ
    ↓ ③ ギャップ検出 + 「。」でセンテンス分割
  センテンス境界 (start, end, text) → SRT出力

使用方法:
  .\\setup.ps1                    # 初回のみ
  .\\.venv\\Scripts\\Activate.ps1
  python poc_text_correction_alignment.py
"""

import json
import sys
import os
import difflib
import time
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()

# ---------------------------------------------------------------------------
# 設定
# ---------------------------------------------------------------------------
JSON_PATH          = "20260323_whisperx_ja_timestamp/matsuo_agentic_rag.json"
OUTPUT_DIR         = Path("20260323_whisperx_ja_timestamp")
TEST_SEGMENT_COUNT = None    # None で全セグメント対象
GAP_THRESHOLD      = 0.30    # ギャップ検出の閾値（秒）
MAX_OUTPUT_CHARS   = 35000   # この文字数を超えたらチャンク分割（Flashの出力上限に対する安全マージン）
CONTEXT_OVERLAP    = 1500    # チャンク前後に渡す文脈文字数（境界付近の精度向上）
MODELS = [
    "gemini-3-flash-preview",
]


# ---------------------------------------------------------------------------
# データ構造
# ---------------------------------------------------------------------------
@dataclass
class CharTS:
    char:  str
    start: float
    end:   float
    score: float = 0.0


@dataclass
class Sentence:
    text:  str
    start: float
    end:   float


# ---------------------------------------------------------------------------
# WhisperX JSON 読み込み
# ---------------------------------------------------------------------------
def load_segments(path: str) -> list[dict]:
    with open(path, encoding="utf-8") as f:
        return json.load(f)["segments"]


def extract_chars(segment: dict) -> list[CharTS]:
    """セグメントから文字レベルタイムスタンプを抽出。start/end 欠落は補完。"""
    result = []
    last_end = segment.get("start", 0.0)
    for c in segment.get("chars", []):
        start = c.get("start", last_end)
        end   = c.get("end", start)
        result.append(CharTS(char=c["char"], start=start, end=end,
                             score=c.get("score", 0.0)))
        last_end = end
    return result


# ---------------------------------------------------------------------------
# ① LLM 全文一括補正
# ---------------------------------------------------------------------------
def correct_full_text(raw_text: str, model_name: str) -> str:
    """
    講義書き起こし全文を一括で字幕用テキストに整形する。
    - 句読点追加・フィラー削除・誤字修正
    - 全文を通して処理するのでセグメント境界跨ぎも正確に扱える
    - 出力は1行テキスト（改行なし）
    """
    import google.generativeai as genai
    genai.configure(api_key=os.environ["GEMINI_API_KEY"])
    model = genai.GenerativeModel(model_name)

    prompt = f"""あなたは日本語講義の字幕編集者です。
以下は音声認識による書き起こし全文です。句読点がなく、誤字が含まれます。

整形ルール：
1. 意味のひとまとまりごとに「。」で区切る（1文の目安：15〜30文字）
2. 読点「、」は文内の自然な間に追加する
3. 明らかな無意味フィラーのみ削除する（えー、あのー、えーと に限定）
   ※「まあ」「なんか」「ちょっと」等は話者の意図が含まれる場合があるので残す
4. 文脈から明らかな誤字・誤変換のみ修正する（同音異義語の間違い等）
5. 【最重要】内容の省略・要約・言い換えは一切禁止。話者が言った内容はすべて残す
6. 改行は入れない。整形後の1行テキストのみ出力する（説明・コメント不要）

書き起こし全文：
{raw_text}"""

    response = model.generate_content(
        prompt,
        generation_config={"max_output_tokens": 65536},
    )
    return response.text.strip()


# ---------------------------------------------------------------------------
# チャンク分割（出力上限対策）
# ---------------------------------------------------------------------------
def split_into_chunks(all_chars: list[CharTS],
                      gap_threshold: float,
                      max_chars: int) -> list[list[CharTS]]:
    """
    ギャップ境界を優先しながら max_chars 以下のチャンクに分割する。
    文の途中で切れないよう、必ずギャップ位置で切る。
    """
    # まずギャップ境界のインデックスを収集
    gap_indices: list[int] = [0]
    for i in range(1, len(all_chars)):
        c_prev = all_chars[i - 1]
        c_curr = all_chars[i]
        if c_prev.char.strip() and c_curr.char.strip():
            if (c_curr.start - c_prev.end) >= gap_threshold:
                gap_indices.append(i)
    gap_indices.append(len(all_chars))

    # ギャップ境界をまとめて max_chars 以下のチャンクに
    chunks: list[list[CharTS]] = []
    chunk_start = 0

    for k in range(1, len(gap_indices)):
        seg_end = gap_indices[k]
        chunk_text_len = sum(
            1 for c in all_chars[chunk_start:seg_end] if c.char.strip()
        )
        if chunk_text_len >= max_chars and gap_indices[k - 1] > chunk_start:
            # 前のギャップ境界で切る
            chunks.append(all_chars[chunk_start:gap_indices[k - 1]])
            chunk_start = gap_indices[k - 1]

    chunks.append(all_chars[chunk_start:])
    return chunks


def correct_chunked(all_chars: list[CharTS], model_name: str,
                    max_chars: int, overlap: int) -> str:
    """
    全文を max_chars ごとにチャンク分割し、前後オーバーラップ文脈付きで
    LLM補正を呼び、結果を結合して返す。
    """
    chunks = split_into_chunks(all_chars, GAP_THRESHOLD, max_chars)
    full_text = "".join(c.char for c in all_chars)
    print(f"   チャンク分割: {len(chunks)} チャンク")

    corrected_parts: list[str] = []
    offset = 0  # 各チャンクの全文中の開始位置

    for i, chunk in enumerate(chunks, 1):
        chunk_text = "".join(c.char for c in chunk)
        prev_ctx   = full_text[max(0, offset - overlap): offset]
        next_ctx   = full_text[offset + len(chunk_text):
                               offset + len(chunk_text) + overlap]

        print(f"   チャンク {i}/{len(chunks)}: {len(chunk_text)} 文字 "
              f"({fmt(chunk[0].start)}〜{fmt(chunk[-1].end)})")

        import google.generativeai as genai
        genai.configure(api_key=os.environ["GEMINI_API_KEY"])
        llm = genai.GenerativeModel(model_name)

        context_block = ""
        if prev_ctx:
            context_block += f"=== 直前の文脈（修正不要・参照のみ） ===\n{prev_ctx}\n\n"
        if next_ctx:
            context_block += f"=== 直後の文脈（修正不要・参照のみ） ===\n{next_ctx}\n\n"

        prompt = f"""あなたは日本語講義の字幕編集者です。
{context_block}
=== 対象テキスト（このテキストのみ整形して出力） ===
{chunk_text}

整形ルール：
1. 意味のひとまとまりごとに「。」で区切る（1文の目安：15〜30文字）
2. 読点「、」は文内の自然な間に追加する
3. 明らかな無意味フィラーのみ削除する（えー、あのー、えーと に限定）
   ※「まあ」「なんか」「ちょっと」等は話者の意図が含まれる場合があるので残す
4. 文脈から明らかな誤字・誤変換のみ修正する（同音異義語の間違い等）
5. 【最重要】内容の省略・要約・言い換えは一切禁止。話者が言った内容はすべて残す
6. 改行は入れない。対象テキストの整形結果のみ1行で出力する"""

        resp = llm.generate_content(
            prompt,
            generation_config={"max_output_tokens": 65536},
        )
        corrected_parts.append(resp.text.strip())
        offset += len(chunk_text)
        time.sleep(0.5)

    return "".join(corrected_parts)


# ---------------------------------------------------------------------------
# ② diff-based アライメント（全文単位）
# ---------------------------------------------------------------------------
def build_diff_ops(original_text: str, corrected_text: str) -> list[str]:
    """diffの各操作を人間可読な文字列リストで返す（ログ用）。"""
    matcher = difflib.SequenceMatcher(None, original_text, corrected_text,
                                      autojunk=False)
    ops = []
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        orig_snip = original_text[i1:i2]
        new_snip  = corrected_text[j1:j2]
        if tag == "equal":
            ops.append(f"  equal   [{i1}:{i2}] 「{orig_snip[:20]}」")
        elif tag == "delete":
            ops.append(f"  DELETE  [{i1}:{i2}] 「{orig_snip}」  ← フィラー削除")
        elif tag == "insert":
            ops.append(f"  INSERT  [{i1}]      「{new_snip}」  ← 句読点追加")
        elif tag == "replace":
            ops.append(f"  REPLACE [{i1}:{i2}] 「{orig_snip}」→「{new_snip}」")
    return ops


def align_timestamps(original_chars: list[CharTS],
                     corrected_text: str) -> list[CharTS]:
    """
    修正前テキスト（タイムスタンプあり）と修正後テキストをdiffで比較し、
    修正後テキストの各文字にタイムスタンプを割り当てる。

      equal   → 元のタイムスタンプをそのまま引き継ぐ
      delete  → フィラー削除。タイムスタンプを捨てる
      insert  → 句読点追加。直前文字の end を使う（duration=0）
      replace → 誤字修正。元文字のタイムスタンプを新文字に付け直す
    """
    original_text = "".join(c.char for c in original_chars)
    matcher = difflib.SequenceMatcher(None, original_text, corrected_text,
                                      autojunk=False)
    result: list[CharTS] = []
    last_end = original_chars[0].start if original_chars else 0.0

    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            for c in original_chars[i1:i2]:
                result.append(c)
                last_end = c.end

        elif tag == "delete":
            if original_chars[i1:i2]:
                last_end = original_chars[i2 - 1].end

        elif tag == "insert":
            for ch in corrected_text[j1:j2]:
                result.append(CharTS(char=ch, start=last_end,
                                     end=last_end, score=0.0))

        elif tag == "replace":
            orig_slice = original_chars[i1:i2]
            new_chars  = list(corrected_text[j1:j2])
            for k, ch in enumerate(new_chars):
                src = orig_slice[k] if k < len(orig_slice) else None
                ts  = src.start if src else last_end
                te  = src.end   if src else last_end
                result.append(CharTS(char=ch, start=ts, end=te,
                                     score=src.score if src else 0.0))
            if orig_slice:
                last_end = orig_slice[-1].end

    return result


# ---------------------------------------------------------------------------
# ③ ギャップ検出 + 句点分割
# ---------------------------------------------------------------------------
def split_sentences(aligned_chars: list[CharTS],
                    gap_threshold: float) -> list[Sentence]:
    """
    ギャップ（無音）または句点（。？！）でセンテンスを分割する。
    どちらが先に来ても分割が発生する。
    """
    sentences: list[Sentence] = []
    buf: list[CharTS] = []

    def flush(buf: list[CharTS]) -> Sentence:
        spoken = [x for x in buf if x.score > 0]
        start  = spoken[0].start if spoken else buf[0].start
        end    = spoken[-1].end  if spoken else buf[-1].end
        return Sentence(text="".join(x.char for x in buf), start=start, end=end)

    for c in aligned_chars:
        if c.char.strip() == "":
            buf.append(c)
            continue

        # ギャップ検出
        if buf:
            last_char = next((x for x in reversed(buf) if x.char.strip()), None)
            if last_char and (c.start - last_char.end) >= gap_threshold:
                if buf:
                    sentences.append(flush(buf))
                    buf = []

        buf.append(c)

        # 句点分割
        if c.char in ("。", "？", "！"):
            sentences.append(flush(buf))
            buf = []

    if buf:
        sentences.append(flush(buf))

    return sentences


# ---------------------------------------------------------------------------
# SRT 出力
# ---------------------------------------------------------------------------
def to_srt_time(sec: float) -> str:
    h  = int(sec // 3600)
    m  = int((sec % 3600) // 60)
    s  = int(sec % 60)
    ms = int((sec % 1) * 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def write_srt(sentences: list[Sentence], path: Path):
    lines = []
    for i, s in enumerate(sentences, 1):
        lines += [str(i),
                  f"{to_srt_time(s.start)} --> {to_srt_time(s.end)}",
                  s.text, ""]
    path.write_text("\n".join(lines), encoding="utf-8")
    print(f"  → SRT 出力: {path}")


# ---------------------------------------------------------------------------
# パイプラインログ出力
# ---------------------------------------------------------------------------
def fmt(sec: float) -> str:
    return f"{int(sec//60)}:{sec%60:05.2f}"


def write_pipeline_log(
    model_name:     str,
    raw_text:       str,
    corrected_text: str,
    diff_ops:       list[str],
    sentences:      list[Sentence],
    path:           Path,
):
    sep  = "=" * 70
    dash = "-" * 70
    lines = [
        sep,
        f"  PIPELINE LOG  |  {model_name}",
        f"  生成: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
        f"  入力: {TEST_SEGMENT_COUNT or '全'} セグメント  |  ギャップ閾値: {GAP_THRESHOLD}s",
        sep,
        "",
        f"① LLM補正",
        f"  入力文字数  : {len(raw_text)}",
        f"  出力文字数  : {len(corrected_text)}",
        "",
        "② diff操作サマリ（先頭100件）:",
    ]
    lines += diff_ops[:100]
    if len(diff_ops) > 100:
        lines.append(f"  ... 他 {len(diff_ops) - 100} 件")

    lines += [
        "",
        dash,
        f"③ センテンス分割: {len(sentences)} 件",
        dash,
    ]
    for i, s in enumerate(sentences, 1):
        lines.append(f"  [{i:3d}] {fmt(s.start)} --> {fmt(s.end)}  「{s.text}」")

    path.write_text("\n".join(lines), encoding="utf-8")
    print(f"  → ログ出力: {path}")


# ---------------------------------------------------------------------------
# 表示
# ---------------------------------------------------------------------------
def print_sentences(sentences: list[Sentence], label: str):
    print(f"\n{'='*60}\n  {label}\n{'='*60}")
    for i, s in enumerate(sentences, 1):
        print(f"[{i}] {fmt(s.start)} --> {fmt(s.end)}")
        print(f"    {s.text}")


# ---------------------------------------------------------------------------
# メイン
# ---------------------------------------------------------------------------
def main():
    if "GEMINI_API_KEY" not in os.environ:
        print("エラー: .env に GEMINI_API_KEY を設定してください")
        sys.exit(1)

    print("WhisperX JSON 読み込み中...")
    all_segments = load_segments(JSON_PATH)
    target_segs  = all_segments[:TEST_SEGMENT_COUNT] if TEST_SEGMENT_COUNT else all_segments
    print(f"対象セグメント: {len(target_segs)} / {len(all_segments)}")

    # 全文字を結合
    all_chars: list[CharTS] = []
    for seg in target_segs:
        all_chars.extend(extract_chars(seg))

    raw_text = "".join(c.char for c in all_chars)
    print(f"入力文字数: {len(raw_text)}")

    # ベースライン SRT（補正なし・ギャップ+句点分割のみ）
    print("\n--- ベースライン（補正なし）---")
    baseline_sents = split_sentences(all_chars, GAP_THRESHOLD)
    write_srt(baseline_sents, OUTPUT_DIR / "poc_baseline.srt")

    # モデルごとに処理
    for model_name in MODELS:
        print(f"\n\n{'#'*60}")
        print(f"  モデル: {model_name}")
        print(f"{'#'*60}")

        try:
            # ① LLM補正（全文一発 or チャンク分割を自動判定）
            t0 = time.time()
            if len(raw_text) <= MAX_OUTPUT_CHARS:
                print(f"① LLM全文一括補正中... ({len(raw_text)} 文字、上限 {MAX_OUTPUT_CHARS} 以内)")
                corrected = correct_full_text(raw_text, model_name)
            else:
                print(f"① LLM チャンク補正中... ({len(raw_text)} 文字 > 上限 {MAX_OUTPUT_CHARS})")
                corrected = correct_chunked(all_chars, model_name,
                                            MAX_OUTPUT_CHARS, CONTEXT_OVERLAP)
            elapsed = time.time() - t0
            print(f"   完了: {elapsed:.1f}秒  入力{len(raw_text)}字 → 出力{len(corrected)}字")

            # ② diff アライメント
            print("② diff アライメント中...")
            diff_ops     = build_diff_ops(raw_text, corrected)
            aligned_chars = align_timestamps(all_chars, corrected)
            print(f"   diff操作数: {len(diff_ops)}")

            # ③ ギャップ + 句点 分割
            print("③ センテンス分割中...")
            sentences = split_sentences(aligned_chars, GAP_THRESHOLD)
            print(f"   センテンス数: {len(sentences)}")

        except Exception as e:
            print(f"エラー: {e}")
            continue

        print_sentences(sentences, f"{model_name} の結果")
        safe = model_name.replace(".", "-").replace("/", "-")
        write_srt(sentences, OUTPUT_DIR / f"poc_{safe}.srt")
        write_pipeline_log(model_name, raw_text, corrected, diff_ops,
                           sentences, OUTPUT_DIR / f"poc_{safe}_pipeline.log")

    print("\nPoC 完了")


if __name__ == "__main__":
    main()
