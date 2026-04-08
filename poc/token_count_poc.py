"""
PoC: 翻訳API トークン数計測 & コスト見積もり

実際の講義SRTデータを使い、翻訳パイプラインの1講義あたりトークン数と
APIコストをシミュレーションする。

使用方法:
    .venv\\Scripts\\Activate.ps1
    pip install tiktoken  # 未インストールの場合
    python token_count_poc.py

出力: results/token_count_report_YYYYMMDD_HHMMSS.txt
"""

from __future__ import annotations

import io
import re
import sys
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import NamedTuple

import tiktoken

# Windows CP932環境でのUnicodeEncodeError回避
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

# ---------------------------------------------------------------------------
# 設定
# ---------------------------------------------------------------------------

DATA_DIR = Path("data/20260323_whisperx_ja_timestamp")
OUTPUT_DIR = Path("results")

# 計測対象SRTファイル
JA_SRT = DATA_DIR / "matsuo_agentic_rag.srt"
EN_SRT = DATA_DIR / "poc_gemini-3-flash-preview.srt"

# バッチサイズ（1リクエストに含めるブロック数）
BATCH_SIZES = [20, 50, 100]

# トークナイザー（GPT-5.4系と同世代の o200k_base を使用）
TOKENIZER_NAME = "o200k_base"

# ---------------------------------------------------------------------------
# 料金表（2026-04-01 Deep Research調査結果より）
# 単位: USD / 1Mトークン
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class ModelPricing:
    name: str
    input_price: float   # $/1M tokens
    output_price: float  # $/1M tokens
    batch_input: float   # $/1M tokens (Batch API)
    batch_output: float  # $/1M tokens (Batch API)
    context_window: int  # tokens
    note: str = ""


MODELS: list[ModelPricing] = [
    ModelPricing(
        name="gpt-5.4",
        input_price=3.00,
        output_price=7.50,
        batch_input=1.50,
        batch_output=3.75,
        context_window=1_050_000,
        note="OpenAI GA, 1050kコンテキスト, 最高品質",
    ),
    ModelPricing(
        name="gpt-5.4-mini",
        input_price=0.30,
        output_price=2.50,
        batch_input=0.15,
        batch_output=1.25,
        context_window=400_000,
        note="OpenAI GA, 400kコンテキスト",
    ),
    ModelPricing(
        name="gpt-5.4-nano",
        input_price=0.15,
        output_price=1.25,
        batch_input=0.075,
        batch_output=0.625,
        context_window=400_000,
        note="OpenAI GA, 400kコンテキスト, 最安",
    ),
    ModelPricing(
        name="gemini-2.5-pro",
        input_price=1.25,
        output_price=10.00,
        batch_input=0.625,
        batch_output=5.00,
        context_window=1_000_000,
        note="Google GA, 1Mコンテキスト, 最高品質",
    ),
    ModelPricing(
        name="gemini-2.5-flash",
        input_price=0.30,
        output_price=2.50,
        batch_input=0.15,
        batch_output=1.25,
        context_window=1_000_000,
        note="Google GA, 1Mコンテキスト",
    ),
    ModelPricing(
        name="gemini-2.5-flash-lite",
        input_price=0.10,
        output_price=0.40,
        batch_input=0.05,
        batch_output=0.20,
        context_window=1_000_000,
        note="Google GA, 最安, 品質要検証",
    ),
]

# 要約タスク想定の出力トークン数（目安）
SUMMARY_OUTPUT_TOKENS = 800  # 講義1本の要約: 約600-1000 words

# ---------------------------------------------------------------------------
# 翻訳システムプロンプト（poc_translation_test.py から引用）
# ---------------------------------------------------------------------------

