"""
共通テスト fixtures と Mock Provider。
"""

from __future__ import annotations

import pytest

from ..models.segment import TranscriptSegment, WordTimestamp
from ..providers.base import EmbedProvider, LLMProvider, TranscribeProvider


# ---------------------------------------------------------------------------
# Mock Providers
# ---------------------------------------------------------------------------

class MockLLMProvider(LLMProvider):
    """固定レスポンスを順番に返す LLM モック。"""

    def __init__(self, responses: list[str]) -> None:
        self._responses = list(responses)
        self._index = 0
        self.calls: list[list[dict]] = []  # 呼び出し記録

    async def complete(
        self,
        messages: list[dict[str, str]],
        temperature: float = 0.3,
        max_tokens: int = 4096,
    ) -> str:
        self.calls.append(messages)
        if self._index >= len(self._responses):
            raise ValueError(
                f"MockLLMProvider: レスポンスが不足しています "
                f"(index={self._index}, total={len(self._responses)})"
            )
        response = self._responses[self._index]
        self._index += 1
        return response

    def model_name(self) -> str:
        return "mock-llm"


class MockEmbedProvider(EmbedProvider):
    """
    固定のコサイン距離を返す Embedding モック。

    1回目の embed() は基準ベクトル [1, 0, 0, ...] を返す。
    2回目以降は指定した distance になるベクトルを返す。
    これにより cosine_distance(vec1, vec2) == distance になる。
    """

    def __init__(self, distance: float = 0.05) -> None:
        self._distance = distance
        self.calls: list[str] = []
        self._call_count = 0

    async def embed(self, text: str) -> list[float]:
        import math
        self.calls.append(text)
        self._call_count += 1

        if self._call_count % 2 == 1:
            # 奇数回目: 基準ベクトル [1, 0, 0, ...]
            return [1.0] + [0.0] * 1535
        else:
            # 偶数回目: distance になるベクトル [cos θ, sin θ, 0, ...]
            cos_theta = 1.0 - self._distance
            sin_theta = math.sqrt(max(0.0, 1.0 - cos_theta ** 2))
            return [cos_theta, sin_theta] + [0.0] * 1534

    def dimensions(self) -> int:
        return 1536

    def model_name(self) -> str:
        return "mock-embed"


class MockTranscribeProvider(TranscribeProvider):
    """固定セグメントリストを返す Transcribe モック。"""

    def __init__(self, segments: list[TranscriptSegment]) -> None:
        self._segments = segments

    async def transcribe(self, audio_path: str) -> list[TranscriptSegment]:
        return self._segments


# ---------------------------------------------------------------------------
# 共通テストデータ fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def sample_words() -> tuple[WordTimestamp, ...]:
    return (
        WordTimestamp(word="This",   start=0.0,  end=0.3,  confidence=0.99),
        WordTimestamp(word="is",     start=0.3,  end=0.5,  confidence=0.99),
        WordTimestamp(word="a",      start=0.5,  end=0.6,  confidence=0.99),
        WordTimestamp(word="test",   start=0.6,  end=1.0,  confidence=0.99),
        WordTimestamp(word="of",     start=1.0,  end=1.2,  confidence=0.99),
        WordTimestamp(word="neural", start=1.2,  end=1.7,  confidence=0.98),
        WordTimestamp(word="networks", start=1.7, end=2.3, confidence=0.98),
    )


@pytest.fixture
def sample_segment(sample_words) -> TranscriptSegment:
    return TranscriptSegment(
        id=0,
        start=0.0,
        end=2.3,
        text="This is a test of neural networks",
        words=sample_words,
    )


@pytest.fixture
def multi_segments() -> list[TranscriptSegment]:
    return [
        TranscriptSegment(
            id=0, start=0.0, end=3.0,
            text="ニューラルネットワークについて説明します",
            words=(
                WordTimestamp(word="ニューラル", start=0.0, end=1.0, confidence=0.95),
                WordTimestamp(word="ネットワーク", start=1.0, end=2.0, confidence=0.95),
                WordTimestamp(word="について", start=2.0, end=2.5, confidence=0.98),
                WordTimestamp(word="説明します", start=2.5, end=3.0, confidence=0.98),
            ),
        ),
        TranscriptSegment(
            id=1, start=3.0, end=6.0,
            text="まず基本的な概念から始めましょう",
            words=(
                WordTimestamp(word="まず", start=3.0, end=3.5, confidence=0.97),
                WordTimestamp(word="基本的な", start=3.5, end=4.2, confidence=0.97),
                WordTimestamp(word="概念から", start=4.2, end=5.0, confidence=0.96),
                WordTimestamp(word="始めましょう", start=5.0, end=6.0, confidence=0.98),
            ),
        ),
    ]
