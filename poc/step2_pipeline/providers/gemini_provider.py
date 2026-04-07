"""
Gemini Provider 実装（google-genai SDK v1.x）。
- LLM:       gemini-2.5-flash（デフォルト）または環境変数で切り替え
- Embedding: gemini-embedding-001
- Transcribe: 非対応（WhisperXには対応していないため）
"""

from __future__ import annotations

import os

from google import genai
from google.genai import types

from ..models.segment import TranscriptSegment
from .base import EmbedProvider, LLMProvider, TranscribeProvider


def _make_client(api_key: str | None) -> genai.Client:
    key = api_key or os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")
    return genai.Client(api_key=key)


class GeminiLLMProvider(LLMProvider):
    def __init__(self, model: str | None = None, api_key: str | None = None) -> None:
        super().__init__()
        self._model_name = model or os.getenv("GEMINI_LLM_MODEL", "gemini-2.5-flash")
        self._client = _make_client(api_key)

    def model_name(self) -> str:
        return self._model_name

    async def complete(
        self,
        messages: list[dict[str, str]],
        temperature: float = 0.3,
        max_tokens: int = 4096,
    ) -> str:
        system_parts = [m["content"] for m in messages if m["role"] == "system"]
        user_parts   = [m["content"] for m in messages if m["role"] != "system"]

        config = types.GenerateContentConfig(
            temperature=temperature,
            max_output_tokens=max_tokens,
            system_instruction="\n\n".join(system_parts) if system_parts else None,
        )

        response = await self._client.aio.models.generate_content(
            model=self._model_name,
            contents="\n\n".join(user_parts),
            config=config,
        )

        if response.usage_metadata:
            self._record_usage(
                tokens_in=response.usage_metadata.prompt_token_count or 0,
                tokens_out=response.usage_metadata.candidates_token_count or 0,
            )

        if response.text is None:
            # 安全フィルターや finish_reason によりテキストが生成されなかった場合
            candidates = response.candidates or []
            finish_reasons = [str(c.finish_reason) for c in candidates]
            raise ValueError(
                f"Gemini がテキストを返しませんでした（finish_reason: {finish_reasons}）。"
                "安全フィルターによるブロックの可能性があります。"
            )

        return response.text


class GeminiEmbedProvider(EmbedProvider):
    def __init__(self, model: str | None = None, api_key: str | None = None) -> None:
        super().__init__()
        self._model_name = model or os.getenv(
            "GEMINI_EMBED_MODEL", "gemini-embedding-001"
        )
        self._client = _make_client(api_key)

    def model_name(self) -> str:
        return self._model_name

    def dimensions(self) -> int:
        return 768  # gemini-embedding-001 推奨サイズ

    async def embed(self, text: str) -> list[float]:
        response = await self._client.aio.models.embed_content(
            model=self._model_name,
            contents=text,
            config=types.EmbedContentConfig(task_type="SEMANTIC_SIMILARITY"),
        )
        # Gemini Embedding API はトークン数を返さないため文字数で近似
        self._record_usage(tokens_in=len(text) // 4)
        return list(response.embeddings[0].values)


class GeminiTranscribeProvider(TranscribeProvider):
    """Gemini は音声書き起こし（WhisperX相当）に対応していないため未実装。"""

    async def transcribe(self, audio_path: str) -> list[TranscriptSegment]:
        raise NotImplementedError(
            "GeminiTranscribeProvider は未対応です。"
            "DockerCLIWhisperXProvider または OpenAITranscribeProvider を使用してください。"
        )
