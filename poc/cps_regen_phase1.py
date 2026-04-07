"""
CPS自動化 PoC Phase 1 — 単一ブロック・ツールループ検証

目的:
  LLMに validate_cps ツールを渡し、自己検証ループで15CPS制約をクリアさせる。
  A案（単純リトライ）と B案（計画→実行）を比較し、どちらが有効かを測定する。

使用方法:
  .venv\Scripts\Activate.ps1
  python cps_regen_phase1.py [--input path/to/file.srt] [--blocks 10] [--model gpt-5.4-mini]

出力: results/cps_phase1_YYYYMMDD_HHMMSS.json および .txt
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import re
import time
from dataclasses import dataclass, field, asdict
from datetime import datetime
from pathlib import Path

from dotenv import load_dotenv
from openai import OpenAI

load_dotenv()

OUTPUT_DIR = Path("results")
OUTPUT_DIR.mkdir(exist_ok=True)
_log_file = OUTPUT_DIR / f"cps_phase1_{datetime.now().strftime('%Y%m%d_%H%M%S')}.log"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler(_log_file, encoding="utf-8"),
    ],
)
log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# 設定
# ---------------------------------------------------------------------------
DEFAULT_MODEL              = "gpt-5.4-mini"
MAX_CHARS                  = 40      # 1行の最大文字数
MAX_CPS                    = 15.0   # Characters Per Second 上限
MAX_RETRIES                = 5      # 1ブロックあたりの最大試行回数

# gpt-5.4-mini 料金（$/1Mトークン）
DEFAULT_PRICE_INPUT        = 0.750
DEFAULT_PRICE_CACHED_INPUT = 0.075
DEFAULT_PRICE_OUTPUT       = 4.500

# ---------------------------------------------------------------------------
# データ構造
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class SrtBlock:
    index: int
    start_sec: float
    end_sec: float
    timecode: str
    japanese: str
    english: str  # 元の人間訳（比較用）

    @property
    def duration(self) -> float:
        return self.end_sec - self.start_sec


@dataclass
class CPSResult:
    text: str
    char_count: int
    max_chars_for_duration: int
    cps: float
    passed: bool
    overflow: int  # 超過文字数（0以下なら合格）


@dataclass
class TokenUsage:
    prompt_tokens: int = 0
    cached_tokens: int = 0   # prompt_tokens のうちキャッシュヒット分
    completion_tokens: int = 0

    @property
    def total_tokens(self) -> int:
        return self.prompt_tokens + self.completion_tokens

    def cost_usd(
        self,
        price_input_per_1m: float,
        price_output_per_1m: float,
        price_cached_per_1m: float = 0.0,
    ) -> float:
        non_cached = self.prompt_tokens - self.cached_tokens
        return (
            non_cached / 1_000_000 * price_input_per_1m
            + self.cached_tokens / 1_000_000 * price_cached_per_1m
            + self.completion_tokens / 1_000_000 * price_output_per_1m
        )

    def __iadd__(self, other: "TokenUsage") -> "TokenUsage":
        self.prompt_tokens += other.prompt_tokens
        self.cached_tokens += other.cached_tokens
        self.completion_tokens += other.completion_tokens
        return self


@dataclass
class TrialRecord:
    attempt: int
    llm_reasoning: str | None   # tool呼び出し前のLLMテキスト（B案の計画文など）
    generated_text: str
    cps_result: CPSResult
    passed: bool


@dataclass
class BlockResult:
    block_index: int
    timecode: str
    japanese: str
    original_english: str
    method: str           # "A" or "B"
    final_text: str
    passed: bool
    attempts: int
    token_usage: TokenUsage = field(default_factory=TokenUsage)
    trials: list[TrialRecord] = field(default_factory=list)


# ---------------------------------------------------------------------------
# タイムコード処理
# ---------------------------------------------------------------------------
def _tc_to_sec(tc: str) -> float:
    """HH:MM:SS,mmm → 秒（float）"""
    hms, ms = tc.split(",")
    h, m, s = hms.split(":")
    return int(h) * 3600 + int(m) * 60 + int(s) + int(ms) / 1000


# ---------------------------------------------------------------------------
# SRTパース
# ---------------------------------------------------------------------------
def parse_bilingual_srt(path: Path, max_blocks: int | None = None) -> list[SrtBlock]:
    """日英2行SRTをパース"""
    text = path.read_text(encoding="utf-8")
    raw_blocks = re.split(r"\n\n+", text.strip())
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
        start_tc, end_tc = timecode.split(" --> ")
        content = lines[2:]

        jp_lines = [l for l in content if re.search(r"[\u3040-\u9fff]", l)]
        en_lines = [l for l in content if not re.search(r"[\u3040-\u9fff]", l)]

        blocks.append(SrtBlock(
            index=idx,
            start_sec=_tc_to_sec(start_tc),
            end_sec=_tc_to_sec(end_tc),
            timecode=timecode,
            japanese=" ".join(jp_lines),
            english=" ".join(en_lines),
        ))
        if max_blocks and len(blocks) >= max_blocks:
            break

    return blocks


def get_violations(blocks: list[SrtBlock]) -> list[SrtBlock]:
    """CPS違反ブロックのみ抽出"""
    violations = []
    for b in blocks:
        if b.duration <= 0:
            continue
        cps = len(b.english) / b.duration
        if cps > MAX_CPS:
            violations.append(b)
    return violations


# ---------------------------------------------------------------------------
# CPS検証ツール（LLMに渡すツール）
# ---------------------------------------------------------------------------
VALIDATE_CPS_SCHEMA = {
    "type": "function",
    "function": {
        "name": "validate_cps",
        "description": (
            "Checks whether the given subtitle text satisfies the CPS (Characters Per Second) "
            "constraint for its display duration. "
            "Call this after every rewrite to verify before submitting the final answer."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "text": {
                    "type": "string",
                    "description": "The English subtitle text to validate (single block, single line)."
                }
            },
            "required": ["text"],
        },
    },
}


def validate_cps(text: str, duration: float) -> CPSResult:
    """Pythonで正確に文字数・CPS計算（LLMに依存しない）"""
    char_count = len(text)
    max_chars = int(MAX_CPS * duration)
    cps = char_count / duration if duration > 0 else float("inf")
    passed = char_count <= max_chars
    return CPSResult(
        text=text,
        char_count=char_count,
        max_chars_for_duration=max_chars,
        cps=round(cps, 2),
        passed=passed,
        overflow=char_count - max_chars,
    )


def _tool_result_text(result: CPSResult) -> str:
    status = "PASS" if result.passed else "FAIL"
    return (
        f"{status} | {result.char_count} chars | "
        f"max {result.max_chars_for_duration} chars | "
        f"CPS: {result.cps:.1f} (limit: {MAX_CPS}) | "
        f"overflow: {result.overflow}"
    )


# ---------------------------------------------------------------------------
# エージェントループ共通処理
# ---------------------------------------------------------------------------
def _run_tool_loop(
    client: OpenAI,
    model: str,
    messages: list[dict],
    block: SrtBlock,
) -> tuple[str, list[TrialRecord], TokenUsage]:
    """
    LLMのtool useループを実行。
    validate_cpsツールを呼んで合格するまで繰り返す。
    返り値: (最終テキスト, 試行記録リスト, 累計トークン使用量)
    """
    trials: list[TrialRecord] = []
    usage = TokenUsage()
    attempt = 0
    final_text = block.english  # デフォルト: 元訳のまま

    while attempt < MAX_RETRIES:
        attempt += 1
        response = client.chat.completions.create(
            model=model,
            messages=messages,
            tools=[VALIDATE_CPS_SCHEMA],
            tool_choice="auto",
        )
        if response.usage:
            cached = 0
            if response.usage.prompt_tokens_details:
                cached = response.usage.prompt_tokens_details.cached_tokens or 0
            usage += TokenUsage(
                prompt_tokens=response.usage.prompt_tokens,
                cached_tokens=cached,
                completion_tokens=response.usage.completion_tokens,
            )
        msg = response.choices[0].message
        messages.append(msg.model_dump(exclude_none=True))

        # ツール呼び出しがあれば処理
        if msg.tool_calls:
            reasoning = msg.content.strip() if msg.content else None
            if reasoning:
                log.info("  [LLM] %s", reasoning[:120])
            for tc in msg.tool_calls:
                if tc.function.name == "validate_cps":
                    args = json.loads(tc.function.arguments)
                    candidate = args["text"]
                    result = validate_cps(candidate, block.duration)
                    tool_response_text = _tool_result_text(result)

                    log.info(
                        "  [試行 %d] %s → %s",
                        attempt, candidate[:60], tool_response_text
                    )

                    trials.append(TrialRecord(
                        attempt=attempt,
                        llm_reasoning=reasoning,
                        generated_text=candidate,
                        cps_result=result,
                        passed=result.passed,
                    ))

                    messages.append({
                        "role": "tool",
                        "tool_call_id": tc.id,
                        "content": tool_response_text,
                    })

                    if result.passed:
                        final_text = candidate
                        return final_text, trials, usage

        # ツール呼び出しなし＝LLMが最終回答を出した
        elif msg.content:
            final_text = msg.content.strip()
            log.info("  [LLM 最終回答] %s", final_text[:80])
            result = validate_cps(final_text, block.duration)
            trials.append(TrialRecord(
                attempt=attempt,
                llm_reasoning=None,
                generated_text=final_text,
                cps_result=result,
                passed=result.passed,
            ))
            break

    return final_text, trials, usage


# ---------------------------------------------------------------------------
# A案: 単純リトライ
# ---------------------------------------------------------------------------
SYSTEM_A = (
    "You are a subtitle editor. Your job is to rewrite English subtitles "
    "to satisfy a strict Characters Per Second (CPS) constraint. "
    "After EVERY rewrite, call validate_cps to check if it passes. "
    "Keep rewriting and checking until it passes. "
    "Preserve meaning as much as possible while shortening."
)


def _user_prompt_a(block: SrtBlock, prev: SrtBlock | None, next_: SrtBlock | None) -> str:
    ctx_prev = f"\n[PREV BLOCK] {prev.english}" if prev else ""
    ctx_next = f"\n[NEXT BLOCK] {next_.english}" if next_ else ""
    return (
        f"Rewrite this subtitle to pass the CPS constraint.\n"
        f"Duration: {block.duration:.2f}s | Max CPS: {MAX_CPS} | "
        f"Max chars: {int(MAX_CPS * block.duration)}\n"
        f"{ctx_prev}"
        f"\n[TARGET] {block.english}"
        f"{ctx_next}"
        f"\n\nRewrite the TARGET text, then call validate_cps to verify."
    )


def run_method_a(
    client: OpenAI,
    model: str,
    block: SrtBlock,
    prev: SrtBlock | None,
    next_: SrtBlock | None,
) -> BlockResult:
    messages = [
        {"role": "system", "content": SYSTEM_A},
        {"role": "user", "content": _user_prompt_a(block, prev, next_)},
    ]
    final_text, trials, usage = _run_tool_loop(client, model, messages, block)
    passed = any(t.passed for t in trials)

    return BlockResult(
        block_index=block.index,
        timecode=block.timecode,
        japanese=block.japanese,
        original_english=block.english,
        method="A",
        final_text=final_text if passed else block.english,
        passed=passed,
        attempts=len(trials),
        token_usage=usage,
        trials=trials,
    )


# ---------------------------------------------------------------------------
# B案: 計画→実行
# ---------------------------------------------------------------------------
SYSTEM_B = (
    "You are a subtitle editor. Your job is to rewrite English subtitles "
    "to satisfy a strict Characters Per Second (CPS) constraint. "
    "Follow this two-step approach:\n"
    "STEP 1 — Plan: Briefly describe your shortening strategy "
    "(e.g., pronominalize, omit redundancy, split sentence, use shorter synonyms).\n"
    "STEP 2 — Execute: Apply your plan, then call validate_cps to check. "
    "If it fails, revise your plan and try again.\n"
    "Preserve meaning as much as possible."
)


def _user_prompt_b(block: SrtBlock, prev: SrtBlock | None, next_: SrtBlock | None) -> str:
    ctx_prev = f"\n[PREV BLOCK] {prev.english}" if prev else ""
    ctx_next = f"\n[NEXT BLOCK] {next_.english}" if next_ else ""
    return (
        f"Rewrite this subtitle using the plan-then-execute approach.\n"
        f"Duration: {block.duration:.2f}s | Max CPS: {MAX_CPS} | "
        f"Max chars: {int(MAX_CPS * block.duration)}\n"
        f"{ctx_prev}"
        f"\n[TARGET] {block.english}"
        f"{ctx_next}"
        f"\n\nFirst state your shortening plan, then rewrite, then call validate_cps."
    )


def run_method_b(
    client: OpenAI,
    model: str,
    block: SrtBlock,
    prev: SrtBlock | None,
    next_: SrtBlock | None,
) -> BlockResult:
    messages = [
        {"role": "system", "content": SYSTEM_B},
        {"role": "user", "content": _user_prompt_b(block, prev, next_)},
    ]
    final_text, trials, usage = _run_tool_loop(client, model, messages, block)
    passed = any(t.passed for t in trials)

    return BlockResult(
        block_index=block.index,
        timecode=block.timecode,
        japanese=block.japanese,
        original_english=block.english,
        method="B",
        final_text=final_text if passed else block.english,
        passed=passed,
        attempts=len(trials),
        token_usage=usage,
        trials=trials,
    )


# ---------------------------------------------------------------------------
# 結果出力
# ---------------------------------------------------------------------------
def _sum_usage(results: list[BlockResult]) -> TokenUsage:
    total = TokenUsage()
    for r in results:
        total += r.token_usage
    return total


def save_results(
    results_a: list[BlockResult],
    results_b: list[BlockResult],
    model: str,
    output_dir: Path,
    price_input_per_1m: float = DEFAULT_PRICE_INPUT,
    price_cached_per_1m: float = DEFAULT_PRICE_CACHED_INPUT,
    price_output_per_1m: float = DEFAULT_PRICE_OUTPUT,
) -> None:
    output_dir.mkdir(exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")

    usage_a = _sum_usage(results_a)
    usage_b = _sum_usage(results_b)
    usage_total = TokenUsage(
        prompt_tokens=usage_a.prompt_tokens + usage_b.prompt_tokens,
        completion_tokens=usage_a.completion_tokens + usage_b.completion_tokens,
    )

    # JSON（全データ）
    json_path = output_dir / f"cps_phase1_{timestamp}.json"
    payload = {
        "timestamp": timestamp,
        "model": model,
        "config": {"max_cps": MAX_CPS, "max_chars": MAX_CHARS, "max_retries": MAX_RETRIES},
        "token_usage": {
            "method_a": asdict(usage_a),
            "method_b": asdict(usage_b),
            "total": asdict(usage_total),
            "price_input_per_1m_usd": price_input_per_1m,
            "price_cached_per_1m_usd": price_cached_per_1m,
            "price_output_per_1m_usd": price_output_per_1m,
            "estimated_cost_usd": round(
                usage_total.cost_usd(price_input_per_1m, price_output_per_1m, price_cached_per_1m), 6
            ),
        },
        "method_a": [asdict(r) for r in results_a],
        "method_b": [asdict(r) for r in results_b],
    }
    json_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    log.info("JSON出力: %s", json_path)

    # テキストレポート
    txt_path = output_dir / f"cps_phase1_{timestamp}.txt"
    lines = [
        f"# CPS自動化 Phase 1 結果レポート",
        f"# 生成日時: {timestamp}",
        f"# モデル: {model}",
        f"# 最大CPS: {MAX_CPS} | 最大リトライ: {MAX_RETRIES}",
        "",
        "=" * 72,
        "## 集計サマリー",
        "=" * 72,
    ]

    def summary(results: list[BlockResult], label: str, usage: TokenUsage) -> None:
        total = len(results)
        passed = sum(1 for r in results if r.passed)
        avg_attempts = sum(r.attempts for r in results) / total if total else 0
        non_cached = usage.prompt_tokens - usage.cached_tokens
        cost_in  = non_cached / 1_000_000 * price_input_per_1m
        cost_ca  = usage.cached_tokens / 1_000_000 * price_cached_per_1m
        cost_out = usage.completion_tokens / 1_000_000 * price_output_per_1m
        cost_total = cost_in + cost_ca + cost_out
        lines.append(f"\n### {label}")
        lines.append(f"  成功率           : {passed}/{total} ({100*passed//total if total else 0}%)")
        lines.append(f"  平均試行回数     : {avg_attempts:.1f}")
        lines.append(f"  入力トークン     : {usage.prompt_tokens:,}  (うちキャッシュ: {usage.cached_tokens:,})")
        lines.append(f"  出力トークン     : {usage.completion_tokens:,}")
        lines.append(f"  合計トークン     : {usage.total_tokens:,}")
        lines.append(f"  推定コスト       : ${cost_total:.6f}  (入力 ${cost_in:.6f} + キャッシュ ${cost_ca:.6f} + 出力 ${cost_out:.6f})")

    summary(results_a, "A案（単純リトライ）", usage_a)
    summary(results_b, "B案（計画→実行）", usage_b)

    non_cached_total = usage_total.prompt_tokens - usage_total.cached_tokens
    cost_in_t  = non_cached_total / 1_000_000 * price_input_per_1m
    cost_ca_t  = usage_total.cached_tokens / 1_000_000 * price_cached_per_1m
    cost_out_t = usage_total.completion_tokens / 1_000_000 * price_output_per_1m
    cost_grand = cost_in_t + cost_ca_t + cost_out_t
    lines.append(f"\n### 合計（A案＋B案）")
    lines.append(f"  入力トークン     : {usage_total.prompt_tokens:,}  (うちキャッシュ: {usage_total.cached_tokens:,})")
    lines.append(f"  出力トークン     : {usage_total.completion_tokens:,}")
    lines.append(f"  合計トークン     : {usage_total.total_tokens:,}")
    lines.append(f"  推定コスト       : ${cost_grand:.6f}  (入力 ${cost_in_t:.6f} + キャッシュ ${cost_ca_t:.6f} + 出力 ${cost_out_t:.6f})")
    lines.append(f"  単価             : 入力 ${price_input_per_1m}/1M, キャッシュ ${price_cached_per_1m}/1M, 出力 ${price_output_per_1m}/1M")

    lines += ["", "=" * 72, "## ブロック別比較", "=" * 72, ""]

    def fmt_trials(result: BlockResult) -> list[str]:
        out = []
        for t in result.trials:
            status = "✅ PASS" if t.passed else "❌ FAIL"
            if t.llm_reasoning:
                out.append(f"      [計画] {t.llm_reasoning}")
            cps_info = f"({t.cps_result.char_count}文字 / {t.cps_result.cps}CPS / 上限{t.cps_result.max_chars_for_duration}文字)"
            out.append(f"      [試行{t.attempt}] {status} {t.generated_text}  {cps_info}")
        return out

    paired = {r.block_index: r for r in results_a}
    for rb in results_b:
        ra = paired.get(rb.block_index)
        lines.append(f"### Block {rb.block_index} | {rb.timecode}")
        lines.append(f"  JA    : {rb.japanese}")
        orig_cps = rb.trials[0].cps_result if rb.trials else None
        orig_info = f"  ({len(rb.original_english)}文字 / 上限{orig_cps.max_chars_for_duration}文字)" if orig_cps else ""
        lines.append(f"  原文  : {rb.original_english}{orig_info}")
        if ra:
            status_a = "✅" if ra.passed else f"❌({ra.attempts}回失敗)"
            lines.append(f"  --- A案（単純リトライ）{status_a} [{ra.token_usage.total_tokens}tok] ---")
            lines.extend(fmt_trials(ra))
        status_b = "✅" if rb.passed else f"❌({rb.attempts}回失敗)"
        lines.append(f"  --- B案（計画→実行）{status_b} [{rb.token_usage.total_tokens}tok] ---")
        lines.extend(fmt_trials(rb))
        lines.append("")

    txt_path.write_text("\n".join(lines), encoding="utf-8")
    log.info("テキストレポート出力: %s", txt_path)


# ---------------------------------------------------------------------------
# メイン
# ---------------------------------------------------------------------------
def main() -> None:
    parser = argparse.ArgumentParser(description="CPS自動化 Phase 1 PoC")
    parser.add_argument(
        "--input", type=Path,
        default=Path("input.txt"),
        help="入力SRTファイルパス（日英2行SRT形式）",
    )
    parser.add_argument("--blocks", type=int, default=None, help="テストするブロック数（デフォルト: 全違反ブロック）")
    parser.add_argument("--model", type=str, default=DEFAULT_MODEL, help="OpenAIモデルID")
    parser.add_argument("--price-input", type=float, default=DEFAULT_PRICE_INPUT, metavar="USD_PER_1M",
                        help=f"入力トークン単価（$/1Mトークン）デフォルト: {DEFAULT_PRICE_INPUT}")
    parser.add_argument("--price-cached", type=float, default=DEFAULT_PRICE_CACHED_INPUT, metavar="USD_PER_1M",
                        help=f"キャッシュ入力トークン単価（$/1Mトークン）デフォルト: {DEFAULT_PRICE_CACHED_INPUT}")
    parser.add_argument("--price-output", type=float, default=DEFAULT_PRICE_OUTPUT, metavar="USD_PER_1M",
                        help=f"出力トークン単価（$/1Mトークン）デフォルト: {DEFAULT_PRICE_OUTPUT}")
    args = parser.parse_args()

    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY が未設定です。.env ファイルを確認してください。")

    client = OpenAI(api_key=api_key)

    log.info("SRT読み込み: %s", args.input)
    all_blocks = parse_bilingual_srt(args.input)
    log.info("  全ブロック数: %d", len(all_blocks))

    violations = get_violations(all_blocks)
    log.info("  CPS違反ブロック数: %d", len(violations))

    if args.blocks:
        violations = violations[: args.blocks]
        log.info("  → %d ブロックに絞って実行", len(violations))

    # ブロックインデックスで引けるようにする（前後コンテキスト用）
    block_map = {b.index: b for b in all_blocks}

    results_a: list[BlockResult] = []
    results_b: list[BlockResult] = []

    for i, block in enumerate(violations):
        prev = block_map.get(block.index - 1)
        next_ = block_map.get(block.index + 1)
        log.info("[%d/%d] Block %d (%.1f秒, %d chars, CPS=%.1f)",
                 i + 1, len(violations), block.index,
                 block.duration, len(block.english),
                 len(block.english) / block.duration)

        log.info("  → A案 実行中...")
        result_a = run_method_a(client, args.model, block, prev, next_)
        results_a.append(result_a)
        time.sleep(0.3)  # レート制限対策

        log.info("  → B案 実行中...")
        result_b = run_method_b(client, args.model, block, prev, next_)
        results_b.append(result_b)
        time.sleep(0.3)

    save_results(results_a, results_b, args.model, OUTPUT_DIR,
                 price_input_per_1m=args.price_input,
                 price_cached_per_1m=args.price_cached,
                 price_output_per_1m=args.price_output)


if __name__ == "__main__":
    main()
