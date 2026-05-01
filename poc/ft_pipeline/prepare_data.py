"""
FT用データ整形スクリプト。
第2回・第4回の担当者英訳とJP入力をペアリングしてJSONL出力する。

使い方:
    python prepare_data.py

出力:
    output/train.jsonl
    output/val.jsonl
"""

import json
import random
import re
import sys
from dataclasses import dataclass
from pathlib import Path

import tiktoken

# ── 設定 ──────────────────────────────────────────────

PROJ_ROOT = Path(__file__).parent.parent.parent
DATA_ROOT = PROJ_ROOT / "00_context" / "files"

DAY2_JP = DATA_ROOT / "drive-download-20260327T103446Z-3-001" / "4_DL基礎_day2_JP文字起こし.txt"
DAY2_EN = DATA_ROOT / "drive-download-20260327T103446Z-3-001" / "6_DL基礎_day2_EN_修正済み.docx"

DAY4_JP = DATA_ROOT / "drive-download-20260425T022314Z-3-002" / "04_DL基礎_day4_JP確認_英語仮訳.txt"
DAY4_EN = DATA_ROOT / "drive-download-20260425T022314Z-3-002" / "05_DL基礎_day4_英訳完了（中村さん出力）.txt"

SYSTEM_PROMPT = (Path(__file__).parent / "system_prompt_short.txt").read_text(encoding="utf-8")

CONTEXT_WINDOW = 2   # 前後何ブロックをコンテキストとして含めるか
VAL_RATIO = 0.1
RANDOM_SEED = 42

# gpt-4o-mini の学習コスト ($/1M tokens)
COST_PER_1M = 0.80
N_EPOCHS = 3

# ── データ型 ────────────────────────────────────────────

@dataclass
class Block:
    index: int
    start_ms: int
    end_ms: int
    text: str          # JP または EN テキスト

@dataclass
class Pair:
    jp: Block
    en: Block          # en.text が正解出力

# ── パーサー ───────────────────────────────────────────

def _tc_to_ms(tc: str) -> int:
    """'HH:MM:SS,mmm' → ミリ秒"""
    h, m, rest = tc.split(":")
    s, ms = rest.split(",")
    return int(h) * 3_600_000 + int(m) * 60_000 + int(s) * 1_000 + int(ms)

def parse_srt(path: Path) -> list[Block]:
    """単言語SRTをパース。日本語・英語どちらでも可。"""
    text = path.read_text(encoding="utf-8-sig")
    blocks: list[Block] = []
    # ブロックは空行で区切られる
    raw = [b.strip() for b in re.split(r"\n\s*\n", text) if b.strip()]
    for chunk in raw:
        lines = chunk.splitlines()
        if len(lines) < 3:
            continue
        if not re.match(r"^\d+$", lines[0].strip()):
            continue
        tc_match = re.match(r"(.+?) --> (.+)", lines[1].strip())
        if not tc_match:
            continue
        try:
            idx = int(lines[0].strip())
            start = _tc_to_ms(tc_match.group(1).strip())
            end = _tc_to_ms(tc_match.group(2).strip())
        except ValueError:
            continue
        body = " ".join(l.strip() for l in lines[2:] if l.strip())
        blocks.append(Block(idx, start, end, body))
    return blocks

def parse_bilingual_srt_jp_only(path: Path) -> list[Block]:
    """
    バイリンガルSRT（04形式）から JP テキストのみ抽出する。
    各ブロックのテキスト行: 1行目が日本語、2行目が英語（またはその逆）。
    日本語行は unicodeで u3000-u9fff 範囲の文字を含む行で判定。
    """
    raw_blocks = parse_srt(path)
    result: list[Block] = []
    ja_pattern = re.compile(r"[　-鿿゠-ヿ]")
    for b in raw_blocks:
        # textが複数文あっても、日本語文字を含む部分のみ残す
        # ここでは parse_srt が全行を結合済みなので、文単位で分割して日本語だけ集める
        # ただし 04 のフォーマットはブロック内が「JP行\nEN行」なので、
        # parse_srt がすでに結合してしまっている → 元ファイルを再パースする
        pass

    # 元ファイルを再パースして行ごとに判定
    text = path.read_text(encoding="utf-8-sig")
    raw_chunks = [b.strip() for b in re.split(r"\n\s*\n", text) if b.strip()]
    for chunk in raw_chunks:
        lines = chunk.splitlines()
        if len(lines) < 3:
            continue
        if not re.match(r"^\d+$", lines[0].strip()):
            continue
        tc_match = re.match(r"(.+?) --> (.+)", lines[1].strip())
        if not tc_match:
            continue
        try:
            idx = int(lines[0].strip())
            start = _tc_to_ms(tc_match.group(1).strip())
            end = _tc_to_ms(tc_match.group(2).strip())
        except ValueError:
            continue
        # テキスト行を日本語行のみ抽出
        jp_lines = [l.strip() for l in lines[2:] if l.strip() and ja_pattern.search(l)]
        if not jp_lines:
            # 日本語行がなければ全テキストをそのまま（フォールバック）
            jp_lines = [l.strip() for l in lines[2:] if l.strip()]
        body = " ".join(jp_lines)
        result.append(Block(idx, start, end, body))
    return result

