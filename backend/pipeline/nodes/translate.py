from __future__ import annotations

from dataclasses import dataclass
import json
import os
import re
from typing import Any
from urllib import error as urllib_error
from urllib import request as urllib_request

from .base import BaseStubNode
from .text_utils import normalize_spaces
from ..contracts import RunState


_JSON_BLOCK_RE = re.compile(r"\{.*\}", re.DOTALL)
_JA_CHAR_RE = re.compile(r"[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]")
_MAX_SEGMENTS_PER_REQUEST = 40


@dataclass(frozen=True)
class _RuntimeTranslationConfig:
    provider: str
    provider_label: str
    model: str
    api_key_field: str | None = None
    env_key: str | None = None
    default_base_url: str | None = None
    base_url_field: str | None = None
    api_key_required: bool = True
    supported: bool = True


_PROVIDER_MAP = {
    "openai": _RuntimeTranslationConfig(
        provider="openai-api",
        provider_label="OpenAI",
        model="gpt-4.1-mini",
        api_key_field="openai_api_key",
        env_key="OPENAI_API_KEY",
        default_base_url="https://api.openai.com/v1",
    ),
    "gemini": _RuntimeTranslationConfig(
        provider="gemini-api",
        provider_label="Gemini",
        model="gemini-2.5-flash",
        api_key_field="gemini_api_key",
        env_key="GEMINI_API_KEY",
        supported=False,
    ),
    "deepl": _RuntimeTranslationConfig(
        provider="deepl-api",
        provider_label="DeepL",
        model="deepl-text",
        api_key_field="deepl_api_key",
        env_key="DEEPL_API_KEY",
        supported=False,
    ),
    "local": _RuntimeTranslationConfig(
        provider="openai-compatible-local",
        provider_label="Local/OpenAI-compatible",
        model="custom-openai-compatible",
        api_key_field="openai_api_key",
        env_key="OPENAI_API_KEY",
        base_url_field="openai_compatible_base_url",
        api_key_required=False,
    ),
}


def _resolve_runtime_config(runtime_settings: dict[str, Any]) -> _RuntimeTranslationConfig:
    provider_key = str(runtime_settings.get("translation_provider", "openai")).strip().lower()
    return _PROVIDER_MAP.get(provider_key, _PROVIDER_MAP["openai"])


def validate_runtime_translation_settings(runtime_settings: dict[str, Any] | None) -> str | None:
    runtime_settings = runtime_settings or {}
    runtime = _resolve_runtime_config(runtime_settings)

    if not runtime.supported:
        return f"translation provider is not implemented yet: {runtime.provider_label}"

    base_url = _resolve_base_url(runtime_settings, runtime)
    if not base_url:
        if runtime.provider == "openai-compatible-local":
            return "openai_compatible_base_url is required for local translation provider"
        return "translation service base URL is not configured"

    api_key = _resolve_api_key(runtime_settings, runtime)
    if runtime.api_key_required and not api_key:
        return f"{runtime.provider_label} API key is required before running the pipeline"

    return None


def _resolve_api_key(runtime_settings: dict[str, Any], runtime: _RuntimeTranslationConfig) -> str:
    if runtime.api_key_field:
        value = str(runtime_settings.get(runtime.api_key_field) or "").strip()
        if value:
            return value
    if runtime.env_key:
        return str(os.getenv(runtime.env_key, "")).strip()
    return ""


def _resolve_base_url(runtime_settings: dict[str, Any], runtime: _RuntimeTranslationConfig) -> str:
    if runtime.base_url_field:
        custom = str(runtime_settings.get(runtime.base_url_field) or "").strip()
        if custom:
            return custom.rstrip("/")
    if runtime.default_base_url:
        return runtime.default_base_url.rstrip("/")
    return ""


def _parse_translation_payload(content: str) -> list[str]:
    raw = content.strip()
    candidates = [raw]
    match = _JSON_BLOCK_RE.search(raw)
    if match:
        candidates.append(match.group(0))

    for candidate in candidates:
        try:
            payload = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        translations = payload.get("translations") if isinstance(payload, dict) else None
        if isinstance(translations, list) and all(isinstance(item, str) for item in translations):
            return [normalize_spaces(item) for item in translations]

    raise RuntimeError("translation response was not valid JSON with a translations array")


def _looks_untranslated(source: str, translated: str) -> bool:
    source_text = normalize_spaces(source)
    translated_text = normalize_spaces(translated)
    if not translated_text:
        return True
    if translated_text == source_text:
        return True

    non_space_chars = [char for char in translated_text if not char.isspace()]
    if not non_space_chars:
        return True
    ja_ratio = len(_JA_CHAR_RE.findall(translated_text)) / len(non_space_chars)
    return ja_ratio >= 0.35


