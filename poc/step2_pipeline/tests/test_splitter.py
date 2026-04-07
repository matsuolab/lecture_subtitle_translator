"""
splitter.py のテスト。
CPS検証ループ・文字数チェック・LLMレスポンスパースを検証する。
"""

from __future__ import annotations

import pytest

from ..constraints import SubtitleConstraints, load_constraints
from ..models.segment import CorrectedSegment, TranslatedSegment
from ..steps.splitter import _extract_result, split_into_blocks
from .conftest import MockEmbedProvider, MockLLMProvider


# ---------------------------------------------------------------------------
# ヘルパー
# ---------------------------------------------------------------------------

def _make_translated(
    seg_id: int,
    start: float,
    end: float,
    jp_text: str,
    en_text: str,
) -> TranslatedSegment:
    from ..models.segment import TranscriptSegment, WordTimestamp

    original = TranscriptSegment(
        id=seg_id, start=start, end=end, text=jp_text, words=()
    )
    corrected = CorrectedSegment(
        original=original,
        corrected_text=jp_text,
        correction_distance=0.05,
        correction_flagged=False,
    )
    return TranslatedSegment(
        corrected=corrected,
        translated_text=en_text,
        translation_distance=0.10,
        translation_flagged=False,
    )


_EN_CONSTRAINTS = SubtitleConstraints(max_chars=42, max_cps=17.0, max_retry=3)
_TIGHT_CONSTRAINTS = SubtitleConstraints(max_chars=10, max_cps=5.0, max_retry=2)


# ---------------------------------------------------------------------------
# _extract_result
# ---------------------------------------------------------------------------

class TestExtractResult:
    def test_extracts_result_line(self) -> None:
        response = "PLAN: Use contractions\nRESULT: It's a test"
        assert _extract_result(response, "fallback") == "It's a test"

    def test_case_insensitive(self) -> None:
        response = "plan: shorten\nresult: short text"
        assert _extract_result(response, "fallback") == "short text"

    def test_fallback_when_no_result_line(self) -> None:
        response = "This is the whole response"
        assert _extract_result(response, "fallback") == "This is the whole response"

    def test_fallback_on_empty_response(self) -> None:
        assert _extract_result("", "fallback") == "fallback"

    def test_uses_last_nonempty_line_as_fallback(self) -> None:
        response = "line one\nline two\nline three"
        assert _extract_result(response, "fallback") == "line three"


# ---------------------------------------------------------------------------
# split_into_blocks
# ---------------------------------------------------------------------------

class TestSplitIntoBlocks:
    @pytest.mark.asyncio
    async def test_short_text_not_split(self) -> None:
        """制約以内のテキストは LLM を呼ばずにそのままブロックになる。"""
        seg = _make_translated(0, 0.0, 5.0, "テスト", "Short text")
        llm = MockLLMProvider([])  # 呼ばれないはず

        blocks = await split_into_blocks([seg], llm, _EN_CONSTRAINTS)

        assert len(blocks) == 1
        assert blocks[0].text == "Short text"
        assert len(llm.calls) == 0

    @pytest.mark.asyncio
    async def test_long_text_split_by_llm(self) -> None:
        """制約超えのテキストは LLM に分割を依頼する。"""
        long_text = "This is a very long English sentence that exceeds the character limit easily"
        seg = _make_translated(0, 0.0, 10.0, "テスト", long_text)

        # LLM が2行に分割して返す
        llm = MockLLMProvider(["This is a very long\nEnglish sentence that exceeds"])

        blocks = await split_into_blocks([seg], llm, _EN_CONSTRAINTS)

        assert len(blocks) == 2
        assert len(llm.calls) >= 1

    @pytest.mark.asyncio
    async def test_cps_violation_triggers_shorten(self) -> None:
        """CPS違反があると短縮プロンプトが呼ばれる。"""
        # tight constraints: max_chars=10, max_cps=5.0
        text = "Long text"  # 9文字、duration=0.5秒 → CPS=18 > 5.0 → 違反
        seg = _make_translated(0, 0.0, 0.5, "テスト", text)

        # 1回目: split（テキスト長 <= max_chars=10 なので split は呼ばれない）
        # 1回目: shorten が呼ばれ "OK" (4文字, CPS=8 > 5.0 → まだ違反)
        # 2回目: shorten → "Hi" (2文字, CPS=4 <= 5.0 → OK)
        llm = MockLLMProvider([
            "PLAN: cut words\nRESULT: OK text",
            "PLAN: cut more\nRESULT: Hi",
        ])

        blocks = await split_into_blocks([seg], llm, _TIGHT_CONSTRAINTS)

        assert len(blocks) == 1
        # 少なくとも1回は shorten が呼ばれた
        assert len(llm.calls) >= 1

    @pytest.mark.asyncio
    async def test_max_retry_exceeded_sets_flagged(self) -> None:
        """max_retry 回失敗したら flagged=True でそのまま通す。"""
        # "Hi" は2文字 <= max_chars=5 なので _split_text は呼ばれない
        # duration=0.1秒 → CPS = 2/0.1 = 20 > max_cps=5.0 → 必ずCPS違反
        text = "Hi"
        seg = _make_translated(0, 0.0, 0.1, "テスト", text)

        # max_retry=2: _try_shorten が2回呼ばれるが両方とも CPS 違反が続く
        tight = SubtitleConstraints(max_chars=5, max_cps=5.0, max_retry=2)
        llm = MockLLMProvider([
            "PLAN: cut\nRESULT: Hi",  # 2文字, CPS=20 → まだ違反
            "PLAN: cut\nRESULT: Hi",  # 2文字, CPS=20 → まだ違反 → max_retry超過
        ])

        blocks = await split_into_blocks([seg], llm, tight)

        assert any(b.flagged for b in blocks)

    @pytest.mark.asyncio
    async def test_block_ids_are_sequential(self) -> None:
        """複数セグメントを処理しても block.id が通し番号になる。"""
        segs = [
            _make_translated(0, 0.0, 3.0, "テスト1", "Short A"),
            _make_translated(1, 3.0, 6.0, "テスト2", "Short B"),
        ]
        llm = MockLLMProvider([])

        blocks = await split_into_blocks(segs, llm, _EN_CONSTRAINTS)

        ids = [b.id for b in blocks]
        assert ids == list(range(len(blocks)))

    @pytest.mark.asyncio
    async def test_source_segment_id_preserved(self) -> None:
        """ブロックに元セグメントのIDが記録される。"""
        segs = [
            _make_translated(42, 0.0, 3.0, "テスト", "Short text"),
        ]
        llm = MockLLMProvider([])

        blocks = await split_into_blocks(segs, llm, _EN_CONSTRAINTS)

        assert all(b.source_segment_id == 42 for b in blocks)