def parse_docx_as_srt(path: Path) -> list[Block]:
    """docxをSRT構造として解釈してパース。"""
    from docx import Document
    doc = Document(str(path))
    paras = [p.text.strip() for p in doc.paragraphs if p.text.strip()]

    blocks: list[Block] = []
    i = 0
    while i < len(paras):
        if re.match(r"^\d+$", paras[i]):
            idx = int(paras[i])
            i += 1
            if i >= len(paras):
                break
            tc_match = re.match(r"(.+?) --> (.+)", paras[i])
            if not tc_match:
                continue
            try:
                start = _tc_to_ms(tc_match.group(1).strip())
                end = _tc_to_ms(tc_match.group(2).strip())
            except ValueError:
                i += 1
                continue
            i += 1
            text_lines = []
            while i < len(paras) and not re.match(r"^\d+$", paras[i]):
                # 次のタイムコード行が来たら終了
                if re.match(r"\d{2}:\d{2}:\d{2}", paras[i]):
                    break
                text_lines.append(paras[i])
                i += 1
            blocks.append(Block(idx, start, end, " ".join(text_lines)))
        else:
            i += 1
    return blocks

# ── ペアリング ──────────────────────────────────────────

def pair_by_index(jp_blocks: list[Block], en_blocks: list[Block]) -> list[Pair]:
    """第2回: ブロック数が一致するのでインデックスで直接ペア。"""
    n = min(len(jp_blocks), len(en_blocks))
    pairs = []
    for i in range(n):
        jp = jp_blocks[i]
        en = en_blocks[i]
        # ENブロックのタイムコードをJPに合わせる（スタイル一貫性）
        en_aligned = Block(jp.index, jp.start_ms, jp.end_ms, en.text)
        pairs.append(Pair(jp, en_aligned))
    return pairs

def _overlap_ms(a_start: int, a_end: int, b_start: int, b_end: int) -> int:
    return max(0, min(a_end, b_end) - max(a_start, b_start))

def pair_by_timecode_overlap(jp_blocks: list[Block], en_blocks: list[Block]) -> list[Pair]:
    """
    第4回: JPブロック(04)のタイムコード範囲に重なるENブロック(05)を収集して結合する。
    JP 1ブロック → EN N ブロック（結合）のペアを作る。
    """
    pairs: list[Pair] = []
    for jp in jp_blocks:
        duration = jp.end_ms - jp.start_ms
        matched_en: list[Block] = []
        for en in en_blocks:
            overlap = _overlap_ms(jp.start_ms, jp.end_ms, en.start_ms, en.end_ms)
            if duration > 0 and overlap / duration >= 0.3:
                matched_en.append(en)

        if not matched_en:
            # フォールバック: 最近傍ENブロックを1つ使用
            nearest = min(en_blocks, key=lambda e: abs(e.start_ms - jp.start_ms))
            matched_en = [nearest]

        combined_text = " ".join(e.text for e in matched_en)
        combined_tc = f"{matched_en[0].index}"
        en_block = Block(
            index=matched_en[0].index,
            start_ms=jp.start_ms,
            end_ms=jp.end_ms,
            text=combined_text,
        )
        pairs.append(Pair(jp, en_block))
    return pairs

# ── JSONL生成 ───────────────────────────────────────────

def _ms_to_tc(ms: int) -> str:
    h = ms // 3_600_000
    ms %= 3_600_000
    m = ms // 60_000
    ms %= 60_000
    s = ms // 1_000
    ms %= 1_000
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"

