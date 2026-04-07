from __future__ import annotations

import shutil
import subprocess
import tempfile
from pathlib import Path

from .base import BaseStubNode
from ..contracts import RunState

_VIDEO_EXTENSIONS = {".mp4", ".mov", ".mkv", ".webm"}
_AUDIO_EXTENSIONS = {".mp3", ".wav", ".m4a", ".flac"}


class ExtractAudioNode(BaseStubNode):
    provider = "ffmpeg-local"
    model = "ffmpeg-pcm16le"

    def run(self, state: RunState):
        execution_mode = str(state.data.get("execution_mode", "production")).lower()
        allow_fallback = bool(state.data.get("allow_transcribe_fallback", False)) or execution_mode == "dev"
        source_media_path = state.data.get("source_media_path") or state.data.get("audio_path")

        if not source_media_path:
            if allow_fallback:
                return self.success(
                    {
                        "audio_path": None,
                        "source_media_kind": "synthetic",
                        "audio_extraction_skipped": True,
                    },
                    {"source_media_kind": "synthetic", "extracted": False, "fallback_allowed": True},
                )
            return self.failure(["source media path is required before transcription"], {"stage": "extract_audio"})

        source_path = Path(str(source_media_path))
        if not source_path.exists():
            return self.failure([f"source media not found: {source_path}"], {"stage": "extract_audio"})

        suffix = source_path.suffix.lower()
        if suffix in _AUDIO_EXTENSIONS:
            return self.success(
                {
                    "audio_path": str(source_path),
                    "source_media_kind": "audio",
                    "audio_extraction_skipped": True,
                },
                {
                    "source_media_kind": "audio",
                    "audio_path": str(source_path),
                    "extracted": False,
                },
            )

        if suffix not in _VIDEO_EXTENSIONS:
            return self.failure([f"unsupported media type for audio extraction: {suffix or 'unknown'}"], {"stage": "extract_audio"})

        ffmpeg_bin = shutil.which("ffmpeg")
        if not ffmpeg_bin:
            return self.failure(["ffmpeg not found in PATH"], {"stage": "extract_audio"})

        run_dir = Path(tempfile.gettempdir()) / "matsuo-subtitle-pipeline" / state.run_id
        run_dir.mkdir(parents=True, exist_ok=True)
        target_audio = run_dir / f"{source_path.stem}.wav"
        if target_audio.exists():
            target_audio.unlink()

        cmd = [
            ffmpeg_bin,
            "-y",
            "-i",
            str(source_path),
            "-vn",
            "-acodec",
            "pcm_s16le",
            "-ar",
            "16000",
            "-ac",
            "1",
            str(target_audio),
        ]
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=60 * 30)
        if proc.returncode != 0:
            err = proc.stderr.strip() or proc.stdout.strip() or f"ffmpeg exit code={proc.returncode}"
            return self.failure([f"audio extraction failed: {err}"], {"stage": "extract_audio", "source_media_kind": "video"})

        if not target_audio.exists() or target_audio.stat().st_size == 0:
            return self.failure([f"audio extraction produced no file: {target_audio}"], {"stage": "extract_audio", "source_media_kind": "video"})

        return self.success(
            {
                "audio_path": str(target_audio),
                "source_media_kind": "video",
                "audio_extraction_skipped": False,
            },
            {
                "source_media_kind": "video",
                "audio_path": str(target_audio),
                "extracted": True,
                "size_bytes": target_audio.stat().st_size,
            },
        )
