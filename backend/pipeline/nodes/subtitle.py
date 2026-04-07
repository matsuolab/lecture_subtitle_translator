from __future__ import annotations

from .base import BaseStubNode
from .text_utils import split_en_lines_42
from ..contracts import RunState


class SubtitleFormatNode(BaseStubNode):
    provider = "deterministic-local"
    model = "subtitle-v2"

    def run(self, state: RunState):
        translated = state.data.get("translated_segments", [])
        max_chars = int(state.data.get("max_chars", 42))

        blocks = []
        for i, seg in enumerate(translated, start=1):
            start = float(seg.get("start", 0.0))
            end = float(seg.get("end", start + 2.0))
            duration = max(0.1, end - start)

            text = str(seg.get("en") or seg.get("translated_text") or "")
            text = split_en_lines_42(text, max_chars=max_chars)
            char_count = len(text.replace("\n", ""))
            cps = round(char_count / duration, 2)

            blocks.append(
                {
                    "index": int(seg.get("id", i)),
                    "start": start,
                    "end": end,
                    "text": text,
                    "char_count": char_count,
                    "cps": cps,
                    "source_segment_id": int(seg.get("id", i)),
                }
            )

        return self.success(
            {"subtitle_blocks": blocks},
            {"blocks": len(blocks), "max_chars": max_chars},
        )
