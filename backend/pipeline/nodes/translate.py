from __future__ import annotations

from dataclasses import dataclass

from .base import BaseStubNode
from .text_utils import normalize_spaces
from ..contracts import RunState


_JA_EN_MAP = {
    "書き起こし": "transcription",
    "実行": "execution",
    "翻訳": "translation",
    "補正": "correction",
    "字幕": "subtitle",
    "用語": "terminology",
    "講義": "lecture",
    "処理": "processing",
}


@dataclass(frozen=True)
class _RuntimeTranslationConfig:
    provider: str
    provider_label: str
    model: str


_PROVIDER_MAP = {
    "openai": _RuntimeTranslationConfig(
        provider="openai-api",
        provider_label="OpenAI",
        model="gpt-4.1-mini (planned)",
    ),
    "gemini": _RuntimeTranslationConfig(
        provider="gemini-api",
        provider_label="Gemini",
        model="gemini-2.5-flash (planned)",
    ),
    "deepl": _RuntimeTranslationConfig(
        provider="deepl-api",
        provider_label="DeepL",
        model="deepl-text (planned)",
    ),
    "local": _RuntimeTranslationConfig(
        provider="openai-compatible-local",
        provider_label="Local/OpenAI-compatible",
        model="custom-openai-compatible (planned)",
    ),
}


def _simple_translate(ja_text: str) -> tuple[str, bool]:
    text = normalize_spaces(ja_text)
    if not text:
        return "", True

    translated = text
    replaced_any = False
    for ja, en in _JA_EN_MAP.items():
        if ja in translated:
            translated = translated.replace(ja, en)
            replaced_any = True

    translated = translated.replace("。", ".").replace("、", ", ")
    translated = normalize_spaces(translated)
    if not translated.endswith("."):
        translated = translated + "."

    if replaced_any:
        return translated, False
    return f"EN: {translated}", True


def _resolve_runtime_config(state: RunState) -> _RuntimeTranslationConfig:
    runtime_settings = state.data.get("runtime_settings") or {}
    provider_key = str(runtime_settings.get("translation_provider", "openai")).strip().lower()
    return _PROVIDER_MAP.get(provider_key, _PROVIDER_MAP["openai"])


class TranslateNode(BaseStubNode):
    provider = "deterministic-local"
    model = "translate-v2"

    def run(self, state: RunState):
        corrected = state.data.get("corrected_segments", [])
        threshold = float(state.data.get("translation_threshold", 0.35))
        runtime = _resolve_runtime_config(state)
        self.provider = runtime.provider
        self.model = runtime.model

        translated_rows = []
        flagged = 0

        for seg in corrected:
            ja_text = str(seg.get("ja_corrected") or seg.get("text") or "")
            en_text, fallback = _simple_translate(ja_text)

            distance = 0.45 if fallback else 0.18
            is_flagged = distance > threshold or bool(seg.get("correction_flagged", False))
            flagged += 1 if is_flagged else 0

            translated_rows.append(
                {
                    **seg,
                    "en": en_text,
                    "translated_text": en_text,
                    "translation_distance": distance,
                    "translation_flagged": is_flagged,
                    "translation_fallback": fallback,
                    "translation_provider": runtime.provider_label,
                }
            )

        return self.success(
            {"translated_segments": translated_rows},
            {
                "segments": len(translated_rows),
                "flagged": flagged,
                "threshold": threshold,
                "translation_provider": runtime.provider,
                "translation_model": runtime.model,
                "translation_mode": "stub-runtime-configured",
            },
        )
