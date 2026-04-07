from __future__ import annotations

from .nodes import (
    CorrectNode,
    CpsGuardNode,
    ExtractAudioNode,
    SemanticCheckNode,
    SubtitleFormatNode,
    TerminologyCheckNode,
    TranscribeNode,
    TranslateNode,
)
from .registry import NodeRegistry


def build_default_registry() -> NodeRegistry:
    registry = NodeRegistry()
    registry.register("extract_audio", ExtractAudioNode)
    registry.register("transcribe", TranscribeNode)
    registry.register("correct", CorrectNode)
    registry.register("translate", TranslateNode)
    registry.register("subtitle", SubtitleFormatNode)
    registry.register("semantic_check", SemanticCheckNode)
    registry.register("terminology_check", TerminologyCheckNode)
    registry.register("cps_guard", CpsGuardNode)
    return registry
