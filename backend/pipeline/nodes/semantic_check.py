from __future__ import annotations

from .base import BaseStubNode
from ..contracts import RunState


class SemanticCheckNode(BaseStubNode):
    """Heuristic semantic check. Can be replaced by embedding-based checker."""

    def run(self, state: RunState):
        translated = state.data.get("translated_segments", [])
        override = state.data.get("semantic_score_override")
        threshold = float(state.data.get("semantic_threshold", 0.85))

        if not translated:
            return self.failure(["no translated segments"], {"score": 0.0, "threshold": threshold})

        if override is not None:
            score = float(override)
        else:
            flagged = sum(1 for seg in translated if bool(seg.get("translation_flagged", False)))
            ratio = flagged / max(1, len(translated))
            score = round(max(0.0, 0.98 - ratio * 0.5), 4)

        updates = {"semantic_score": score, "semantic_threshold": threshold}
        if score < threshold:
            return self.failure(["semantic score below threshold"], {"score": score, "threshold": threshold})
        return self.success(updates, {"score": score, "threshold": threshold})
