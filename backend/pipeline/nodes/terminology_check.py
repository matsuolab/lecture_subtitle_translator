from __future__ import annotations

from .base import BaseStubNode
from ..contracts import RunState


class TerminologyCheckNode(BaseStubNode):
    def run(self, state: RunState):
        glossary = state.data.get("glossary_terms", [])
        translated = state.data.get("translated_segments", [])
        if not glossary:
            return self.success({"terminology_miss_count": 0}, {"miss_count": 0})

        all_text = " ".join(str(seg.get("en", "")).lower() for seg in translated)
        misses = [term for term in glossary if str(term).lower() not in all_text]
        updates = {"terminology_miss_count": len(misses), "terminology_misses": misses}
        if misses:
            return self.failure(["terminology misses found"], {"miss_count": len(misses)})
        return self.success(updates, {"miss_count": 0})
