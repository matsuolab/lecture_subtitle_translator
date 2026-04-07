from __future__ import annotations

from difflib import SequenceMatcher

from .base import BaseStubNode
from .text_utils import apply_term_replacements, normalize_spaces, remove_fillers
from ..contracts import RunState


class CorrectNode(BaseStubNode):
    provider = "deterministic-local"
    model = "correct-v2"

    def run(self, state: RunState):
        segments = state.data.get("transcript_segments", [])
        terms = state.data.get("correction_terms", [])
        threshold = float(state.data.get("correction_threshold", 0.2))

        corrected = []
        flagged = 0

        for seg in segments:
            source = str(seg.get("text") or seg.get("ja") or "")
            normalized = remove_fillers(source)
            normalized = apply_term_replacements(normalized, terms)
            normalized = normalize_spaces(normalized)

            distance = round(1.0 - SequenceMatcher(None, source, normalized).ratio(), 4)
            is_flagged = distance > threshold
            flagged += 1 if is_flagged else 0

            corrected.append(
                {
                    **seg,
                    "ja_corrected": normalized,
                    "correction_distance": distance,
                    "correction_flagged": is_flagged,
                }
            )

        return self.success(
            {"corrected_segments": corrected},
            {"segments": len(corrected), "flagged": flagged, "threshold": threshold},
        )
