"""
Step 1: 動画ファイルから音声を抽出する。
FFmpeg を使って WAV（16kHz, mono）に変換する。
WhisperX が推奨する形式に合わせる。
"""

from __future__ import annotations

import asyncio
import os
from pathlib import Path


async def extract_audio(video_path: str, output_dir: str | None = None) -> str:
    """
    動画ファイルから音声を抽出して WAV ファイルパスを返す。

    Args:
        video_path: 入力動画ファイルパス（mp4, mkv, mov 等）
        output_dir: 出力先ディレクトリ（省略時は動画と同じディレクトリ）

    Returns:
        出力 WAV ファイルの絶対パス

    Raises:
        FileNotFoundError: 入力ファイルが存在しない
        RuntimeError: FFmpeg の実行に失敗した
    """
    video_path = str(Path(video_path).resolve())
    if not os.path.exists(video_path):
        raise FileNotFoundError(f"動画ファイルが見つかりません: {video_path}")

    stem = Path(video_path).stem
    out_dir = output_dir or str(Path(video_path).parent)
    os.makedirs(out_dir, exist_ok=True)
    wav_path = str(Path(out_dir) / f"{stem}.wav")

    cmd = [
        "ffmpeg",
        "-y",                   # 上書き許可
        "-i", video_path,
        "-vn",                  # 映像ストリームを無効化
        "-acodec", "pcm_s16le", # 16bit PCM
        "-ar", "16000",         # 16kHz（WhisperX 推奨）
        "-ac", "1",             # モノラル
        wav_path,
    ]

    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    _, stderr = await proc.communicate()

    if proc.returncode != 0:
        raise RuntimeError(
            f"FFmpeg が失敗しました (code={proc.returncode}):\n"
            f"{stderr.decode('utf-8', errors='replace')}"
        )

    return wav_path