SYSTEM_PROMPT = """Role

You are a subtitle translator: Japanese university lectures → concise English.

Your output goes to a subtitle formatter next. Write short, clean, splittable English.

A human editor will review and trim your output. Give them natural sentences that are easy to work with.

Inputs

Transcription (SRT) — Japanese ASR with timecodes

Term priority

Glossary > Slide PDF > Your judgment


Important context

These subtitles are for archived lecture videos.

The primary audience is students enrolled in the course (including international students who rely on English subtitles). External viewers also watch the archive.

This means: factual information about the course, community, and events is valuable even in archive. But live-only actions (pressing buttons, clicking chat links, sharing screens) are not.


Step 0: Proper noun list (output FIRST, before any translation)

Before translating, scan the entire input and output a proper noun reference list.

Format:

=== Proper Noun List ===
[Japanese] → [English] (category)
=== End of List ===

Step 1: Clean the Japanese

Delete fillers: えー, あの, その, まあ, ですね, なんか, etc.
Delete false starts, self-corrections, redundant restatements.
Fix ASR errors using slide context.

Step 2: Translate to concise English

Core principle: Subtitle English must be SHORT.
Each subtitle block is displayed alone on screen.
Write every block so it stands on its own.
Short sentences. Prefer two short sentences over one long one.
SVO order. Subject first.

Output format

Return ONLY the translated SRT blocks. No commentary."""


# ---------------------------------------------------------------------------
# SRTパーサー
# ---------------------------------------------------------------------------

class SrtBlock(NamedTuple):
    index: int
    timecode: str
    text: str


def parse_srt(path: Path) -> list[SrtBlock]:
    """SRTファイルをパースしてブロックリストを返す。"""
    content = path.read_text(encoding="utf-8", errors="replace")
    raw_blocks = re.split(r"\n\s*\n", content.strip())
    blocks: list[SrtBlock] = []
    for raw in raw_blocks:
        lines = raw.strip().splitlines()
        if len(lines) < 3:
            continue
        try:
            idx = int(lines[0].strip())
        except ValueError:
            continue
        timecode = lines[1].strip()
        text = "\n".join(lines[2:]).strip()
        if text:
            blocks.append(SrtBlock(index=idx, timecode=timecode, text=text))
    return blocks


# ---------------------------------------------------------------------------
# トークン計測
# ---------------------------------------------------------------------------

def count_tokens(text: str, enc: tiktoken.Encoding) -> int:
    return len(enc.encode(text))


def build_user_message(blocks: list[SrtBlock]) -> str:
    """1バッチ分のユーザーメッセージを組み立てる。"""
    parts = [f"Translate the following {len(blocks)} subtitle blocks:\n"]
    for b in blocks:
        parts.append(f"[{b.index}]\n{b.timecode}\n{b.text}\n")
    return "\n".join(parts)


@dataclass(frozen=True)
class BatchTokens:
    batch_size: int
    num_requests: int
    system_tokens_total: int
    user_tokens_total: int
    output_tokens_total: int

    @property
    def input_tokens_total(self) -> int:
        return self.system_tokens_total + self.user_tokens_total


@dataclass(frozen=True)
class SrtStats:
    path: Path
    block_count: int
    total_chars: int
    total_tokens: int  # テキスト部分のみ
    avg_chars_per_block: float
    avg_tokens_per_block: float


def measure_srt(path: Path, enc: tiktoken.Encoding) -> SrtStats:
    blocks = parse_srt(path)
    texts = [b.text for b in blocks]
    total_chars = sum(len(t) for t in texts)
    total_tokens = sum(count_tokens(t, enc) for t in texts)
    n = len(blocks)
    return SrtStats(
        path=path,
        block_count=n,
        total_chars=total_chars,
        total_tokens=total_tokens,
        avg_chars_per_block=total_chars / n if n else 0,
        avg_tokens_per_block=total_tokens / n if n else 0,
    )


def simulate_batches(
    ja_blocks: list[SrtBlock],
    en_blocks: list[SrtBlock],
    batch_size: int,
    enc: tiktoken.Encoding,
) -> BatchTokens:
    """指定バッチサイズでリクエストを分割し、総トークン数を計算する。"""
    system_tokens = count_tokens(SYSTEM_PROMPT, enc)

    # バッチに分割
    batches = [ja_blocks[i : i + batch_size] for i in range(0, len(ja_blocks), batch_size)]
    num_requests = len(batches)

    # input: システムプロンプト × リクエスト数 + ユーザーメッセージ（日本語SRT）
    system_tokens_total = system_tokens * num_requests
    user_tokens_total = sum(count_tokens(build_user_message(batch), enc) for batch in batches)

    # output: 英語翻訳テキスト（実測値があれば使用、なければ推定）
    if en_blocks:
        output_tokens_total = sum(count_tokens(b.text, enc) for b in en_blocks)
    else:
        # 推定: 日本語の1.3倍（英語は語数が多い傾向）
        ja_text_tokens = sum(count_tokens(b.text, enc) for b in ja_blocks)
        output_tokens_total = int(ja_text_tokens * 1.3)

    return BatchTokens(
        batch_size=batch_size,
        num_requests=num_requests,
        system_tokens_total=system_tokens_total,
        user_tokens_total=user_tokens_total,
        output_tokens_total=output_tokens_total,
    )


