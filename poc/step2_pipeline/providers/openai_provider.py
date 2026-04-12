"""
OpenAI Provider 実装。
- LLM:       gpt-4.1-mini（デフォルト）または環境変数で切り替え
- Embedding: text-embedding-3-small（デフォルト）
- Transcribe: Whisper API（文字レベルTSなし。ローカルWhisperXとの差を意識）
"""

from __future__ import annotations

import json
import os
from pathlib import Path

from openai import AsyncOpenAI

from ..models.segment import TranscriptSegment, WordTimestamp
from .base import EmbedProvider, LLMProvider, TranscribeProvider


class OpenAILLMProvider(LLMProvider):
    def __init__(self, model: str | None = None, api_key: str | None = None) -> None:
        super().__init__()
        self._model = model or os.getenv("OPENAI_LLM_MODEL", "gpt-4.1-mini")
        self._client = AsyncOpenAI(api_key=api_key or os.getenv("OPENAI_API_KEY"))

    def model_name(self) -> str:
        return self._model

    async def complete(
        self,
        messages: list[dict[str, str]],
        temperature: float = 0.3,
        max_tokens: int = 4096,
    ) -> str:
        response = await self._client.chat.completions.create(
            model=self._model,
            messages=messages,  # type: ignore[arg-type]
            temperature=temperature,
            max_completion_tokens=max_tokens,
        )
        if response.usage:
            self._record_usage(
                tokens_in=response.usage.prompt_tokens,
                tokens_out=response.usage.completion_tokens,
            )
        content = response.choices[0].message.content
        if content is None:
            raise ValueError("OpenAI returned empty content")
        return content


class OpenAIEmbedProvider(EmbedProvider):
    def __init__(self, model: str | None = None, api_key: str | None = None) -> None:
        super().__init__()
        self._model = model or os.getenv(
            "OPENAI_EMBED_MODEL", "text-embedding-3-small"
        )
        self._client = AsyncOpenAI(api_key=api_key or os.getenv("OPENAI_API_KEY"))

    def model_name(self) -> str:
        return self._model

    def dimensions(self) -> int:
        # text-embedding-3-small: 1536, text-embedding-3-large: 3072
        return 3072 if "large" in self._model else 1536

    async def embed(self, text: str) -> list[float]:
        response = await self._client.embeddings.create(
            model=self._model,
            input=text,
        )
        if response.usage:
            self._record_usage(tokens_in=response.usage.prompt_tokens)
        return response.data[0].embedding


class OpenAITranscribeProvider(TranscribeProvider):
    """
    OpenAI Whisper API を使った書き起こし。
    注意: 文字レベルタイムスタンプは取得できない。
    精度が必要な場合は LocalWhisperXProvider を使うこと。
    """

    def __init__(self, api_key: str | None = None) -> None:
        self._client = AsyncOpenAI(api_key=api_key or os.getenv("OPENAI_API_KEY"))

    async def transcribe(self, audio_path: str) -> list[TranscriptSegment]:
        with open(audio_path, "rb") as f:
            response = await self._client.audio.transcriptions.create(
                model="whisper-1",
                file=f,
                response_format="verbose_json",
                timestamp_granularities=["segment", "word"],
                language="ja",
            )

        segments: list[TranscriptSegment] = []
        for i, seg in enumerate(response.segments or []):
            words = tuple(
                WordTimestamp(
                    word=w.word,
                    start=w.start,
                    end=w.end,
                    confidence=getattr(w, "probability", 1.0),
                )
                for w in (seg.words or [])
            )
            segments.append(
                TranscriptSegment(
                    id=i,
                    start=seg.start,
                    end=seg.end,
                    text=seg.text.strip(),
                    words=words,
                )
            )
        return segments
