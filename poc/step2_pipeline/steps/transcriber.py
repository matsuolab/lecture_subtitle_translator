"""
Step 2: 音声ファイルを WhisperX で書き起こす。
Provider の実装（ローカル / Replicate / OpenAI）は呼び出し側が選択する。
"""

from __future__ import annotations

from ..models.segment import TranscriptSegment
from ..providers.base import TranscribeProvider


async def transcribe(
    audio_path: str,
    provider: TranscribeProvider,
) -> list[TranscriptSegment]:
    """
    音声ファイルを書き起こしてセグメントリストを返す。

    Args:
        audio_path: WAV ファイルパス（extract_audio の出力）
        provider:   TranscribeProvider の実装インスタンス

    Returns:
        TranscriptSegment のリスト（時系列順）
    """
    segments = await provider.transcribe(audio_path)

    if not segments:
        raise ValueError(f"書き起こし結果が空です: {audio_path}")

    return segments
