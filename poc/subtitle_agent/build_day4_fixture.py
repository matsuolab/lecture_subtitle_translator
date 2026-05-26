"""Build hierarchical subtitle-planning fixtures from the Day4 WhisperX cache.

The fixture keeps the real timing shape and ASR segment structure while applying
light anonymization to lecturer/lab names. Heuristic tags are intentionally weak:
they are only sampling hints, not ground truth labels.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from poc.subtitle_agent import constants

PROJECT_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CACHE = PROJECT_ROOT / "poc" / "cache" / "DL基礎_day4_講義用_202604_cache.json"
DEFAULT_OUTPUT = (
    PROJECT_ROOT
    / "poc"
    / "subtitle_agent"
    / "fixtures"
    / "day4_whisperx_dummy_chunks.json"
)

CHUNK_SECONDS = 60.0
CONTEXT_SECONDS = 8.0

REPLACEMENTS = {
    "松尾岩沢研究室": "研究室",
    "松尾・岩澤研究室": "研究室",
    "松尾研": "研究室",
    "谷口翔平": "講師",
}

TECHNICAL_TERMS = (
    "ニューラル",
    "ネットワーク",
    "最適化",
    "正則化",
    "過学習",
    "勾配",
    "SGD",
    "確率的",
    "損失",
    "パラメータ",
    "アルゴリズム",
    "ミニバッチ",
    "学習率",
    "初期化",
    "ドロップアウト",
)

FILLER_TERMS = (
    "えー",
    "ええ",
    "あの",
    "その",
    "まあ",
    "はい",
    "ということで",
    "というふうに",
    "だったり",
)


def _clean_text(text: str) -> str:
    out = str(text or "")
    for source, replacement in REPLACEMENTS.items():
        out = out.replace(source, replacement)
    out = re.sub(r"\s+", " ", out).strip()
    return out


def _clean_words(words: list[dict[str, Any]]) -> list[dict[str, Any]]:
    cleaned = []
    for word in words:
        text = _clean_text(str(word.get("word", "")))
        if not text:
            continue
        row: dict[str, Any] = {
            "word": text,
            "start": round(float(word.get("start", 0.0)), 3),
            "end": round(float(word.get("end", 0.0)), 3),
        }
        if "score" in word:
            row["score"] = round(float(word["score"]), 3)
        cleaned.append(row)
    return cleaned


def _metric_tags(text: str, duration: float) -> tuple[list[str], dict[str, float | int]]:
    no_space = re.sub(r"\s+", "", text)
    chars = len(no_space)
    density = chars / max(0.001, duration)
    term_hits = sum(text.count(term) for term in TECHNICAL_TERMS)
    filler_hits = sum(text.count(term) for term in FILLER_TERMS)
    symbol_hits = len(re.findall(r"[A-Za-z0-9α-ωΑ-Ω=+\-*/^()（）]", text))

    tags: list[str] = []
    if density >= 8.0:
        tags.append("dense")
    if term_hits >= 5 or symbol_hits >= 8:
        tags.append("technical")
    if filler_hits >= 4:
        tags.append("disfluent")
    if chars >= 520:
        tags.append("long_context")
    if not tags:
        tags.append("normal")

    metrics: dict[str, float | int] = {
        "ja_chars_no_space": chars,
        "ja_chars_per_second": round(density, 3),
        "technical_term_hits": term_hits,
        "filler_hits": filler_hits,
        "symbol_hits": symbol_hits,
    }
    return tags, metrics


def _segment_text(segment: dict[str, Any]) -> str:
    return _clean_text(
        str(
            segment.get("ja_corrected")
            or segment.get("ja")
            or segment.get("text")
            or ""
        )
    )


def _chunk_segments(segments: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not segments:
        return []

    min_start = float(segments[0]["start"])
    max_end = max(float(seg["end"]) for seg in segments)
    chunks = []
    cursor = min_start
    chunk_index = 1

    while cursor < max_end:
        chunk_start = cursor
        chunk_end = min(cursor + CHUNK_SECONDS, max_end)
        selected = [
            seg
            for seg in segments
            if float(seg["end"]) > chunk_start and float(seg["start"]) < chunk_end
        ]
        if selected:
            text = " ".join(_segment_text(seg) for seg in selected).strip()
            tags, metrics = _metric_tags(text, chunk_end - chunk_start)
            context_before = " ".join(
                _segment_text(seg)
                for seg in segments
                if chunk_start - CONTEXT_SECONDS <= float(seg["end"]) <= chunk_start
            ).strip()
            context_after = " ".join(
                _segment_text(seg)
                for seg in segments
                if chunk_end <= float(seg["start"]) <= chunk_end + CONTEXT_SECONDS
            ).strip()
            chunks.append(
                {
                    "chunk_id": f"day4_dummy_{chunk_index:03d}",
                    "start": round(chunk_start, 3),
                    "end": round(chunk_end, 3),
                    "duration": round(chunk_end - chunk_start, 3),
                    "context_before": context_before,
                    "context_after": context_after,
                    "heuristic_tags": tags,
                    "metrics": metrics,
                    "segments": [
                        {
                            "id": int(seg.get("id", i + 1)),
                            "start": round(float(seg["start"]), 3),
                            "end": round(float(seg["end"]), 3),
                            "ja_text": _segment_text(seg),
                            "words": _clean_words(seg.get("words", [])),
                        }
                        for i, seg in enumerate(selected)
                    ],
                }
            )
            chunk_index += 1
        cursor = chunk_end

    return chunks


def build_fixture(cache_path: Path = DEFAULT_CACHE, output_path: Path = DEFAULT_OUTPUT) -> dict[str, Any]:
    with open(cache_path, encoding="utf-8") as f:
        segments = json.load(f)
    segments = sorted(segments, key=lambda row: float(row["start"]))
    chunks = _chunk_segments(segments)

    fixture = {
        "source": "day4_whisperx_dummy",
        "source_cache": str(cache_path.relative_to(PROJECT_ROOT)),
        "chunking": {
            "target_seconds": CHUNK_SECONDS,
            "context_seconds": CONTEXT_SECONDS,
            "strategy": "fixed_time_windows_from_whisperx_segments",
        },
        "constraints": {
            "max_cps": constants.TARGET_CPS,
            "max_chars_per_line": constants.MAX_LINE_CHARS,
            "max_segment_chars": constants.MAX_SEGMENT_CHARS,
            "max_lines": constants.MAX_LINES,
            "min_duration": constants.MIN_CUE_DURATION,
            "max_duration": constants.MAX_CUE_DURATION,
            "min_gap": constants.MIN_CUE_GAP,
        },
        "notes": [
            "Text is lightly anonymized from the Day4 WhisperX cache.",
            "heuristic_tags are sampling hints only and should not be treated as labels.",
            "PoC agents should rely on timestamps, words, transcript text, and constraints.",
        ],
        "chunks": chunks,
    }

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(fixture, f, ensure_ascii=False, indent=2)
        f.write("\n")
    return fixture


def main() -> None:
    fixture = build_fixture()
    print(f"chunks={len(fixture['chunks'])}")
    print(f"output={DEFAULT_OUTPUT}")


if __name__ == "__main__":
    main()
