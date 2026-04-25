from __future__ import annotations

import logging
import threading
from pathlib import Path
from typing import Any


log = logging.getLogger(__name__)

_MODEL_CACHE: dict[tuple[str, str, str], Any] = {}
_ALIGN_CACHE: dict[tuple[str, str], tuple[Any, Any]] = {}
_CACHE_LOCK = threading.Lock()
_CJK_LANGUAGES = {"ja", "zh", "ko"}


def transcribe_embedded(
    audio_path: Path,
    *,
    model_size: str,
    language: str,
    batch_size: int,
    compute_type: str,
    device: str,
) -> list[dict[str, Any]]:
    if not audio_path.exists():
        raise FileNotFoundError(f"音声ファイルが見つかりません: {audio_path}")

    whisperx = _load_whisperx()
    model = _get_model(whisperx=whisperx, model_size=model_size, device=device, compute_type=compute_type)
    audio = whisperx.load_audio(str(audio_path))
    result = model.transcribe(audio, batch_size=batch_size, language=language)

    try:
        align_model, metadata = _get_align_model(whisperx=whisperx, language=language, device=device)
        result = whisperx.align(
            result["segments"],
            align_model,
            metadata,
            audio,
            device,
            return_char_alignments=language in _CJK_LANGUAGES,
        )
    except Exception as exc:
        log.warning("[transcribe] embedded WhisperX alignment skipped: %s", exc)

    return _parse_whisperx_result(result)


def _get_model(*, whisperx: Any, model_size: str, device: str, compute_type: str) -> Any:
    key = (model_size, device, compute_type)
    with _CACHE_LOCK:
        model = _MODEL_CACHE.get(key)
        if model is None:
            log.info(
                "[transcribe] loading embedded WhisperX model: model=%s device=%s compute_type=%s",
                model_size,
                device,
                compute_type,
            )
            model = whisperx.load_model(
                model_size,
                device,
                compute_type=compute_type,
                vad_method="silero",
            )
            _MODEL_CACHE[key] = model
    return model


def _get_align_model(*, whisperx: Any, language: str, device: str) -> tuple[Any, Any]:
    key = (language, device)
    with _CACHE_LOCK:
        cached = _ALIGN_CACHE.get(key)
        if cached is None:
            log.info("[transcribe] loading embedded WhisperX align model: language=%s", language)
            cached = whisperx.load_align_model(language_code=language, device=device)
            _ALIGN_CACHE[key] = cached
    return cached


def _parse_whisperx_result(result: dict[str, Any]) -> list[dict[str, Any]]:
    segments: list[dict[str, Any]] = []
    for i, seg in enumerate(result.get("segments", [])):
        words = [
            {
                "word": w.get("word", w.get("char", "")),
                "start": float(w["start"]),
                "end": float(w["end"]),
                "score": float(w.get("score", 1.0)),
            }
            for w in seg.get("words", [])
            if "start" in w and "end" in w
        ]
        segments.append(
            {
                "id": i + 1,
                "start": round(float(seg["start"]), 3),
                "end": round(float(seg["end"]), 3),
                "text": seg.get("text", "").strip(),
                "ja": seg.get("text", "").strip(),
                "words": words,
            }
        )
    return segments


def _load_whisperx() -> Any:
    import whisperx

    return whisperx

