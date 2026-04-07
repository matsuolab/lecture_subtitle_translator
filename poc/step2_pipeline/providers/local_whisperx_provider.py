"""
ローカル WhisperX Provider。
RTX 4080 など CUDA 対応 GPU がある環境で直接 WhisperX を実行する。
文字レベルタイムスタンプが取得できる（パイプラインの根幹）。

OSS 配布時の推奨バックエンド。GPU 非所持ユーザーは ReplicateWhisperXProvider を使用。
"""

from __future__ import annotations

import os
from typing import Any

from ..models.segment import TranscriptSegment, WordTimestamp
from .base import TranscribeProvider


class LocalWhisperXProvider(TranscribeProvider):
    def __init__(
        self,
        model_size: str | None = None,
        device: str | None = None,
        compute_type: str | None = None,
        hf_token: str | None = None,
    ) -> None:
        self._model_size = model_size or os.getenv("WHISPERX_MODEL", "large-v3")
        self._device = device or os.getenv("WHISPERX_DEVICE", "cuda")
        self._compute_type = compute_type or os.getenv(
            "WHISPERX_COMPUTE_TYPE", "float16"
        )
        self._hf_token = hf_token or os.getenv("HF_TOKEN")
        self._model: Any = None

    def _load_model(self) -> Any:
        """遅延ロード（初回 transcribe 時のみモデルを読み込む）。"""
        if self._model is None:
            import whisperx  # type: ignore[import]

            self._model = whisperx.load_model(
                self._model_size,
                self._device,
                compute_type=self._compute_type,
            )
        return self._model

    async def transcribe(self, audio_path: str) -> list[TranscriptSegment]:
        import asyncio

        import whisperx  # type: ignore[import]

        # WhisperX は同期 API なので executor で実行
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(
            None, self._transcribe_sync, audio_path
        )

    def _transcribe_sync(self, audio_path: str) -> list[TranscriptSegment]:
        import whisperx  # type: ignore[import]

        model = self._load_model()
        audio = whisperx.load_audio(audio_path)

        # 1. 書き起こし
        result = model.transcribe(audio, batch_size=8, language="ja")

        # 2. 文字/単語レベルタイムスタンプ付与（Wav2Vec2 アライナー）
        align_model, metadata = whisperx.load_align_model(
            language_code="ja", device=self._device
        )
        result = whisperx.align(
            result["segments"],
            align_model,
            metadata,
            audio,
            self._device,
            return_char_alignments=True,
        )

        # 3. 話者分離（HF_TOKEN がある場合のみ）
        if self._hf_token:
            diarize_model = whisperx.DiarizationPipeline(
                use_auth_token=self._hf_token, device=self._device
            )
            diarize_segments = diarize_model(audio)
            result = whisperx.assign_word_speakers(diarize_segments, result)

        return self._to_segments(result["segments"])

    @staticmethod
    def _to_segments(raw_segments: list[dict]) -> list[TranscriptSegment]:
        segments: list[TranscriptSegment] = []
        for i, seg in enumerate(raw_segments):
            words = tuple(
                WordTimestamp(
                    word=w.get("word", w.get("char", "")),
                    start=w.get("start", seg["start"]),
                    end=w.get("end", seg["end"]),
                    confidence=w.get("score", 1.0),
                )
                for w in seg.get("words", seg.get("chars", []))
            )
            segments.append(
                TranscriptSegment(
                    id=i,
                    start=seg["start"],
                    end=seg["end"],
                    text=seg["text"].strip(),
                    words=words,
                )
            )
        return segments
