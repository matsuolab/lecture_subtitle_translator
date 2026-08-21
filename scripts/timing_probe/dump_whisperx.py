"""WhisperX の生タイムスタンプを保存するプローブスクリプト。

本番パイプライン (backend/pipeline/nodes/extract_audio.py, transcribe.py) と
**完全に同一の ffmpeg / docker 引数**で WhisperX を実行し、通常は一時ディレクトリ
ごと破棄される生の JSON 出力を捨てずに保存する。

引数の一致箇所:
- ffmpeg コマンド: backend/pipeline/nodes/extract_audio.py の 68-81 行目と同一
- docker run コマンド: backend/pipeline/nodes/transcribe.py の
  ``_run_docker_whisperx()`` (217-289 行目) と同一

使い方:
    python scripts/timing_probe/dump_whisperx.py <video_path> [--outdir DIR] [--force]

出力:
    <outdir>/extracted_audio.wav  ffmpeg で抽出した音声（本番は一時ファイルで破棄される）
    <outdir>/whisperx_raw.json    WhisperX の生 JSON 出力（無加工）
    <outdir>/whisperx_meta.json   実行時の image / 引数 / 実行時刻 / 経過秒
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger(__name__)

_DEFAULT_OUTDIR = Path(__file__).resolve().parent / "out"
_DEFAULT_IMAGE = "ghcr.io/jim60105/whisperx:large-v3-ja"
_NO_MODEL_TAGS: frozenset[str] = frozenset({"no_model", "latest"})


# ---------------------------------------------------------------------------
# ffmpeg 音声抽出
# (backend/pipeline/nodes/extract_audio.py 68-81 行目と完全に同一の引数)
# ---------------------------------------------------------------------------


def extract_audio(source_path: Path, target_audio: Path) -> None:
    """ffmpeg で音声を抽出する。本番の ExtractAudioNode.run() と同一コマンド。"""
    ffmpeg_bin = shutil.which("ffmpeg")
    if not ffmpeg_bin:
        raise RuntimeError("ffmpeg not found in PATH")

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
    log.info("[ffmpeg] 抽出開始: %s -> %s", source_path, target_audio)
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=60 * 30)
    if proc.returncode != 0:
        err = proc.stderr.strip() or proc.stdout.strip() or f"ffmpeg exit code={proc.returncode}"
        raise RuntimeError(f"audio extraction failed: {err}")

    if not target_audio.exists() or target_audio.stat().st_size == 0:
        raise RuntimeError(f"audio extraction produced no file: {target_audio}")

    log.info("[ffmpeg] 完了: %s (%d bytes)", target_audio, target_audio.stat().st_size)


# ---------------------------------------------------------------------------
# docker CLI WhisperX 実行
# (backend/pipeline/nodes/transcribe.py の _run_docker_whisperx() 217-289 行目と
#  完全に同一の引数構成。本番と異なるのは出力 JSON を破棄せず保存する点のみ)
# ---------------------------------------------------------------------------


def _to_docker_path(path: Path) -> str:
    """Windows の絶対パスを Docker ボリュームマウントで使える形式に変換する。"""
    return str(path).replace("\\", "/")


def _is_no_model_tag(image: str) -> bool:
    tag = image.split(":")[-1] if ":" in image else ""
    return tag in _NO_MODEL_TAGS


def _run_docker_streaming(cmd: list[str], timeout: int) -> int:
    """docker run をリアルタイムでログ出力しながら実行する。"""
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

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


def run_docker_whisperx_probe(
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
    rescue_dir: Path,
) -> tuple[dict, list[str]]:
    """docker run で WhisperX を実行し、生 JSON (dict) とマスク済みコマンドを返す。

    本番の _run_docker_whisperx() とコマンド構成は完全に同一。違いは出力先を
    tempfile.TemporaryDirectory ではなく永続ディレクトリ (rescue_dir) にして、
    生成された JSON をそのまま読み出せるようにしている点のみ。
    """
    if not audio_path.exists():
        raise FileNotFoundError(f"音声ファイルが見つかりません: {audio_path}")

    rescue_dir.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory() as tmp_input:
        # 日本語ファイル名対策で ASCII 名の一時ファイルにコピーする点も本番と同一
        safe_stem = f"audio_{uuid.uuid4().hex[:8]}"
        safe_audio = Path(tmp_input) / f"{safe_stem}{audio_path.suffix}"
        shutil.copy2(audio_path, safe_audio)

        input_mount = _to_docker_path(Path(tmp_input))
        output_mount = _to_docker_path(rescue_dir)

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

        masked_cmd = [
            (f"HF_TOKEN={'***' if hf_token else ''}" if c.startswith("HF_TOKEN=") else c)
            for c in cmd
        ]
        if hf_token and "--hf_token" in masked_cmd:
            idx = masked_cmd.index("--hf_token")
            masked_cmd[idx + 1] = "***"

        log.info("[docker] 実行コマンド: %s", " ".join(masked_cmd))
        returncode = _run_docker_streaming(cmd, timeout=timeout)
        if returncode != 0:
            raise RuntimeError(f"docker-whisperX が終了コード {returncode} で失敗しました。")

        json_path = rescue_dir / f"{safe_stem}.json"
        if not json_path.exists():
            raise FileNotFoundError(
                f"WhisperX の JSON 出力が見つかりません: {json_path}\n"
                "docker run は成功しましたが出力ファイルが生成されていない可能性があります。"
            )

        with open(json_path, encoding="utf-8") as f:
            data = json.load(f)

    return data, masked_cmd


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "本番パイプラインと同一設定で WhisperX を実行し、生の JSON 出力を保存する"
            "（WhisperX 生タイムスタンプ検証用プローブ）。"
        )
    )
    parser.add_argument("video", type=Path, help="入力動画（または音声）ファイルパス")
    parser.add_argument(
        "--outdir",
        type=Path,
        default=_DEFAULT_OUTDIR,
        help=f"出力ディレクトリ (default: {_DEFAULT_OUTDIR})",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="既に whisperx_raw.json が存在していても再実行する",
    )
    parser.add_argument(
        "--image",
        default=None,
        help="WhisperX docker image を上書き (default: env WHISPERX_DOCKER_IMAGE または本番デフォルト)",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _build_arg_parser().parse_args(argv)

    # docker のボリュームマウントは絶対パス必須（相対パスは volume 名と誤認され exit 125）。
    # 本番の _run_docker_whisperx は TemporaryDirectory で常に絶対パスのため顕在化しない。
    outdir: Path = args.outdir.resolve()
    outdir.mkdir(parents=True, exist_ok=True)
    raw_json_path = outdir / "whisperx_raw.json"
    meta_path = outdir / "whisperx_meta.json"

    if raw_json_path.exists() and not args.force:
        log.info("[skip] 既存の %s を再利用します (--force で再実行)", raw_json_path)
        return 0

    source_path: Path = args.video
    if not source_path.exists():
        log.error("動画/音声ファイルが見つかりません: %s", source_path)
        return 1

    # --- 1. 音声抽出 (extract_audio.py と同一コマンド) ---
    extracted_audio = outdir / "extracted_audio.wav"
    extract_audio(source_path, extracted_audio)

    # --- 2. WhisperX 実行パラメータ (transcribe.py の env 読み取りと同一デフォルト) ---
    image = args.image or os.getenv("WHISPERX_DOCKER_IMAGE", "").strip() or _DEFAULT_IMAGE
    hf_token = os.getenv("HF_TOKEN", "")
    batch_size = int(os.getenv("WHISPERX_BATCH_SIZE", "8"))
    compute_type = os.getenv("WHISPERX_COMPUTE_TYPE", "float16")
    cache_volume = os.getenv("WHISPERX_CACHE_VOLUME", "whisperx_hf_cache")
    timeout = int(os.getenv("WHISPERX_TIMEOUT", "3600"))
    model_size = os.getenv("WHISPERX_MODEL", "large-v3")
    language = os.getenv("WHISPERX_LANGUAGE", "ja")

    rescue_dir = outdir / "_docker_output"
    started_at = datetime.now(timezone.utc)
    t0 = time.perf_counter()
    log.info("[whisperx] 開始: image=%s audio=%s", image, extracted_audio)
    data, masked_cmd = run_docker_whisperx_probe(
        audio_path=extracted_audio,
        image=image,
        hf_token=hf_token,
        batch_size=batch_size,
        compute_type=compute_type,
        cache_volume=cache_volume,
        timeout=timeout,
        model_size=model_size,
        language=language,
        rescue_dir=rescue_dir,
    )
    elapsed = time.perf_counter() - t0
    log.info("[whisperx] 完了: elapsed=%.1fs segments=%d", elapsed, len(data.get("segments", [])))

    # --- 3. 保存 ---
    with open(raw_json_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

    meta = {
        "video": str(source_path),
        "extracted_audio": str(extracted_audio),
        "image": image,
        "batch_size": batch_size,
        "compute_type": compute_type,
        "cache_volume": cache_volume,
        "timeout_sec": timeout,
        "model_size": model_size,
        "language": language,
        "hf_token_present": bool(hf_token),
        "docker_cmd": masked_cmd,
        "started_at": started_at.isoformat(),
        "elapsed_sec": round(elapsed, 2),
        "segments": len(data.get("segments", [])),
    }
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)

    log.info("[done] %s / %s", raw_json_path, meta_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
