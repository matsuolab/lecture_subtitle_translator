from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
import tempfile
import threading
import time
import uuid
from pathlib import Path

from .base import BaseStubNode
from .text_utils import split_ja_sentences
from ..contracts import RunState

_VIDEO_EXTENSIONS = {".mp4", ".mov", ".mkv", ".webm"}
_AUDIO_EXTENSIONS = {".mp3", ".wav", ".m4a", ".flac", ".ogg"}
_NO_MODEL_TAGS: frozenset[str] = frozenset({"no_model", "latest"})

log = logging.getLogger(__name__)


class TranscribeNode(BaseStubNode):
    provider = "deterministic-local"
    model = "transcribe-v3"

    def run(self, state: RunState):
        execution_mode = str(state.data.get("execution_mode", "production")).lower()
        allow_fallback = bool(state.data.get("allow_transcribe_fallback", False)) or execution_mode == "dev"

        seeded = state.data.get("seed_transcript_segments")
        if isinstance(seeded, list) and seeded:
            segments = []
            for i, row in enumerate(seeded, start=1):
                segments.append(
                    {
                        "id": int(row.get("id", i)),
                        "start": float(row.get("start", 0.0)),
                        "end": float(row.get("end", 0.0)),
                        "text": str(row.get("text") or row.get("ja") or ""),
                        "ja": str(row.get("text") or row.get("ja") or ""),
                    }
                )
            self.provider = "seeded-input"
            self.model = "seeded-segments"
            return self.success({"transcript_segments": segments}, {"segments": len(segments), "seeded": True})

        audio_path = state.data.get("audio_path")
        strict_external = bool(state.data.get("strict_external_whisperx", execution_mode != "dev"))

        if audio_path:
            runtime_settings = state.data.get("runtime_settings") or {}
            image = str(
                runtime_settings.get("whisperx_docker_image")
                or os.getenv("WHISPERX_DOCKER_IMAGE", "ghcr.io/jim60105/whisperx:large-v3-ja")
            )
            hf_token = str(runtime_settings.get("hf_token") or os.getenv("HF_TOKEN", ""))
            batch_size = int(os.getenv("WHISPERX_BATCH_SIZE", "8"))
            compute_type = str(os.getenv("WHISPERX_COMPUTE_TYPE", "float16"))
            cache_volume = str(os.getenv("WHISPERX_CACHE_VOLUME", "whisperx_hf_cache"))
            timeout = int(os.getenv("WHISPERX_TIMEOUT", "3600"))
            model_size = str(os.getenv("WHISPERX_MODEL", "large-v3"))
            language = str(os.getenv("WHISPERX_LANGUAGE", "ja"))

            log.info("[transcribe] Docker WhisperX 開始: image=%s audio=%s", image, audio_path)
            t0 = time.perf_counter()
            try:
                segments = _run_docker_whisperx(
                    audio_path=Path(str(audio_path)),
                    image=image,
                    hf_token=hf_token,
                    batch_size=batch_size,
                    compute_type=compute_type,
                    cache_volume=cache_volume,
                    timeout=timeout,
                    model_size=model_size,
                    language=language,
                )
                elapsed = time.perf_counter() - t0
                self.provider = "docker-whisperx"
                self.model = image.split(":")[-1] if ":" in image else image
                log.info("[transcribe] 完了: segments=%d elapsed=%.1fs", len(segments), elapsed)
                return self.success(
                    {"transcript_segments": segments},
                    {"segments": len(segments), "seeded": False, "external_used": True, "audio_path": str(audio_path)},
                )
            except Exception as exc:
                elapsed = time.perf_counter() - t0
                log.error("[transcribe] 失敗 (%.1fs): %s", elapsed, exc)
                if strict_external or not allow_fallback:
                    self.provider = "docker-whisperx"
                    self.model = image.split(":")[-1] if ":" in image else image
                    return self.failure([f"docker whisperx failed: {exc}"], {"external_used": True})

        if not allow_fallback:
            return self.failure(["audio_path is required for production transcription"], {"external_used": False})

        transcript_text = str(state.data.get("transcript_text", "")).strip()
        source_name = str(state.data.get("source_name", "unknown.mp4"))
        if not transcript_text:
            transcript_text = f"{source_name} を書き起こします。DAGノードで実処理を行います。"

        sentences = split_ja_sentences(transcript_text)
        if not sentences:
            sentences = [transcript_text]

        total_chars = max(1, sum(len(s) for s in sentences))
        total_duration = float(state.data.get("source_duration_sec", max(6.0, len(sentences) * 2.8)))

        segments = []
        cursor = 0.0
        for i, sentence in enumerate(sentences, start=1):
            ratio = len(sentence) / total_chars
            duration = max(0.7, total_duration * ratio)
            start = round(cursor, 3)
            end = round(cursor + duration, 3)
            cursor = end
            segments.append(
                {
                    "id": i,
                    "start": start,
                    "end": end,
                    "text": sentence,
                    "ja": sentence,
                }
            )

        avg_chars = round(total_chars / len(segments), 2)
        self.provider = "deterministic-local"
        self.model = "transcribe-fallback"
        return self.success(
            {"transcript_segments": segments},
            {"segments": len(segments), "avg_chars": avg_chars, "seeded": False, "external_used": False},
        )


