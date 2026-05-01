from __future__ import annotations

from .base import BaseStubNode
from ..contracts import NodeResult, RunState


class SemanticCheckNode(BaseStubNode):
    """Heuristic semantic check. Can be replaced by embedding-based checker."""

    def run(self, state: RunState):
        translated = state.data.get("translated_segments", [])
        override = state.data.get("semantic_score_override")
        threshold = float(state.data.get("semantic_threshold", 0.85))
        failure_count = int(state.data.get("_semantic_retry_count", 0))
        max_retries = int(state.data.get("max_semantic_retries", 2))

        if not translated:
            return self.failure(["no translated segments"], {"score": 0.0, "threshold": threshold})

        if override is not None:
            score = float(override)
        else:
            flagged = sum(1 for seg in translated if bool(seg.get("translation_flagged", False)))
            ratio = flagged / max(1, len(translated))
            score = round(max(0.0, 0.98 - ratio * 0.5), 4)

        base_updates = {"semantic_score": score, "semantic_threshold": threshold}

        if score >= threshold:
            return self.success(
                {**base_updates, "_semantic_retry_count": 0},
                {"score": score, "threshold": threshold},
            )

        if failure_count >= max_retries:
            # Accept below-threshold after exhausting retries to avoid translate loop failure.
            # Matches TS localPipeline maxTranslateRetries behaviour.
            return self.success(
                {**base_updates, "_semantic_retry_count": 0, "semantic_accepted_below_threshold": True},
                {"score": score, "threshold": threshold, "accepted_below_threshold": True},
            )

        return NodeResult(
            status="failure",
            updates={"_semantic_retry_count": failure_count + 1},
            issues=["semantic score below threshold"],
            metrics={"score": score, "threshold": threshold},
            provider=self.provider,
            model=self.model,
        )