# ---------------------------------------------------------------------------
# コスト計算
# ---------------------------------------------------------------------------

def calc_cost(tokens: BatchTokens, model: ModelPricing) -> tuple[float, float]:
    """(通常コスト, Batch APIコスト) を返す (USD)。"""
    M = 1_000_000
    normal = (
        tokens.input_tokens_total / M * model.input_price
        + tokens.output_tokens_total / M * model.output_price
    )
    batch = (
        tokens.input_tokens_total / M * model.batch_input
        + tokens.output_tokens_total / M * model.batch_output
    )
    return normal, batch


@dataclass(frozen=True)
class SingleRequestTokens:
    """全文を1リクエストで送る場合のトークン数。"""
    system_tokens: int
    user_tokens: int      # 全ブロック（タイムコード含む）
    output_tokens: int    # 翻訳 or 要約

    @property
    def input_total(self) -> int:
        return self.system_tokens + self.user_tokens

    @property
    def grand_total(self) -> int:
        return self.input_total + self.output_tokens


def calc_single_request(
    ja_blocks: list[SrtBlock],
    en_blocks: list[SrtBlock],
    enc: tiktoken.Encoding,
    summary_output_tokens: int,
) -> tuple[SingleRequestTokens, SingleRequestTokens]:
    """
    (翻訳1リクエスト, 要約1リクエスト) を返す。
    翻訳: SYSTEM_PROMPT + 全ブロック → EN全文 (実測or推定)
    要約: 軽量プロンプト + 全ブロック → 要約テキスト
    """
    SUMMARY_PROMPT = (
        "You are an expert summarizer. "
        "Summarize the following Japanese lecture transcript in English. "
        "Output a structured summary with key topics, main points, and conclusions. "
        "Target length: 600-800 words."
    )
    # stdout がCP932の場合に備え、print は main() 側で encode 処理する
    system_tokens_trans = count_tokens(SYSTEM_PROMPT, enc)
    system_tokens_summ = count_tokens(SUMMARY_PROMPT, enc)
    user_tokens = count_tokens(build_user_message(ja_blocks), enc)

    if en_blocks:
        output_trans = sum(count_tokens(b.text, enc) for b in en_blocks)
    else:
        output_trans = int(sum(count_tokens(b.text, enc) for b in ja_blocks) * 1.3)

    translation = SingleRequestTokens(
        system_tokens=system_tokens_trans,
        user_tokens=user_tokens,
        output_tokens=output_trans,
    )
    summary = SingleRequestTokens(
        system_tokens=system_tokens_summ,
        user_tokens=user_tokens,
        output_tokens=summary_output_tokens,
    )
    return translation, summary


# ---------------------------------------------------------------------------
# レポート生成
# ---------------------------------------------------------------------------

