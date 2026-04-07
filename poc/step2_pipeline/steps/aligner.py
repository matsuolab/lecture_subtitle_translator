"""
Step 9: Diff アライメントで字幕ブロックに正確なタイムスタンプを付与する。

既存の poc_text_correction_alignment.py の設計を踏襲:
- WhisperX の単語/文字レベルタイムスタンプを参照
- 補正・分割後のテキストと元タイムスタンプの diff を取り、
  各ブロックの start/end を再計算する
"""

from __future__ import annotations

import difflib
from dataclasses import replace

from ..models.segment import SubtitleBlock, TranscriptSegment, WordTimestamp


def align_blocks(
    blocks: list[SubtitleBlock],
    original_segments: list[TranscriptSegment],
) -> list[SubtitleBlock]:
    """
    字幕ブロックに正確なタイムスタンプを付与して返す。

    Args:
        blocks:            splitter が出力した字幕ブロック（仮TSあり）
        original_segments: WhisperX の元セグメント（単語レベルTS付き）

    Returns:
        start/end が更新された SubtitleBlock のリスト
    """
    # 全単語タイムスタンプをフラットに結合
    all_words = _flatten_words(original_segments)
    if not all_words:
        return blocks  # TS情報がなければ仮TSのまま返す

    word_text = " ".join(w.word for w in all_words)
    updated: list[SubtitleBlock] = []

    for block in blocks:
        start, end = _find_time_range(block.text, word_text, all_words)
        if start is not None and end is not None:
            duration = end - start
            cps = block.char_count / duration if duration > 0 else 0.0
            updated.append(
                SubtitleBlock(
                    id=block.id,
                    start=start,
                    end=end,
                    text=block.text,
                    char_count=block.char_count,
                    cps=round(cps, 2),
                    cps_ok=cps <= 15.0 and block.char_count <= 40,
                    source_segment_id=block.source_segment_id,
                    flagged=block.flagged,
                )
            )
        else:
            # アライメント失敗 → 仮TS を維持
            updated.append(block)

    return updated


def _flatten_words(segments: list[TranscriptSegment]) -> list[WordTimestamp]:
    """全セグメントの単語タイムスタンプをフラットなリストにする。"""
    words: list[WordTimestamp] = []
    for seg in segments:
        for w in seg.words:
            if w.start is not None and w.end is not None:
                words.append(w)
    return words


def _find_time_range(
    block_text: str,
    word_text: str,
    all_words: list[WordTimestamp],
) -> tuple[float | None, float | None]:
    """
    ブロックテキストが全単語列のどの位置にあるかを diff で特定し、
    対応する start/end タイムスタンプを返す。

    英語テキストと日本語単語TSの対応は直接マッチングではなく
    「ブロックの前後セグメント境界」を使って近似する。
    """
    # ブロックテキストをトークン化（スペース区切り）
    block_tokens = block_text.lower().split()
    word_tokens = [w.word.lower() for w in all_words]

    if not block_tokens or not word_tokens:
        return None, None

    # SequenceMatcher で最も一致するサブ列を探す
    matcher = difflib.SequenceMatcher(
        None, word_tokens, block_tokens, autojunk=False
    )
    best_block = _find_best_matching_block(matcher, len(word_tokens))

    if best_block is None:
        return None, None

    word_start_idx, _, size = best_block
    word_end_idx = min(word_start_idx + size - 1, len(all_words) - 1)

    start = all_words[word_start_idx].start
    end = all_words[word_end_idx].end

    return start, end


def _find_best_matching_block(
    matcher: difflib.SequenceMatcher,
    total_words: int,
) -> tuple[int, int, int] | None:
    """SequenceMatcher の matching_blocks から最長マッチを取得する。"""
    blocks = matcher.get_matching_blocks()
    best = max(blocks, key=lambda b: b.size, default=None)
    if best is None or best.size == 0:
        return None
    return (best.a, best.b, best.size)
