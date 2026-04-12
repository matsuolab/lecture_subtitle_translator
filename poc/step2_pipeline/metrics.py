"""
パイプライン実行コスト・時間計測モジュール。

各ステップの実行時間と LLM / Embedding の API コストを記録し、
サマリーをコンソールと JSON レポートに出力する。

料金テーブル更新方法:
  PRICING の値を変更するだけでよい。単位は USD / 1M トークン。
  最終更新: 2026-04-03
  参照: https://ai.google.dev/gemini-api/docs/pricing
"""

from __future__ import annotations

import time
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Generator


# ---------------------------------------------------------------------------
# 料金テーブル（USD / 1M tokens）
# 入力・出力を分けて管理。embedding は output=0。
# ---------------------------------------------------------------------------

PRICING: dict[str, dict[str, float]] = {
    # --- Gemini stable ---
    "gemini-2.5-flash":            {"input": 0.30,  "output": 2.50},
    "gemini-2.5-flash-lite":       {"input": 0.10,  "output": 0.40},
    "gemini-2.5-pro":              {"input": 1.25,  "output": 10.00},
    # --- Gemini preview ---
    "gemini-3-flash-preview":      {"input": 0.50,  "output": 3.00},
    "gemini-3.1-flash-lite-preview": {"input": 0.25, "output": 1.50},
    "gemini-3.1-pro-preview":      {"input": 2.00,  "output": 12.00},
    # --- Gemini embedding ---
    "gemini-embedding-001":        {"input": 0.15,  "output": 0.00},
    "gemini-embedding-2-preview":  {"input": 0.15,  "output": 0.00},
    # --- OpenAI ---
    "gpt-4.1":                     {"input": 2.00,  "output": 8.00},
    "gpt-4.1-mini":                {"input": 0.40,  "output": 1.60},
    "text-embedding-3-small":      {"input": 0.02,  "output": 0.00},
    "text-embedding-3-large":      {"input": 0.13,  "output": 0.00},
}


def estimate_cost(model: str, tokens_in: int, tokens_out: int) -> float:
    """モデル名とトークン数からコスト（USD）を推定する。未知モデルは 0.0 を返す。"""
    price = PRICING.get(model)
    if price is None:
        return 0.0
    return (tokens_in * price["input"] + tokens_out * price["output"]) / 1_000_000


# ---------------------------------------------------------------------------
# データ構造
# ---------------------------------------------------------------------------

@dataclass
class LLMUsage:
    """1回の LLM / Embedding 呼び出しの使用量。"""
    model: str
    tokens_in: int
    tokens_out: int

    @property
    def cost_usd(self) -> float:
        return estimate_cost(self.model, self.tokens_in, self.tokens_out)


@dataclass
class StepMetrics:
    """1ステップの計測結果。"""
    step: str
    duration_sec: float
    usages: list[LLMUsage] = field(default_factory=list)

    @property
    def tokens_in(self) -> int:
        return sum(u.tokens_in for u in self.usages)

    @property
    def tokens_out(self) -> int:
        return sum(u.tokens_out for u in self.usages)

    @property
    def cost_usd(self) -> float:
        return sum(u.cost_usd for u in self.usages)


@dataclass
class PipelineMetrics:
    """パイプライン全体の計測結果。"""
    steps: list[StepMetrics] = field(default_factory=list)

    @property
    def total_duration_sec(self) -> float:
        return sum(s.duration_sec for s in self.steps)

    @property
    def total_tokens_in(self) -> int:
        return sum(s.tokens_in for s in self.steps)

    @property
    def total_tokens_out(self) -> int:
        return sum(s.tokens_out for s in self.steps)

    @property
    def total_cost_usd(self) -> float:
        return sum(s.cost_usd for s in self.steps)

    def print_summary(self) -> None:
        """コンソールにサマリーを出力する。"""
        print("\n" + "=" * 60)
        print("  パイプライン計測サマリー")
        print("=" * 60)
        print(f"  {'ステップ':<20} {'時間':>8}  {'入力tok':>8}  {'出力tok':>8}  {'コスト':>10}")
        print("-" * 60)
        for s in self.steps:
            cost_str = f"${s.cost_usd:.4f}" if s.cost_usd > 0 else "-"
            tok_in = str(s.tokens_in) if s.tokens_in > 0 else "-"
            tok_out = str(s.tokens_out) if s.tokens_out > 0 else "-"
            print(
                f"  {s.step:<20} {s.duration_sec:>7.1f}s"
                f"  {tok_in:>8}  {tok_out:>8}  {cost_str:>10}"
            )
        print("-" * 60)
        cost_total = f"${self.total_cost_usd:.4f}"
        print(
            f"  {'合計':<20} {self.total_duration_sec:>7.1f}s"
            f"  {self.total_tokens_in:>8}  {self.total_tokens_out:>8}  {cost_total:>10}"
        )
        print("=" * 60 + "\n")

    def to_dict(self) -> dict:
        """JSON レポートに埋め込む辞書形式に変換する。"""
        return {
            "total_duration_sec": round(self.total_duration_sec, 2),
            "total_tokens_in": self.total_tokens_in,
            "total_tokens_out": self.total_tokens_out,
            "total_cost_usd": round(self.total_cost_usd, 6),
            "steps": [
                {
                    "step": s.step,
                    "duration_sec": round(s.duration_sec, 2),
                    "tokens_in": s.tokens_in,
                    "tokens_out": s.tokens_out,
                    "cost_usd": round(s.cost_usd, 6),
                    "usages": [
                        {
                            "model": u.model,
                            "tokens_in": u.tokens_in,
                            "tokens_out": u.tokens_out,
                            "cost_usd": round(u.cost_usd, 6),
                        }
                        for u in s.usages
                    ],
                }
                for s in self.steps
            ],
        }


# ---------------------------------------------------------------------------
# タイマーユーティリティ
# ---------------------------------------------------------------------------

@contextmanager
def step_timer(metrics: PipelineMetrics, step_name: str) -> Generator[StepMetrics, None, None]:
    """
    with ブロックでステップの実行時間を計測し、PipelineMetrics に追加する。

    使い方:
        with step_timer(metrics, "transcribe") as sm:
            result = await some_step()
            sm.usages.extend(provider.flush_usage())
    """
    sm = StepMetrics(step=step_name, duration_sec=0.0)
    t0 = time.perf_counter()
    try:
        yield sm
    finally:
        sm.duration_sec = time.perf_counter() - t0
        metrics.steps.append(sm)