def build_user_message(pairs: list[Pair], target_idx: int) -> str:
    """前後 CONTEXT_WINDOW ブロックをコンテキストとして含むuserメッセージを構築。"""
    lines: list[str] = []

    # 前コンテキスト
    for i in range(max(0, target_idx - CONTEXT_WINDOW), target_idx):
        p = pairs[i]
        lines.append(f"[{_ms_to_tc(p.jp.start_ms)} --> {_ms_to_tc(p.jp.end_ms)}]")
        lines.append(p.jp.text)
        lines.append("")

    # ターゲット
    p = pairs[target_idx]
    lines.append(">>> TARGET >>>")
    lines.append(f"{_ms_to_tc(p.jp.start_ms)} --> {_ms_to_tc(p.jp.end_ms)}")
    lines.append(p.jp.text)
    lines.append("<<< END TARGET <<<")

    # 後コンテキスト
    for i in range(target_idx + 1, min(len(pairs), target_idx + CONTEXT_WINDOW + 1)):
        p = pairs[i]
        lines.append("")
        lines.append(f"[{_ms_to_tc(p.jp.start_ms)} --> {_ms_to_tc(p.jp.end_ms)}]")
        lines.append(p.jp.text)

    return "\n".join(lines)

def build_assistant_message(pair: Pair) -> str:
    tc = f"{_ms_to_tc(pair.en.start_ms)} --> {_ms_to_tc(pair.en.end_ms)}"
    return f"{pair.en.index}\n{tc}\n{pair.en.text}"

def pairs_to_jsonl_entries(pairs: list[Pair]) -> list[dict]:
    entries = []
    for i, pair in enumerate(pairs):
        user = build_user_message(pairs, i)
        assistant = build_assistant_message(pair)
        entries.append({
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user},
                {"role": "assistant", "content": assistant},
            ]
        })
    return entries

# ── コスト見積もり ──────────────────────────────────────

def estimate_cost(entries: list[dict], n_epochs: int = N_EPOCHS) -> int:
    enc = tiktoken.get_encoding("cl100k_base")
    total_tokens = 0
    for entry in entries:
        for msg in entry["messages"]:
            total_tokens += len(enc.encode(msg["content"]))
    cost = total_tokens * n_epochs * COST_PER_1M / 1_000_000
    print(f"\n=== コスト見積もり ===")
    print(f"エントリ数    : {len(entries):,}")
    print(f"総トークン数  : {total_tokens:,}")
    print(f"エポック数    : {n_epochs}")
    print(f"学習総トークン: {total_tokens * n_epochs:,}")
    print(f"推定コスト    : ${cost:.2f} (gpt-4o-mini @ ${COST_PER_1M}/1M tokens)")
    return total_tokens

# ── メイン ─────────────────────────────────────────────

def main() -> None:
    all_pairs: list[Pair] = []

    print("=== 第2回データ読み込み ===")
    jp2 = parse_srt(DAY2_JP)
    en2 = parse_docx_as_srt(DAY2_EN)
    print(f"  JP: {len(jp2)} blocks, EN: {len(en2)} blocks")
    pairs2 = pair_by_index(jp2, en2)
    print(f"  ペア数: {len(pairs2)}")
    all_pairs.extend(pairs2)

    print("\n=== 第4回データ読み込み ===")
    jp4 = parse_bilingual_srt_jp_only(DAY4_JP)
    en4 = parse_srt(DAY4_EN)
    print(f"  JP: {len(jp4)} blocks, EN: {len(en4)} blocks")
    pairs4 = pair_by_timecode_overlap(jp4, en4)
    print(f"  ペア数: {len(pairs4)}")
    all_pairs.extend(pairs4)

    print(f"\n合計ペア数: {len(all_pairs)}")

    entries = pairs_to_jsonl_entries(all_pairs)

    total_tokens = estimate_cost(entries)

    print("\n続行しますか？ [y/N]: ", end="", flush=True)
    ans = input().strip().lower()
    if ans != "y":
        print("中断しました。")
        sys.exit(0)

    random.seed(RANDOM_SEED)
    random.shuffle(entries)
    split = int(len(entries) * (1 - VAL_RATIO))
    train, val = entries[:split], entries[split:]

    out_dir = Path(__file__).parent / "output"
    out_dir.mkdir(exist_ok=True)

    train_path = out_dir / "train.jsonl"
    val_path = out_dir / "val.jsonl"

    train_path.write_text("\n".join(json.dumps(e, ensure_ascii=False) for e in train), encoding="utf-8")
    val_path.write_text("\n".join(json.dumps(e, ensure_ascii=False) for e in val), encoding="utf-8")

    print(f"\n出力完了:")
    print(f"  train: {train_path} ({len(train)} entries)")
    print(f"  val  : {val_path} ({len(val)} entries)")


if __name__ == "__main__":
    main()