# ---------------------------------------------------------------------------
# Docker CLI WhisperX 実行
# ---------------------------------------------------------------------------

def _run_docker_streaming(cmd: list[str], timeout: int) -> int:
    """
    docker run をリアルタイムでログ出力しながら実行する。

    stdout / stderr をそれぞれ別スレッドで読み取り、
    1行ごとに log.info / log.warning に流す。
    """
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )

    def _reader(pipe: object, level: int) -> None:
        assert hasattr(pipe, "readline")
        for raw_line in iter(pipe.readline, b""):  # type: ignore[arg-type]
            line = raw_line.decode("utf-8", errors="replace").rstrip()
            if line:
                log.log(level, "[docker] %s", line)
        pipe.close()  # type: ignore[union-attr]

    t_out = threading.Thread(target=_reader, args=(proc.stdout, logging.INFO), daemon=True)
    t_err = threading.Thread(target=_reader, args=(proc.stderr, logging.WARNING), daemon=True)
    t_out.start()
    t_err.start()

    try:
        proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()
        raise RuntimeError(f"docker run がタイムアウトしました ({timeout}s)")
    finally:
        t_out.join(timeout=5)
        t_err.join(timeout=5)

    return proc.returncode


def _is_no_model_tag(image: str) -> bool:
    tag = image.split(":")[-1] if ":" in image else ""
    return tag in _NO_MODEL_TAGS


def _to_docker_path(path: Path) -> str:
    """Windows の絶対パスを Docker ボリュームマウントで使える形式に変換する。"""
    return str(path).replace("\\", "/")


def _run_docker_whisperx(
    *,
    audio_path: Path,
    image: str,
    hf_token: str,
    batch_size: int,
    compute_type: str,
    cache_volume: str,
    timeout: int,
    model_size: str,
    language: str,
) -> list[dict]:
    """
    docker run で jim60105/docker-whisperX を実行し、JSON 出力を返す。

    - --output_format json で単語レベルのタイムスタンプを取得
    - --return_char_alignments で日本語の文字レベルタイムスタンプを取得
    - 日本語ファイル名対策として ASCII 名の一時ファイルにコピーして処理
    """
    if not audio_path.exists():
        raise FileNotFoundError(f"音声ファイルが見つかりません: {audio_path}")

    with tempfile.TemporaryDirectory() as tmp_input:
        safe_stem = f"audio_{uuid.uuid4().hex[:8]}"
        safe_audio = Path(tmp_input) / f"{safe_stem}{audio_path.suffix}"
        shutil.copy2(audio_path, safe_audio)

        with tempfile.TemporaryDirectory() as tmp_output:
            input_mount = _to_docker_path(Path(tmp_input))
            output_mount = _to_docker_path(Path(tmp_output))

            cmd = [
                "docker", "run", "--gpus", "all", "--rm",
                "-v", f"{input_mount}:/app/input:ro",
                "-v", f"{output_mount}:/app/output",
                "-v", f"{cache_volume}:/.cache",
                "-e", f"HF_TOKEN={hf_token}",
                "-e", "LC_ALL=C",
                "-e", "LC_CTYPE=C",
                "--hostname", "whisperx-worker",
                image,
                "--",
                "--output_format", "json",
                "--output_dir", "/app/output",
                "--batch_size", str(batch_size),
                "--compute_type", compute_type,
                "--vad_method", "silero",
                "--return_char_alignments",
                f"/app/input/{safe_audio.name}",
            ]

            # no_model / latest タグは ENTRYPOINT に --model / --language が含まれないため明示指定
            if _is_no_model_tag(image):
                cmd.extend(["--model", model_size, "--language", language])

            if hf_token:
                cmd.extend(["--hf_token", hf_token])

            returncode = _run_docker_streaming(cmd, timeout=timeout)
            if returncode != 0:
                raise RuntimeError(f"docker-whisperX が終了コード {returncode} で失敗しました。")

            json_path = Path(tmp_output) / f"{safe_stem}.json"
            if not json_path.exists():
                raise FileNotFoundError(
                    f"WhisperX の JSON 出力が見つかりません: {json_path}\n"
                    "docker run は成功しましたが出力ファイルが生成されていない可能性があります。"
                )

            with open(json_path, encoding="utf-8") as f:
                data = json.load(f)

    return _parse_whisperx_json(data)


def _parse_whisperx_json(data: dict) -> list[dict]:
    """
    WhisperX の --output_format json 出力を list[dict] に変換する。

    注意:
    - words[].start / end / score はアライメント失敗時に省略される（NaN→フィールド欠損）
    - start/end が欠損している単語はスキップする
    """
    segments: list[dict] = []
    for i, seg in enumerate(data.get("segments", [])):
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