def _translate_segments_with_openai_compatible(
    texts: list[str],
    runtime_settings: dict[str, Any],
    runtime: _RuntimeTranslationConfig,
) -> list[str]:
    if not texts:
        return []

    api_key = _resolve_api_key(runtime_settings, runtime)
    base_url = _resolve_base_url(runtime_settings, runtime)
    endpoint = f"{base_url}/chat/completions"
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    translated: list[str] = []
    for start in range(0, len(texts), _MAX_SEGMENTS_PER_REQUEST):
        batch = texts[start : start + _MAX_SEGMENTS_PER_REQUEST]
        payload = {
            "model": runtime.model,
            "temperature": 0.2,
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "Translate Japanese meeting transcript segments into natural English subtitles. "
                        "Return a strict JSON object with one key, `translations`, whose value is an array of English strings. "
                        "Preserve order and array length exactly."
                    ),
                },
                {
                    "role": "user",
                    "content": json.dumps({"segments": batch}, ensure_ascii=False),
                },
            ],
        }
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        request = urllib_request.Request(endpoint, data=data, headers=headers, method="POST")
        try:
            with urllib_request.urlopen(request, timeout=120) as response:
                body = response.read().decode("utf-8")
        except urllib_error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"translation API returned HTTP {exc.code}: {detail}") from exc
        except urllib_error.URLError as exc:
            raise RuntimeError(f"translation API request failed: {exc.reason}") from exc

        response_payload = json.loads(body)
        choices = response_payload.get("choices")
        if not isinstance(choices, list) or not choices:
            raise RuntimeError("translation API response did not include choices")
        message = choices[0].get("message", {})
        content = message.get("content")
        if not isinstance(content, str) or not content.strip():
            raise RuntimeError("translation API response did not include message content")

        batch_translations = _parse_translation_payload(content)
        if len(batch_translations) != len(batch):
            raise RuntimeError(
                f"translation API returned {len(batch_translations)} segments for {len(batch)} inputs"
            )
        translated.extend(batch_translations)

    return translated


class TranslateNode(BaseStubNode):
    provider = "translation-service"
    model = "translate-v3"

    def run(self, state: RunState):
        corrected = state.data.get("corrected_segments", [])
        runtime_settings = state.data.get("runtime_settings") or {}
        runtime = _resolve_runtime_config(runtime_settings)
        self.provider = runtime.provider
        self.model = runtime.model

        if not corrected:
            return self.failure(
                ["no corrected segments"],
                {
                    "translation_provider": runtime.provider,
                    "translation_model": runtime.model,
                    "retryable": False,
                },
            )

        validation_error = validate_runtime_translation_settings(runtime_settings)
        if validation_error:
            return self.failure(
                [validation_error],
                {
                    "translation_provider": runtime.provider,
                    "translation_model": runtime.model,
                    "retryable": False,
                },
            )

        source_texts = [str(seg.get("ja_corrected") or seg.get("text") or "") for seg in corrected]
        try:
            translated_texts = _translate_segments_with_openai_compatible(source_texts, runtime_settings, runtime)
        except Exception as exc:
            return self.failure(
                [str(exc)],
                {
                    "translation_provider": runtime.provider,
                    "translation_model": runtime.model,
                    "retryable": False,
                },
            )

        untranslated_ids: list[int] = []
        translated_rows = []
        for index, (seg, ja_text, en_text) in enumerate(zip(corrected, source_texts, translated_texts), start=1):
            normalized_en = normalize_spaces(en_text)
            if _looks_untranslated(ja_text, normalized_en):
                untranslated_ids.append(index)
            translated_rows.append(
                {
                    **seg,
                    "en": normalized_en,
                    "translated_text": normalized_en,
                    "translation_distance": 0.0,
                    "translation_flagged": False,
                    "translation_fallback": False,
                    "translation_provider": runtime.provider_label,
                }
            )

        if untranslated_ids:
            return self.failure(
                [f"translation output appears untranslated at segment(s): {', '.join(map(str, untranslated_ids))}"],
                {
                    "translation_provider": runtime.provider,
                    "translation_model": runtime.model,
                    "untranslated_segment_ids": untranslated_ids,
                    "retryable": False,
                },
            )

        return self.success(
            {"translated_segments": translated_rows},
            {
                "segments": len(translated_rows),
                "flagged": 0,
                "translation_provider": runtime.provider,
                "translation_model": runtime.model,
                "translation_mode": "llm-runtime-configured",
            },
        )
