"""
corrector.py のテスト。
Mock LLM/Embed を使って補正ロジックとフラグ判定を検証する。
"""

from __future__ import annotations

import pytest

from ..models.segment import SlideContext, TranscriptSegment, WordTimestamp
from ..steps.corrector import _parse_numbered_response, correct_segments
from .conftest import MockEmbedProvider, MockLLMProvider


# ---------------------------------------------------------------------------
# _parse_numbered_response
# ---------------------------------------------------------------------------

class TestParseNumberedResponse:
    def _seg(self, seg_id: int, text: str) -> TranscriptSegment:
        return TranscriptSegment(id=seg_id, start=0.0, end=1.0, text=text, words=())

    def test_parses_correctly_formatted_response(self) -> None:
        segs = [self._seg(0, "original A"), self._seg(1, "original B")]
        response = "[0] corrected A\n[1] corrected B"

        result = _parse_numbered_response(response, segs)

        assert result == ["corrected A", "corrected B"]

    def test_falls_back_to_original_on_parse_failure(self) -> None:
        segs = [self._seg(0, "original A"), self._seg(1, "original B")]
        response = "totally unparseable response"

        result = _parse_numbered_response(response, segs)

        assert result == ["original A", "original B"]

    def test_partial_parse_uses_original_for_missing(self) -> None:
        segs = [self._seg(0, "original A"), self._seg(1, "original B")]
        response = "[0] corrected A"  # seg 1 が欠落

        result = _parse_numbered_response(response, segs)

        assert result[0] == "corrected A"
        assert result[1] == "original B"  # フォールバック

    def test_ignores_extra_ids_in_response(self) -> None:
        """応答に余分な ID が含まれていても問題ない。"""
        segs = [self._seg(5, "original")]
        response = "[3] irrelevant\n[5] corrected\n[9] also irrelevant"

        result = _parse_numbered_response(response, segs)

        assert result == ["corrected"]


# ---------------------------------------------------------------------------
# correct_segments
# ---------------------------------------------------------------------------

class TestCorrectSegments:
    def _seg(self, seg_id: int, text: str, start: float = 0.0, end: float = 3.0) -> TranscriptSegment:
        return TranscriptSegment(id=seg_id, start=start, end=end, text=text, words=())

    @pytest.mark.asyncio
    async def test_returns_corrected_segment_for_each_input(self) -> None:
        segs = [self._seg(0, "えーっと、ニューラルネットワークです")]
        llm = MockLLMProvider(["[0] ニューラルネットワークです"])
        embed = MockEmbedProvider(distance=0.05)

        result = await correct_segments(segs, slide_context=None, llm=llm, embed=embed)

        assert len(result) == 1
        assert result[0].corrected_text == "ニューラルネットワークです"
        assert result[0].original is segs[0]

    @pytest.mark.asyncio
    async def test_flagged_when_distance_exceeds_threshold(self) -> None:
        segs = [self._seg(0, "テスト")]
        llm = MockLLMProvider(["[0] 全然違うテキスト"])
        embed = MockEmbedProvider(distance=0.30)  # 閾値0.15を超える

        result = await correct_segments(
            segs, slide_context=None, llm=llm, embed=embed, flag_threshold=0.15
        )

        assert result[0].correction_flagged is True
        assert result[0].correction_distance == pytest.approx(0.30, abs=0.01)

    @pytest.mark.asyncio
    async def test_not_flagged_when_distance_below_threshold(self) -> None:
        segs = [self._seg(0, "テスト")]
        llm = MockLLMProvider(["[0] テスト（補正済み）"])
        embed = MockEmbedProvider(distance=0.05)  # 閾値0.15以下

        result = await correct_segments(
            segs, slide_context=None, llm=llm, embed=embed, flag_threshold=0.15
        )

        assert result[0].correction_flagged is False

    @pytest.mark.asyncio
    async def test_slide_context_injected_into_prompt(self) -> None:
        segs = [self._seg(0, "テスト")]
        llm = MockLLMProvider(["[0] テスト"])
        embed = MockEmbedProvider(distance=0.05)
        slide_ctx = SlideContext(
            glossary=("WhisperX", "ニューラルネットワーク"),
            slide_text="スライドのテキスト内容",
            source_path="/path/to/slides.pdf",
        )

        await correct_segments(segs, slide_context=slide_ctx, llm=llm, embed=embed)

        # LLM に渡されたメッセージにスライドコンテキストが含まれているか
        assert len(llm.calls) == 1
        user_message = llm.calls[0][1]["content"]  # messages[1] = user
        assert "WhisperX" in user_message
        assert "スライドのテキスト内容" in user_message

    @pytest.mark.asyncio
    async def test_batching(self) -> None:
        """batch_size=2 で 5セグメントを処理すると 3回LLMが呼ばれる。"""
        segs = [self._seg(i, f"テスト{i}") for i in range(5)]
        llm = MockLLMProvider([
            "[0] A\n[1] B",
            "[2] C\n[3] D",
            "[4] E",
        ])
        embed = MockEmbedProvider(distance=0.05)

        result = await correct_segments(
            segs, slide_context=None, llm=llm, embed=embed, batch_size=2
        )

        assert len(result) == 5
        assert len(llm.calls) == 3