def generate_report(
    ja_stats: SrtStats,
    en_stats: SrtStats | None,
    enc: tiktoken.Encoding,
) -> str:
    ja_blocks = parse_srt(ja_stats.path)
    en_blocks = parse_srt(en_stats.path) if en_stats else []

    system_tokens = count_tokens(SYSTEM_PROMPT, enc)
    lines: list[str] = []

    def h(title: str) -> None:
        lines.append(f"\n{'=' * 60}")
        lines.append(f"  {title}")
        lines.append("=" * 60)

    def row(label: str, value: object) -> None:
        lines.append(f"  {label:<40} {value}")

    lines.append(f"トークン数計測レポート  生成: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    lines.append(f"トークナイザー: {TOKENIZER_NAME}")

    # --- SRTファイル統計 ---
    h("1. SRTファイル統計")
    row("日本語SRTファイル", ja_stats.path.name)
    row("  ブロック数", f"{ja_stats.block_count:,}")
    row("  総文字数", f"{ja_stats.total_chars:,} chars")
    row("  総トークン数（テキストのみ）", f"{ja_stats.total_tokens:,} tokens")
    row("  平均 chars/ブロック", f"{ja_stats.avg_chars_per_block:.1f}")
    row("  平均 tokens/ブロック", f"{ja_stats.avg_tokens_per_block:.1f}")

    if en_stats:
        lines.append("")
        row("英語SRTファイル（翻訳済み）", en_stats.path.name)
        row("  ブロック数", f"{en_stats.block_count:,}")
        row("  総トークン数（テキストのみ）", f"{en_stats.total_tokens:,} tokens")
        row("  平均 tokens/ブロック", f"{en_stats.avg_tokens_per_block:.1f}")
        ratio = en_stats.total_tokens / ja_stats.total_tokens if ja_stats.total_tokens else 0
        row("  EN/JA トークン比", f"{ratio:.2f}x")

    # --- プロンプト構造 ---
    h("2. プロンプト構造（固定オーバーヘッド）")
    row("システムプロンプト（/リクエスト）", f"{system_tokens:,} tokens")
    lines.append("")
    lines.append("  ※ バッチサイズが大きいほどシステムプロンプトのオーバーヘッド比率が下がる")

    # --- バッチサイズ別シミュレーション ---
    h("3. バッチサイズ別トークン数シミュレーション")
    header = f"  {'バッチサイズ':>10}  {'リクエスト数':>10}  {'input合計':>14}  {'output合計':>12}  {'総計':>12}"
    lines.append(header)
    lines.append("  " + "-" * 66)

    batch_results: list[BatchTokens] = []
    for bs in BATCH_SIZES:
        bt = simulate_batches(ja_blocks, en_blocks, bs, enc)
        batch_results.append(bt)
        total = bt.input_tokens_total + bt.output_tokens_total
        lines.append(
            f"  {bs:>10}  {bt.num_requests:>10}  "
            f"{bt.input_tokens_total:>14,}  {bt.output_tokens_total:>12,}  {total:>12,}"
        )

    # --- コスト見積もり ---
    h("4. コスト見積もり（1講義あたり USD）")
    lines.append(f"  ※ バッチサイズ={BATCH_SIZES[1]}ブロック で計算")
    bt_ref = batch_results[1]  # BATCH_SIZES[1] = 50

    header2 = f"  {'モデル':<28}  {'通常API':>10}  {'Batch API':>10}  {'備考'}"
    lines.append(header2)
    lines.append("  " + "-" * 70)

    for model in MODELS:
        normal, batch = calc_cost(bt_ref, model)
        lines.append(
            f"  {model.name:<28}  ${normal:>9.4f}  ${batch:>9.4f}  {model.note}"
        )

    # --- バッチサイズ × モデルのクロス表 ---
    h("5. バッチサイズ × モデル コスト比較（通常API, USD）")
    model_names = [m.name for m in MODELS]
    col_w = 14
    header3 = f"  {'バッチサイズ':>10}" + "".join(f"  {n:>{col_w}}" for n in model_names)
    lines.append(header3)
    lines.append("  " + "-" * (12 + (col_w + 2) * len(MODELS)))
    for bt in batch_results:
        row_parts = [f"  {bt.batch_size:>10}"]
        for model in MODELS:
            normal, _ = calc_cost(bt, model)
            row_parts.append(f"  ${normal:>{col_w - 1}.4f}")
        lines.append("".join(row_parts))

    # --- 月次スケール見積もり ---
    h("6. スケール見積もり（月次）")
    lines.append("  前提: gpt-5.4-mini 通常API, バッチサイズ=50")
    model_ref = MODELS[0]  # gpt-5.4-mini
    cost_per_lecture, _ = calc_cost(bt_ref, model_ref)
    for n in [10, 50, 100, 200]:
        lines.append(f"    {n:>4} 講義/月 → ${cost_per_lecture * n:.3f} / 月")

    # --- 全文1リクエスト: コンテキスト窓に入るか ---
    h("7. 全文1リクエスト — コンテキスト窓チェック")
    trans_single, summ_single = calc_single_request(
        ja_blocks, en_blocks, enc, SUMMARY_OUTPUT_TOKENS
    )

    lines.append("  【翻訳】全ブロックを1リクエストで送る場合")
    lines.append(f"    システムプロンプト : {trans_single.system_tokens:>8,} tokens")
    lines.append(f"    ユーザーメッセージ : {trans_single.user_tokens:>8,} tokens  (全{len(ja_blocks)}ブロック + タイムコード)")
    lines.append(f"    input 合計        : {trans_single.input_total:>8,} tokens")
    lines.append(f"    output (EN全文)   : {trans_single.output_tokens:>8,} tokens")
    lines.append(f"    grand total       : {trans_single.grand_total:>8,} tokens")
    lines.append("")
    lines.append("  【要約】全ブロックを1リクエストで送る場合")
    lines.append(f"    システムプロンプト : {summ_single.system_tokens:>8,} tokens")
    lines.append(f"    ユーザーメッセージ : {summ_single.user_tokens:>8,} tokens")
    lines.append(f"    input 合計        : {summ_single.input_total:>8,} tokens")
    lines.append(f"    output (要約)     : {summ_single.output_tokens:>8,} tokens  (目安 ~600-800 words)")
    lines.append(f"    grand total       : {summ_single.grand_total:>8,} tokens")

    lines.append("")
    lines.append("  コンテキスト窓使用率:")
    header4 = f"  {'モデル':<28}  {'窓サイズ':>12}  {'翻訳(入力)':>12}  {'翻訳使用率':>10}  {'要約(入力)':>12}  {'要約使用率':>10}  {'入る？'}"
    lines.append(header4)
    lines.append("  " + "-" * 100)
    for model in MODELS:
        ctx = model.context_window
        trans_pct = trans_single.input_total / ctx * 100
        summ_pct = summ_single.input_total / ctx * 100
        trans_ok = "OK" if trans_single.grand_total <= ctx else "NG (超過)"
        summ_ok = "OK" if summ_single.grand_total <= ctx else "NG (超過)"
        ok_str = f"翻訳:{trans_ok} / 要約:{summ_ok}"
        lines.append(
            f"  {model.name:<28}  {ctx:>12,}  {trans_single.input_total:>12,}  "
            f"{trans_pct:>9.1f}%  {summ_single.input_total:>12,}  {summ_pct:>9.1f}%  {ok_str}"
        )

    lines.append("")
    lines.append("  全文1リクエストのコスト（通常API）:")
    header5 = f"  {'モデル':<28}  {'翻訳コスト':>12}  {'要約コスト':>12}"
    lines.append(header5)
    lines.append("  " + "-" * 58)
    M = 1_000_000
    for model in MODELS:
        trans_cost = (
            trans_single.input_total / M * model.input_price
            + trans_single.output_tokens / M * model.output_price
        )
        summ_cost = (
            summ_single.input_total / M * model.input_price
            + summ_single.output_tokens / M * model.output_price
        )
        lines.append(
            f"  {model.name:<28}  ${trans_cost:>11.4f}  ${summ_cost:>11.4f}"
        )

    lines.append("\n" + "=" * 60)
    lines.append("  ※ output推定は英語SRTが存在する場合は実測値を使用。")
    lines.append("  ※ タイムコード行・ブロック番号のトークンも input に含む。")
    lines.append("  ※ Batch APIは非同期処理（24h以内）で約50%割引。")
    lines.append("=" * 60)

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# エントリポイント
# ---------------------------------------------------------------------------

def main() -> None:
    enc = tiktoken.get_encoding(TOKENIZER_NAME)

    print(f"SRTファイルを解析中...")
    ja_stats = measure_srt(JA_SRT, enc)

    en_stats = None
    if EN_SRT.exists():
        en_stats = measure_srt(EN_SRT, enc)
    else:
        print(f"  英語SRTが見つかりません（outputは推定値を使用）: {EN_SRT}")

    print(f"  日本語: {ja_stats.block_count} blocks, {ja_stats.total_tokens:,} tokens")
    if en_stats:
        print(f"  英語:   {en_stats.block_count} blocks, {en_stats.total_tokens:,} tokens")

    report = generate_report(ja_stats, en_stats, enc)
    print(report)

    OUTPUT_DIR.mkdir(exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    out_path = OUTPUT_DIR / f"token_count_report_{ts}.txt"
    out_path.write_text(report, encoding="utf-8")
    print(f"\nレポート保存: {out_path}")


if __name__ == "__main__":
    main()
