from __future__ import annotations

from .base import BaseStubNode
from ..contracts import RunState


class CpsGuardNode(BaseStubNode):
    def run(self, state: RunState):
        max_cps = float(state.data.get("max_cps", 15.0))
        blocks = state.data.get("subtitle_blocks", [])
        violations = [b for b in blocks if float(b.get("cps", 0.0)) > max_cps]
        updates = {"cps_violation_count": len(violations)}
        metrics = {"max_cps": max_cps, "violation_count": len(violations)}
        if violations:
            return self.failure(["cps violations found"], metrics)
        return self.success(updates, metrics)
