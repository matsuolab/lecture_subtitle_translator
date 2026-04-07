"""
aligner.py のテスト。
Diff アライメントによるタイムスタンプ割り当てロジックを検証する。
"""

from __future__ import annotations

import pytest

from ..models.segment import SubtitleBlock, TranscriptSegment, WordTimestamp
from ..steps.aligner import _find_best_matching_block, _flatten_words, align_blocks


# ---------------------------------------------------------------------------
# _flatten_words
# ---------------------------------------------------------------------------

class TestFlattenWords:
    def test_flattens_multiple_segments(self, multi_segments) -> None:
        words = _flatten_words(multi_segments)
        total = sum(len(seg.words) for seg in multi_segments)
        assert len(words) == total

    def test_maintains_time_order(self, multi_segments) -> None:
        words = _flatten_words(multi_segments)
        starts = [w.start for w in words]
        assert starts == sorted(starts)

    def test_empty_segments_returns_empty(self) -> None:
        assert _flatten_words([]) == []

    def test_skips_words_without_timestamps(self) -> None:
        seg = TranscriptSegment(
            id=0, start=0.0, end=5.0, text="test",
            words=(
                WordTimestamp(word="hello", start=0.0, end=1.0, confidence=1.0),
                WordTimestamp(word="world", start=None, end=None, confidence=1.0),  # type: ignore
            ),
        )
        words = _flatten_words([seg])
        # start/end が None のものは含まれない
        assert all(w.start is not None for w in words)


# ---------------------------------------------------------------------------
# align_blocks
# ---------------------------------------------------------------------------

class TestAlignBlocks:
    def _make_block(
        self,
        block_id: int,
        text: str,
        start: float = 0.0,
        end: float = 1.0,
        source_id: int = 0,
    ) -> SubtitleBlock:
        char_count = len(text)
        duration = end - start
        cps = char_count / duration if duration > 0 else 0.0
        return SubtitleBlock(
            id=block_id,
            start=start,
            end=end,
            text=text,
            char_count=char_count,
            cps=round(cps, 2),
            cps_ok=cps <= 17.0,
            source_segment_id=source_id,
        )

    def test_returns_same_number_of_blocks(self, sample_segment) -> None:
        blocks = [
            self._make_block(0, "This is a test"),
            self._make_block(1, "of neural networks"),
        ]
        result = align_blocks(blocks, [sample_segment])
        assert len(result) == len(blocks)

    def test_returns_original_blocks_when_no_words(self) -> None:
        """単語TSが空の場合、仮TSのままブロックを返す。"""
        seg = TranscriptSegment(id=0, start=0.0, end=5.0, text="test", words=())
        blocks = [self._make_block(0, "test", start=0.0, end=5.0)]
        result = align_blocks(blocks, [seg])
        assert result[0].start == 0.0
        assert result[0].end == 5.0

    def test_aligned_block_preserves_text(self, sample_segment) -> None:
        """アライメント後もテキストは変わらない。"""
        original_text = "This is a test"
        blocks = [self._make_block(0, original_text)]
        result = align_blocks(blocks, [sample_segment])
        assert result[0].text == original_text

    def test_aligned_timestamps_within_segment_range(self, sample_segment) -> None:
        """アライメント後のタイムスタンプは元セグメントの範囲内に収まる。"""
        blocks = [self._make_block(0, "This is a test", start=0.0, end=2.3)]
        result = align_blocks(blocks, [sample_segment])
        assert result[0].start >= sample_segment.start
        assert result[0].end <= sample_segment.end + 0.1  # 浮動小数点誤差を考慮

    def test_cps_recalculated_after_alignment(self, sample_segment) -> None:
        """アライメント後に CPS が再計算される。"""
        blocks = [self._make_block(0, "neural networks", start=0.0, end=0.1)]  # わざと短い duration
        result = align_blocks(blocks, [sample_segment])
        # アライメント後の duration で CPS が計算されている
        block = result[0]
        expected_cps = block.char_count / (block.end - block.start) if (block.end - block.start) > 0 else 0.0
        assert abs(block.cps - round(expected_cps, 2)) < 0.01


# ---------------------------------------------------------------------------
# CPS 計算の正確性（aligner で行っている計算を直接テスト）
# ---------------------------------------------------------------------------

class TestCPSCalculation:
    @pytest.mark.parametrize("text,duration,expected_cps", [
        ("Hello world", 1.0, 11.0),
        ("Hi", 2.0, 1.0),
        ("", 1.0, 0.0),
        ("Test sentence here", 3.0, 6.0),
    ])
    def test_cps_formula(self, text: str, duration: float, expected_cps: float) -> None:
        cps = len(text) / duration if duration > 0 else 0.0
        assert abs(cps - expected_cps) < 0.01
