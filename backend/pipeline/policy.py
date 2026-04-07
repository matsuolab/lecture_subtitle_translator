from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from .contracts import NodeResult


Action = Literal["retry", "continue", "fail"]


@dataclass(frozen=True)
class PolicyDecision:
    action: Action
    reason: str


class PolicyEngine:
    """Controls retry/fail behavior per node result."""

    def decide(self, result: NodeResult, attempt: int, max_attempts: int) -> PolicyDecision:
        if result.status == "success":
            return PolicyDecision(action="continue", reason="node succeeded")
        if attempt < max_attempts:
            return PolicyDecision(action="retry", reason="node failed; retry allowed")
        return PolicyDecision(action="fail", reason="node failed; retries exhausted")
