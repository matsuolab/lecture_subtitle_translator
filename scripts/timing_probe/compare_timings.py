"""WhisperX 生タイムスタンプと最終字幕ブロックのタイムスタンプを、テキストアライメントで突合するツール。

## 背景（なぜ ID 突合ではなくテキストアライメントなのか）

当初は「プロジェクト JSON の `blocks[].contextGroupSourceIds` が WhisperX セグメント ID
(1始まり) に対応する」という前提で ID 突合を行っていたが、これは誤りだった。
WhisperX は少数の長大セグメント（本データでは 11 セグメント、平均 26.8 秒）しか返さないのに、
`contextGroupSourceIds` は意味分割 (semanticSplitJa) **後**のキュー ID (1..37 など) を指しており、
WhisperX セグメント ID とは別物である。したがって ID による突合は成立しない。

代わりに本ツールは、WhisperX の単語（1文字単位）ストリームと最終字幕ブロックの transcript
ストリームをそれぞれ正規化して文字列化し、`difflib.SequenceMatcher` でアライメントすることで
各ブロックが実際に「いつ話されたか (spoken_start/spoken_end)」を推定し、
`assigned` (ブロックに割り当てられた startTime/endTime) との差分 (delta) を計測する。

## ポーズ吸収問題への対処（重要）

WhisperX は文間ポーズを直前モーラの `end` に吸収することがある（実例: 「す」が
177.792 → 186.138 の 8.35 秒に伸びる、score=1.000。全単語 duration 中央値は 0.120 秒）。
文字時刻を単語の [start, end] 区間内で単純補間すると、この膨張した単語に当たった
文字の時刻が数秒単位でずれてしまう。そこで各単語の duration に上限 (CAP) を設け、
`effective_end = min(end, start + MAX_WORD_DURATION_SEC)` としてから文字時刻を割り当てる。

また、「発話中の字幕欠落 (穴)」の検出も、WhisperX セグメント（内部に長いポーズを含む
最大約27秒の粗い区間）をそのまま使うと無音区間を欠落と誤検出してしまう。そのため
CAP 適用後の単語列から、間隔が一定値未満の隣接語を結合して発話区間を再構成し、
その区間ベースで穴を検出する。

使い方:
    python scripts/timing_probe/compare_timings.py \
        --whisperx scripts/timing_probe/out/whisperx_raw.json \
        --project  path/to/subtitle-project_xxx.json \
        --out      scripts/timing_probe/out/

    # before/after 比較用: プロジェクトJSONのブロック時刻を別のタイミング案で上書きして分析
    python scripts/timing_probe/compare_timings.py \
        --whisperx scripts/timing_probe/out/whisperx_raw.json \
        --project  path/to/subtitle-project_xxx.json \
        --spans    path/to/new_spans.json \
        --out      scripts/timing_probe/out_after/
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import sys
from dataclasses import dataclass
from difflib import SequenceMatcher
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]

# 突合対象から除外する文字（空白・句読点・記号類）。ASR 側・最終字幕側の双方で
# 同じ正規化を適用することで、句読点の有無による文字列のズレを吸収する。
NORMALIZE_PATTERN = re.compile(r"[\s、。「」,.！？!?・…]")

# ブロックを「対応不能」とみなす閾値。マッチ文字数がこれ未満なら、そのブロックの
# spoken_start/spoken_end は信頼できないため delta を出さない。
MIN_MATCH_CHARS = 4
MIN_MATCH_RATIO = 0.35

# |delta| がこの秒数を超えたブロックを「大きくズレている」とみなす。
BIG_DELTA_THRESHOLD_SEC = 1.0

# 発話区間内でこの秒数を超えて字幕キューが存在しない場合に「穴」として計上する。
HOLE_THRESHOLD_SEC = 0.5

# WhisperX 単語の duration 上限（秒）。全単語 duration の中央値 0.120 秒の5倍。
# WhisperX は文間ポーズを直前モーラの `end` に吸収するため（実例: 「す」が
# 177.792→186.138 の8.35秒に伸びる、score=1.000）、この上限で切り詰めることで
# 文字時刻補間が異常に間延びするのを防ぐ。CLI --max-word-dur で上書き可。
MAX_WORD_DURATION_SEC = 0.6

# 発話区間の再構成: CAP適用後の単語列で、隣接語の間隔（前の単語の effective_end から
# 次の単語の start まで）がこの秒数未満なら同一発話区間として結合する。
SPEECH_MERGE_GAP_SEC = 0.35

# TIMING DRIFT CONFIRMED の判定閾値。
DRIFT_RATIO_THRESHOLD = 0.10
DRIFT_HOLE_TOTAL_THRESHOLD_SEC = 5.0

WORST_CASE_TOP_N = 5


def normalize(text: str) -> str:
    """句読点・空白などを除いた正規化済みテキストを返す。"""
    return NORMALIZE_PATTERN.sub("", text)


# --- データ構造 ----------------------------------------------------------------


@dataclass(frozen=True)
class WhisperXSegmentInfo:
    """WhisperX の1セグメント（=1つの連続発話区間、サマリ表示用）。"""

    seg_id: int
    start: float
    end: float

    @property
    def duration(self) -> float:
        return self.end - self.start


@dataclass(frozen=True)
class CappedWord:
    """duration を MAX_WORD_DURATION_SEC でCAPした後の WhisperX 単語。"""

    text: str
    start: float
    end: float  # CAP適用後の effective_end

    @property
    def duration(self) -> float:
        return self.end - self.start


@dataclass(frozen=True)
class SpeechInterval:
    """CAP適用後の単語列から再構成した、連続する発話区間。"""

    start: float
    end: float

    @property
    def duration(self) -> float:
        return self.end - self.start


@dataclass(frozen=True)
class FinalBlock:
    """最終字幕プロジェクトの1ブロック。"""

    index: int
    block_id: int
    start_time: float
    end_time: float
    transcript: str


@dataclass(frozen=True)
class BlockResult:
    """1ブロックのアライメント結果。"""

    block: FinalBlock
    norm_char_count: int
    match_chars: int
    spoken_start: float | None
    spoken_end: float | None
    delta_start: float | None
    delta_end: float | None

    @property
    def resolvable(self) -> bool:
        return self.spoken_start is not None and self.spoken_end is not None

    @property
    def match_rate(self) -> float:
        if self.norm_char_count == 0:
            return 0.0
        return self.match_chars / self.norm_char_count

    @property
    def max_abs_delta(self) -> float | None:
        if self.delta_start is None or self.delta_end is None:
            return None
        return max(abs(self.delta_start), abs(self.delta_end))


@dataclass(frozen=True)
class SpeechHole:
    """発話区間内なのに字幕キューが存在しない区間。"""

    interval_index: int
    start: float
    end: float

    @property
    def duration(self) -> float:
        return self.end - self.start


# --- ASR / 最終字幕 の文字ストリーム構築 -----------------------------------------


def load_whisperx_segments(data: dict) -> list[WhisperXSegmentInfo]:
    segments: list[WhisperXSegmentInfo] = []
    for i, seg in enumerate(data.get("segments", [])):
        segments.append(
            WhisperXSegmentInfo(seg_id=i + 1, start=float(seg["start"]), end=float(seg["end"]))
        )
    return segments


def load_capped_words(data: dict, max_word_duration: float) -> list[CappedWord]:
    """WhisperX 生 JSON の全セグメントの words[] を時間順に読み出し、各単語の
    duration を max_word_duration 秒でCAPした CappedWord のリストを返す。

    start/end のいずれかが欠損している単語はスキップする（アライメント脱落単語）。
    """
    words: list[CappedWord] = []
    for seg in data.get("segments", []):
        for w in seg.get("words", []):
            if "start" not in w or "end" not in w:
                continue
            start = float(w["start"])
            end = float(w["end"])
            effective_end = max(start, min(end, start + max_word_duration))
            text = str(w.get("word", w.get("char", "")))
            words.append(CappedWord(text=text, start=start, end=effective_end))
    words.sort(key=lambda w: w.start)
    return words


def build_asr_char_stream(words: list[CappedWord]) -> tuple[str, list[float], list[float]]:
    """CAP適用後の単語列を連結し、正規化した1文字ごとに区間 [start_k, end_k) を
    割り当てて (文字列, 各文字の start_k リスト, 各文字の end_k リスト) を返す。

    単語テキストは先に正規化し、正規化後の文字数で単語の [start, effective_end]
    区間を等分して各文字に区間を割り当てる（中点ではなく区間の下端/上端）。
    """
    chars: list[str] = []
    char_starts: list[float] = []
    char_ends: list[float] = []
    for w in words:
        text = normalize(w.text)
        n = len(text)
        if n == 0:
            continue
        span = w.end - w.start
        for k, ch in enumerate(text):
            start_k = w.start + span * k / n
            end_k = w.start + span * (k + 1) / n
            chars.append(ch)
            char_starts.append(start_k)
            char_ends.append(end_k)
    return "".join(chars), char_starts, char_ends


def load_final_blocks(project: dict) -> list[FinalBlock]:
    blocks: list[FinalBlock] = []
    for i, b in enumerate(project.get("blocks", [])):
        blocks.append(
            FinalBlock(
                index=i,
                block_id=int(b["id"]),
                start_time=float(b["startTime"]),
                end_time=float(b["endTime"]),
                transcript=str(b.get("transcript", "")),
            )
        )
    return blocks


def parse_spans(data: list) -> dict[int, tuple[float, float]]:
    """`--spans` で渡された JSON 配列 [{id, startSec, endSec}, ...] を
    block_id -> (startSec, endSec) の辞書へ変換する。
    """
    spans: dict[int, tuple[float, float]] = {}
    for item in data:
        if "id" not in item or "startSec" not in item or "endSec" not in item:
            raise ValueError(f"--spans の要素には id/startSec/endSec が必須です: {item}")
        spans[int(item["id"])] = (float(item["startSec"]), float(item["endSec"]))
    return spans


def apply_spans(
    blocks: list[FinalBlock], spans: dict[int, tuple[float, float]]
) -> list[FinalBlock]:
    """spans に含まれる block_id のブロックの startTime/endTime を spans の値で
    置き換えた新しい FinalBlock のリストを返す（text/id はプロジェクト側のものを使う）。

    spans に含まれる id がプロジェクトのブロックに1つも存在しない場合はエラーにする
    （before/after 比較の前提が崩れているため、黙って無視せず落とす）。
    """
    block_ids = {b.block_id for b in blocks}
    missing = sorted(set(spans.keys()) - block_ids)
    if missing:
        raise ValueError(
            f"--spans に指定された id がプロジェクトのブロックに存在しません: {missing}"
        )

    updated: list[FinalBlock] = []
    for b in blocks:
        if b.block_id in spans:
            start, end = spans[b.block_id]
            updated.append(
                FinalBlock(
                    index=b.index,
                    block_id=b.block_id,
                    start_time=start,
                    end_time=end,
                    transcript=b.transcript,
                )
            )
        else:
            updated.append(b)
    return updated


def build_final_char_stream(blocks: list[FinalBlock]) -> tuple[str, list[int]]:
    """ブロックを順に連結し、(文字列, 各文字が属するブロック index のリスト) を返す。"""
    chars: list[str] = []
    block_of_char: list[int] = []
    for block in blocks:
        text = normalize(block.transcript)
        for ch in text:
            chars.append(ch)
            block_of_char.append(block.index)
    return "".join(chars), block_of_char


# --- アライメント ---------------------------------------------------------------


def align_blocks(
    asr_str: str,
    asr_starts: list[float],
    asr_ends: list[float],
    final_str: str,
    block_of_char: list[int],
    blocks: list[FinalBlock],
) -> list[BlockResult]:
    """SequenceMatcher でマッチした文字ごとに ASR 側の時刻区間をブロックへ振り分け、
    各ブロックの spoken_start (マッチ文字の start_k の最小値) /
    spoken_end (マッチ文字の end_k の最大値) と assigned との delta を計算する。
    """
    matcher = SequenceMatcher(None, asr_str, final_str, autojunk=False)
    starts_by_block: dict[int, list[float]] = {block.index: [] for block in blocks}
    ends_by_block: dict[int, list[float]] = {block.index: [] for block in blocks}
    matches_by_block: dict[int, int] = {block.index: 0 for block in blocks}

    for match in matcher.get_matching_blocks():
        for offset in range(match.size):
            final_pos = match.b + offset
            block_index = block_of_char[final_pos]
            asr_pos = match.a + offset
            starts_by_block[block_index].append(asr_starts[asr_pos])
            ends_by_block[block_index].append(asr_ends[asr_pos])
            matches_by_block[block_index] += 1

    results: list[BlockResult] = []
    for block in blocks:
        norm_char_count = len(normalize(block.transcript))
        match_chars = matches_by_block[block.index]
        threshold = max(MIN_MATCH_CHARS, norm_char_count * MIN_MATCH_RATIO)

        if match_chars < threshold or norm_char_count == 0:
            results.append(
                BlockResult(
                    block=block,
                    norm_char_count=norm_char_count,
                    match_chars=match_chars,
                    spoken_start=None,
                    spoken_end=None,
                    delta_start=None,
                    delta_end=None,
                )
            )
            continue

        spoken_start = min(starts_by_block[block.index])
        spoken_end = max(ends_by_block[block.index])
        results.append(
            BlockResult(
                block=block,
                norm_char_count=norm_char_count,
                match_chars=match_chars,
                spoken_start=spoken_start,
                spoken_end=spoken_end,
                delta_start=block.start_time - spoken_start,
                delta_end=block.end_time - spoken_end,
            )
        )
    return results


# --- 発話中の字幕欠落検出 --------------------------------------------------------


def _merge_intervals(intervals: list[tuple[float, float]]) -> list[tuple[float, float]]:
    merged: list[tuple[float, float]] = []
    for start, end in sorted(intervals):
        if merged and start <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))
    return merged


def build_speech_intervals(words: list[CappedWord], merge_gap: float) -> list[SpeechInterval]:
    """CAP適用後の単語列から発話区間を再構成する。

    単語は start 昇順に走査し、直前の区間の終端 (effective_end) から次の単語の
    start までの間隔が merge_gap 秒未満なら同一発話区間として結合する。これにより
    WhisperX セグメント内部の長いポーズ（無音）を「発話中」と誤検出しないようにする。
    """
    intervals: list[SpeechInterval] = []
    for w in words:
        if w.end <= w.start:
            continue
        if intervals and w.start - intervals[-1].end < merge_gap:
            last = intervals[-1]
            intervals[-1] = SpeechInterval(start=last.start, end=max(last.end, w.end))
        else:
            intervals.append(SpeechInterval(start=w.start, end=w.end))
    return intervals


def find_speech_holes(
    intervals: list[SpeechInterval], blocks: list[FinalBlock]
) -> list[SpeechHole]:
    """再構成した発話区間のうち、最終字幕キューが覆っていない区間
    (> HOLE_THRESHOLD_SEC 秒) を列挙する。
    """
    covered = _merge_intervals(
        [(b.start_time, b.end_time) for b in blocks if b.end_time > b.start_time]
    )

    holes: list[SpeechHole] = []
    for idx, interval in enumerate(intervals):
        cursor = interval.start
        for cov_start, cov_end in covered:
            if cov_end <= interval.start or cov_start >= interval.end:
                continue
            clipped_start = max(cov_start, interval.start)
            clipped_end = min(cov_end, interval.end)
            if clipped_start > cursor:
                gap = clipped_start - cursor
                if gap > HOLE_THRESHOLD_SEC:
                    holes.append(SpeechHole(interval_index=idx, start=cursor, end=clipped_start))
            cursor = max(cursor, clipped_end)
        if interval.end > cursor:
            gap = interval.end - cursor
            if gap > HOLE_THRESHOLD_SEC:
                holes.append(SpeechHole(interval_index=idx, start=cursor, end=interval.end))
    return holes


# --- 出力: 標準出力の表 ----------------------------------------------------------


def _fmt_time(value: float | None) -> str:
    return "-" if value is None else f"{value:8.3f}"


def _fmt_delta(value: float | None) -> str:
    if value is None:
        return "-"
    mark = "*" if abs(value) > BIG_DELTA_THRESHOLD_SEC else " "
    return f"{value:+7.3f}{mark}"


def _fmt_pct(value: float) -> str:
    return f"{value * 100:5.1f}%"


def print_table(results: list[BlockResult]) -> None:
    header = (
        f"{'id':>6} {'assigned_start':>14} {'assigned_end':>14} "
        f"{'spoken_start':>13} {'spoken_end':>13} {'Δstart':>9} {'Δend':>9} {'match%':>7}"
    )
    print(header)
    print("-" * len(header))
    for r in results:
        b = r.block
        print(
            f"{b.block_id:>6} {b.start_time:14.3f} {b.end_time:14.3f} "
            f"{_fmt_time(r.spoken_start):>13} {_fmt_time(r.spoken_end):>13} "
            f"{_fmt_delta(r.delta_start):>9} {_fmt_delta(r.delta_end):>9} "
            f"{_fmt_pct(r.match_rate):>7}"
        )
    print()
    print("(*: |delta| > %.1fs)" % BIG_DELTA_THRESHOLD_SEC)


# --- 出力: CSV -------------------------------------------------------------------


def write_csv(results: list[BlockResult], out_path: Path) -> None:
    fieldnames = [
        "index",
        "block_id",
        "assigned_start",
        "assigned_end",
        "spoken_start",
        "spoken_end",
        "delta_start",
        "delta_end",
        "norm_char_count",
        "match_chars",
        "match_rate",
        "resolvable",
        "transcript",
    ]
    with open(out_path, "w", encoding="utf-8", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(fieldnames)
        for r in results:
            b = r.block
            writer.writerow(
                [
                    b.index,
                    b.block_id,
                    round(b.start_time, 4),
                    round(b.end_time, 4),
                    None if r.spoken_start is None else round(r.spoken_start, 4),
                    None if r.spoken_end is None else round(r.spoken_end, 4),
                    None if r.delta_start is None else round(r.delta_start, 4),
                    None if r.delta_end is None else round(r.delta_end, 4),
                    r.norm_char_count,
                    r.match_chars,
                    round(r.match_rate, 4),
                    r.resolvable,
                    b.transcript,
                ]
            )


# --- 出力: Markdown レポート -------------------------------------------------------


def _median(values: list[float]) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    n = len(ordered)
    mid = n // 2
    if n % 2 == 1:
        return ordered[mid]
    return (ordered[mid - 1] + ordered[mid]) / 2.0


def write_report(
    results: list[BlockResult],
    segments: list[WhisperXSegmentInfo],
    speech_intervals: list[SpeechInterval],
    holes: list[SpeechHole],
    max_word_dur: float,
    out_path: Path,
) -> None:
    resolvable = [r for r in results if r.resolvable]
    unresolvable_count = len(results) - len(resolvable)

    start_deltas = [r.delta_start for r in resolvable if r.delta_start is not None]
    end_deltas = [r.delta_end for r in resolvable if r.delta_end is not None]

    start_over_count = sum(1 for d in start_deltas if abs(d) > BIG_DELTA_THRESHOLD_SEC)
    end_over_count = sum(1 for d in end_deltas if abs(d) > BIG_DELTA_THRESHOLD_SEC)
    start_over_ratio = (start_over_count / len(results)) if results else 0.0
    end_over_ratio = (end_over_count / len(results)) if results else 0.0

    total_hole_sec = sum(h.duration for h in holes)

    seg_count = len(segments)
    seg_avg_dur = (sum(s.duration for s in segments) / seg_count) if seg_count else 0.0
    block_count = len(results)
    interval_count = len(speech_intervals)

    drift_confirmed = (
        start_over_ratio >= DRIFT_RATIO_THRESHOLD
        or total_hole_sec >= DRIFT_HOLE_TOTAL_THRESHOLD_SEC
    )
    verdict = "TIMING DRIFT CONFIRMED" if drift_confirmed else "NO SIGNIFICANT DRIFT"

    worst = sorted(
        (r for r in resolvable if r.max_abs_delta is not None),
        key=lambda r: r.max_abs_delta or 0.0,
        reverse=True,
    )[:WORST_CASE_TOP_N]

    lines: list[str] = [
        "# WhisperX vs 最終字幕ブロック タイミングドリフト検証レポート",
        "",
        "## サマリ",
        f"- WhisperX セグメント数: {seg_count} (平均 {seg_avg_dur:.2f} 秒/セグメント、参考値)",
        f"- 再構成した発話区間数 (CAP={max_word_dur:.2f}s, 結合閾値={SPEECH_MERGE_GAP_SEC:.2f}s): "
        f"{interval_count}",
        f"- 最終字幕キュー数: {block_count}",
        f"- アライメント対応不能ブロック数 (マッチ文字数不足): {unresolvable_count} / {block_count}",
        "",
        "## 主指標: |Δstart| (開始時刻のズレ。ポーズ吸収の影響を受けないため最も信頼できる)",
        f"- |Δstart| > {BIG_DELTA_THRESHOLD_SEC:.1f}s のブロック: "
        f"{start_over_count} / {block_count} ({start_over_ratio * 100:.1f}%)",
        f"- Δstart 中央値: {_fmt_stat(_median(start_deltas))}",
        f"- Δstart 最大絶対値: {_fmt_stat(_max_abs(start_deltas))}",
        "",
        "## 副指標: |Δend| (spoken_end はCAP適用後の値である点に注意)",
        f"- |Δend| > {BIG_DELTA_THRESHOLD_SEC:.1f}s のブロック: "
        f"{end_over_count} / {block_count} ({end_over_ratio * 100:.1f}%)",
        f"- Δend 中央値: {_fmt_stat(_median(end_deltas))}",
        f"- Δend 最大絶対値: {_fmt_stat(_max_abs(end_deltas))}",
        "",
        "## 発話中なのに字幕キューが存在しない区間 (穴)",
        f"- 定義: 単語 duration を MAX_WORD_DURATION_SEC={max_word_dur:.2f}s でCAPした上で、"
        f"間隔が SPEECH_MERGE_GAP_SEC={SPEECH_MERGE_GAP_SEC:.2f}s 未満の隣接語を結合して"
        "発話区間を再構成し、そのうち字幕キューが覆っていない "
        f"{HOLE_THRESHOLD_SEC}秒超の区間を穴として計上する"
        "（旧実装はWhisperXセグメント区間をそのまま使っていたため、セグメント内部の"
        "無音を欠落と誤検出していた）。",
        f"- 合計: {total_hole_sec:.3f} 秒 ({len(holes)} 箇所)",
    ]
    if holes:
        for h in sorted(holes, key=lambda h: h.duration, reverse=True):
            lines.append(
                f"  - interval {h.interval_index}: {h.start:.3f}s - {h.end:.3f}s "
                f"({h.duration:.3f}秒)"
            )
    else:
        lines.append("  - 該当なし")

    lines.extend(["", "## 最悪ケース上位 %d 件 (|Δ| 絶対値順)" % WORST_CASE_TOP_N])
    if worst:
        for r in worst:
            b = r.block
            excerpt = b.transcript[:60]
            lines.append(
                f"- block {b.block_id} (index {b.index}): "
                f"Δstart={_fmt_stat(r.delta_start)}, Δend={_fmt_stat(r.delta_end)}, "
                f"match={r.match_rate * 100:.1f}%, "
                f"assigned=[{b.start_time:.3f}, {b.end_time:.3f}], "
                f'transcript="{excerpt}"'
            )
    else:
        lines.append("- 該当なし")

    lines.extend(
        [
            "",
            "## 判定",
            f"**{verdict}**",
            "",
            f"- 判定条件: |Δstart|>{BIG_DELTA_THRESHOLD_SEC}s のブロックが全体の "
            f"{DRIFT_RATIO_THRESHOLD * 100:.0f}%以上、"
            f"または発話中の字幕欠落（上記の発話区間ベース定義）が合計 "
            f"{DRIFT_HOLE_TOTAL_THRESHOLD_SEC}秒以上",
            f"- 実測: |Δstart|>{BIG_DELTA_THRESHOLD_SEC}s = {start_over_ratio * 100:.1f}%, "
            f"字幕欠落合計 = {total_hole_sec:.3f}秒",
            "",
            "## 補足",
            "- spoken_start/spoken_end は WhisperX 単語（1文字単位）ストリームと最終字幕",
            "  transcript ストリームを difflib.SequenceMatcher でアライメントし、",
            "  マッチした文字に割り当てられた ASR 側の時刻区間 [start_k, end_k) の",
            "  最小 start_k / 最大 end_k から求めた推定値（中点ではなく区間の下端/上端）。",
            f"- 単語 duration は {max_word_dur:.2f}s でCAPしてから文字時刻を補間する",
            "  （WhisperXが文間ポーズを直前モーラのendに吸収するため）。",
            "- delta_start = assigned_start - spoken_start "
            "(正: 字幕表示が実際の発話より遅い / 負: 早い)",
            "- delta_end = assigned_end - spoken_end "
            "(正: 字幕終了が実際の発話終了より遅い / 負: 早い。spoken_endはCAP後の値)",
            f"- マッチ文字数が max({MIN_MATCH_CHARS}, 正規化文字数×{MIN_MATCH_RATIO}) 未満の",
            "  ブロックは「対応不能」として delta を出していない (信頼できないため)。",
        ]
    )

    with open(out_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")


def _fmt_stat(value: float | None) -> str:
    return "N/A" if value is None else f"{value:+.3f}s"


def _max_abs(values: list[float]) -> float | None:
    if not values:
        return None
    return max(abs(v) for v in values)


# --- CLI ------------------------------------------------------------------------


def _build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "WhisperX 生タイムスタンプと最終字幕ブロックのタイムスタンプを、"
            "テキストアライメント（difflib.SequenceMatcher）で突合する。"
        )
    )
    parser.add_argument("--whisperx", type=Path, required=True, help="whisperx_raw.json のパス")
    parser.add_argument("--project", type=Path, required=True, help="プロジェクト JSON のパス")
    parser.add_argument("--out", type=Path, required=True, help="レポート出力先ディレクトリ")
    parser.add_argument(
        "--spans",
        type=Path,
        default=None,
        help=(
            "before/after比較用。[{id, startSec, endSec}, ...] のJSON配列。"
            "プロジェクトJSONの該当ブロック(id突合)のstartTime/endTimeをこの値で"
            "置き換えて同じ分析を行う。テキストやidはプロジェクト側のものを使う。"
            "spansに含まれるidがプロジェクトのブロックに存在しない場合はエラーになる。"
        ),
    )
    parser.add_argument(
        "--max-word-dur",
        dest="max_word_dur",
        type=float,
        default=MAX_WORD_DURATION_SEC,
        help=(
            "単語durationの上限秒（デフォルト %(default)s）。WhisperXが文間ポーズを"
            "直前モーラのendに吸収するのを補正するためのCAP。"
        ),
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _build_arg_parser().parse_args(argv)

    with open(args.whisperx, encoding="utf-8") as f:
        whisperx_data = json.load(f)
    with open(args.project, encoding="utf-8") as f:
        project_data = json.load(f)

    segments = load_whisperx_segments(whisperx_data)
    capped_words = load_capped_words(whisperx_data, args.max_word_dur)
    asr_str, asr_starts, asr_ends = build_asr_char_stream(capped_words)

    blocks = load_final_blocks(project_data)
    if args.spans is not None:
        with open(args.spans, encoding="utf-8") as f:
            spans_data = json.load(f)
        spans = parse_spans(spans_data)
        blocks = apply_spans(blocks, spans)

    final_str, block_of_char = build_final_char_stream(blocks)

    print(f"ASR chars: {len(asr_str)}  final chars: {len(final_str)}")

    results = align_blocks(asr_str, asr_starts, asr_ends, final_str, block_of_char, blocks)

    speech_intervals = build_speech_intervals(capped_words, SPEECH_MERGE_GAP_SEC)
    holes = find_speech_holes(speech_intervals, blocks)

    args.out.mkdir(parents=True, exist_ok=True)
    csv_path = args.out / "timing_diff.csv"
    report_path = args.out / "timing_report.md"

    write_csv(results, csv_path)
    write_report(results, segments, speech_intervals, holes, args.max_word_dur, report_path)

    print_table(results)
    print()
    print(f"CSV: {csv_path}")
    print(f"Report: {report_path}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
