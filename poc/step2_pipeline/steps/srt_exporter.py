"""
Step 10: 字幕ブロックを SRT ファイルとして出力する。
pysubs2 を使用。品質レポート（JSON）も同時生成する。
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pysubs2  # type: ignore[import]

from ..models.segment import PipelineResult, SubtitleBlock


def export_srt(
    blocks: list[SubtitleBlock],
    output_path: str,
) -> str:
    """
    字幕ブロックを SRT ファイルとして書き出す。

    Args:
        blocks:      SubtitleBlock のリスト
        output_path: 出力先 SRT ファイルパス

    Returns:
        書き出した SRT ファイルの絶対パス
    """
    os.makedirs(Path(output_path).parent, exist_ok=True)

    subs = pysubs2.SSAFile()

    for block in blocks:
        line = pysubs2.SSAEvent(
            start=pysubs2.make_time(s=block.start),
            end=pysubs2.make_time(s=block.end),
            text=block.text,
        )
        subs.append(line)

    subs.sort()
    subs.save(output_path, format_="srt")

    return str(Path(output_path).resolve())


def export_report(
    result: PipelineResult,
    report_path: str,
    extra: dict | None = None,
) -> str:
    """
    品質レポートを JSON として書き出す。
    フラグ箇所（補正・翻訳乖離・CPS違反）を一覧化する。

    Args:
        result:      PipelineResult
        report_path: 出力先 JSON ファイルパス

    Returns:
        書き出したレポートファイルの絶対パス
    """
    os.makedirs(Path(report_path).parent, exist_ok=True)

    report = {
        "summary": {
            "total_blocks": len(result.subtitle_blocks),
            "flagged_corrections": len(result.flagged_corrections),
            "flagged_translations": len(result.flagged_translations),
            "cps_violations": len(result.cps_violations),
            "total_flagged": result.total_flagged,
        },
        "flagged_corrections": [
            {
                "segment_id": s.original.id,
                "original_text": s.original.text,
                "corrected_text": s.corrected_text,
                "distance": round(s.correction_distance, 4),
            }
            for s in result.flagged_corrections
        ],
        "flagged_translations": [
            {
                "segment_id": s.corrected.original.id,
                "japanese": s.corrected.corrected_text,
                "english": s.translated_text,
                "distance": round(s.translation_distance, 4),
            }
            for s in result.flagged_translations
        ],
        "cps_violations": [
            {
                "block_id": b.id,
                "text": b.text,
                "char_count": b.char_count,
                "cps": b.cps,
                "start": b.start,
                "end": b.end,
            }
            for b in result.cps_violations
        ],
    }

    if extra:
        report.update(extra)

    with open(report_path, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)

    return str(Path(report_path).resolve())
