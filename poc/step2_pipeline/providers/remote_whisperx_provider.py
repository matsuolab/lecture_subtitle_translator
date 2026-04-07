"""
リモート WhisperX サーバー Provider。
既に起動済みの WhisperX サーバー（OpenAI互換API）に HTTP でアクセスする。

pyvideotrans の設計を踏襲:
  サーバー: http://<host>:<port>  （例: http://127.0.0.1:9092）
  エンドポイント: POST /v1/audio/transcriptions

WHISPERX_BACKEND=remote が主バックエンド想定。
"""

from __future__ import annotations

import os
from pathlib import Path

from openai import AsyncOpenAI

from ..models.segment import TranscriptSegment, WordTimestamp
from .base import TranscribeProvider


class RemoteWhisperXProvider(TranscribeProvider):
    def __init__(
        self,
        base_url: str | None = None,
        api_key: str | None = None,
        language: str = "ja",
    ) -> None:
        url = base_url or os.getenv("WHISPERX_SERVER_URL", "http://127.0.0.1:9092")
        # OpenAI SDK の base_url は /v1 まで含める
        if not url.endswith("/v1"):
            url = url.rstrip("/") + "/v1"

        self._client = AsyncOpenAI(
            base_url=url,
            api_key=api_key or os.getenv("WHISPERX_API_KEY", "dummy"),
        )
        self._language = language

    async def transcribe(self, audio_path: str) -> list[TranscriptSegment]:
        with open(audio_path, "rb") as f:
            response = await self._client.audio.transcriptions.create(
                model="whisperx",           # サーバー側で無視される場合が多いが必須フィールド
                file=f,
                response_format="verbose_json",
                timestamp_granularities=["segment", "word"],
                language=self._language,
            )

        segments: list[TranscriptSegment] = []
        for i, seg in enumerate(response.segments or []):
            words = tuple(
                WordTimestamp(
                    word=w.word,
                    start=float(w.start),
                    end=float(w.end),
                    confidence=getattr(w, "probability", getattr(w, "score", 1.0)),
                )
                for w in (seg.words or [])
            )
            segments.append(
                TranscriptSegment(
                    id=i,
                    start=float(seg.start),
                    end=float(seg.end),
                    text=seg.text.strip(),
                    words=words,
                )
            )

        if not segments:
            raise ValueError(
                f"サーバーからの書き起こし結果が空でした: {audio_path}\n"
                f"サーバーURL: {self._client.base_url}"
            )

        return segments
