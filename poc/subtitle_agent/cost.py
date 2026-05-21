"""LLM API 利用トークンとコストの集計.

OpenAI 標準ティアの料金表でコストを算出する。
CachingBackend のキャッシュヒットは API を呼ばないためコストに含まれない
(実際の課金と一致する — 集計は OpenAICompatibleBackend が実呼び出しのみ計上)。
"""

from dataclasses import dataclass


@dataclass(frozen=True)
class ModelPricing:
    """1Mトークンあたりの料金 (USD)。"""

    input: float
    cached_input: float
    output: float


# OpenAI 標準ティア・ショートコンテキストの料金 (USD / 1Mトークン)。
# 出典: ユーザー提供の料金表 (2026-04 時点)。再確認時はここを更新する。
MODEL_PRICING: dict[str, ModelPricing] = {
    "gpt-5.5": ModelPricing(5.00, 0.50, 30.00),
    "gpt-5.5-2026-04-23": ModelPricing(5.00, 0.50, 30.00),
    "gpt-5.4": ModelPricing(2.50, 0.25, 15.00),
    "gpt-5.4-mini": ModelPricing(0.75, 0.075, 4.50),
    "gpt-5.4-nano": ModelPricing(0.20, 0.02, 1.25),
}


@dataclass(frozen=True)
class TokenUsage:
    """1モデルの累積トークン利用量。"""

    model: str
    calls: int
    prompt_tokens: int       # cached_tokens を含む総入力トークン
    cached_tokens: int
    completion_tokens: int

    @property
    def fresh_input_tokens(self) -> int:
        """キャッシュされていない入力トークン数。"""
        return max(0, self.prompt_tokens - self.cached_tokens)


def cost_usd(usage: TokenUsage) -> float | None:
    """利用量からコスト (USD) を算出する。料金表に無いモデルは None。"""
    pricing = MODEL_PRICING.get(usage.model)
    if pricing is None:
        return None
    return (
        usage.fresh_input_tokens * pricing.input
        + usage.cached_tokens * pricing.cached_input
        + usage.completion_tokens * pricing.output
    ) / 1_000_000


def format_cost_report(usages: list[TokenUsage]) -> list[str]:
    """役割別のトークン・コスト内訳と合計コストの表示行を返す。"""
    lines: list[str] = []
    total = 0.0
    unknown = False
    for u in usages:
        if u.calls == 0:
            continue
        cost = cost_usd(u)
        if cost is None:
            unknown = True
            note = " (料金表に無いモデル — コスト不明)"
            cost_str = "?"
        else:
            total += cost
            note = ""
            cost_str = f"${cost:.4f}"
        lines.append(
            f"  {u.model}: {u.calls} 回呼び出し  "
            f"入力 {u.prompt_tokens:,} (うちキャッシュ {u.cached_tokens:,}) / "
            f"出力 {u.completion_tokens:,} トークン  = {cost_str}{note}"
        )
    if not lines:
        return ["  LLM API 呼び出しなし (全てキャッシュヒット)"]
    suffix = " + 不明分" if unknown else ""
    lines.append(f"  合計コスト: ${total:.4f}{suffix}")
    return lines
