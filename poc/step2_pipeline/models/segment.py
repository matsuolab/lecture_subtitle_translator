"""
パイプライン全体で使うデータ構造。
全て frozen dataclass（イミュータブル）で定義する。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional


# ---------------------------------------------------------------------------
# Step 2: 書き起こし出力（TranscribeProvider 実装に依存しない）
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class WordTimestamp:
    """単語/文字レベルタイムスタンプ。TranscribeProvider 実装に依存しない汎用構造。"""
    word: str
    start: float        # 秒
    end: float          # 秒
    confidence: float   # 0.0 〜 1.0


@dataclass(frozen=True)
class TranscriptSegment:
    """書き起こし1セグメント（発話区間）。

    words が空タプルの場合は「単語TS未提供」を意味する。
    aligner はこの場合、セグメント内を文字数比例で等分するフォールバックを使う。
    """
    id: int
    start: float                          # 秒
    end: float                            # 秒
    text: str                             # 日本語生テキスト
    words: tuple[WordTimestamp, ...]      # 単語/文字レベルTS（空タプル可）


# ---------------------------------------------------------------------------
# Step 3: PDF 抽出結果
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class SlideContext:
    """スライドPDFから抽出したコンテキスト情報。"""
    glossary: tuple[str, ...]       # 専門用語リスト
    slide_text: str                  # スライド全文テキスト（LLMのコンテキスト用）
    source_path: str                 # 元PDFパス


# ---------------------------------------------------------------------------
# Step 4: 日本語補正後
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class CorrectedSegment:
    """LLM で日本語補正されたセグメント。"""
    original: TranscriptSegment
    corrected_text: str
    correction_distance: float          # Embedding コサイン距離（補正前後）
    correction_flagged: bool            # True = 意味が大きく変わった（要確認）


# ---------------------------------------------------------------------------
# Step 5: 英訳後
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class TranslatedSegment:
    """英訳されたセグメント。"""
    corrected: CorrectedSegment
    translated_text: str
    translation_distance: float         # Embedding コサイン距離（日→英）
    translation_flagged: bool           # True = 意味的乖離が大きい（要確認）


# ---------------------------------------------------------------------------
# Step 6: 字幕ブロック（分割・タイムコード確定後）
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class SubtitleBlock:
    """SRT 出力用の字幕ブロック。1ブロック = 1SRT字幕。"""
    id: int
    start: float                        # 秒
    end: float                          # 秒
    text: str                           # 英語テキスト
    char_count: int
    cps: float                          # Characters Per Second
    cps_ok: bool                        # 15CPS 以内か
    source_segment_id: int              # どの TranscriptSegment 由来か
    flagged: bool = False               # 手動確認が必要なブロック


# ---------------------------------------------------------------------------
# パイプライン全体の実行結果
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class PipelineResult:
    """パイプライン全体の出力。"""
    subtitle_blocks: tuple[SubtitleBlock, ...]
    flagged_corrections: tuple[CorrectedSegment, ...]   # 補正で乖離フラグが立ったもの
    flagged_translations: tuple[TranslatedSegment, ...] # 翻訳で乖離フラグが立ったもの
    srt_path: str                                        # 出力SRTファイルパス
    report_path: str                                     # 品質レポートパス

    @property
    def total_flagged(self) -> int:
        return len(self.flagged_corrections) + len(self.flagged_translations)

    @property
    def cps_violations(self) -> tuple[SubtitleBlock, ...]:
        return tuple(b for b in self.subtitle_blocks if not b.cps_ok)
