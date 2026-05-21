"""字幕キュー (Cue) のデータモデルと再セグメンテーション (re_segment).

調査 (docs/research/20260520_human_subtitler_techniques.md) の通り、
ASRセグメント (中央値26秒) はそのままでは字幕キューになり得ない。

【設計 — 2026-05-21 改訂 (本番 splitJa.ts 準拠)】
当初の Design A (強モデルの分割呼び出しの中で破綻日本語を修復) は破棄した。
本番フロントエンド (docs/research/20260521_production_pipeline_disfluency_handling.md)
は校正と分割を分離しており、PoC もこれに合わせる:

    correct (LLM校正, correct.py) → re_segment (分割+アライン) → translate

re_segment の責務は分割とタイムスタンプ・アラインのみ。テキストは改変しない
(校正は工程0 correct.py が済ませている)。

分割は PoC 優位点を維持する: 強モデルが意味の塊で分割候補を複数提案し、コードが
制約スコア (cue.score_candidate) で採点して最良候補を採用する。本番の純句読点
分割と違い 7秒制約・CPS見積りを分割段階で考慮できる (CLAUDE.md大原則:
LLM=意味, コード=数値制約)。

タイムスタンプは本番 splitJa.ts の3段階アラインを移植する:
  - 優先1 (exact)        : 各ピース先頭の正規化テキストを whisperX の word列に
                           プレフィックスマッチし、該当 word の時刻を直接使う。
                           校正でテキストが変わっても先頭が一致すれば回収できる。
  - 優先2 (proportional) : 文字数累積比率で境界 word を推定。
  - 優先3 (proportional) : word が無い場合、純粋に文字数比率で時間推定。
各 Cue は alignConf 相当の `align_conf` を保持し、時刻の精度を記録する。

強モデルが無い・全候補が逸脱しすぎ・呼び出し失敗 のときは均等分割にフォールバック。
"""

import math
import re
from dataclasses import dataclass, replace

from poc.subtitle_agent import constants, prompts
from poc.subtitle_agent.llm import clean_llm_output
from poc.subtitle_agent.llm_backend import LLMBackend

CLAUSE_DELIMITER = "|"

# 本番 splitJa.ts normalizeTimingText 準拠。タイミング照合用に句読点・空白を除く。
_TIMING_STRIP_RE = re.compile(r"[。、「」『』（）()［］\[\]！？!?・,，、.\s]")


@dataclass(frozen=True)
class Cue:
    """字幕キュー1件。immutable。更新は dataclasses.replace / with_en で行う。"""

    id: int
    source_segment_id: int
    start: float
    end: float
    ja: str            # このキューに対応する日本語原文 (校正済み)
    en: str = ""       # 英語字幕 (翻訳後に充填)
    status: str = "PENDING"           # PENDING / PASS / VIOLATED / FLAGGED
    align_conf: str = "proportional"  # 時刻精度: exact / proportional
    applied_strategies: tuple[str, ...] = ()

    @property
    def duration(self) -> float:
        return max(0.0, self.end - self.start)

    def with_en(self, en: str, strategy: str | None = None) -> "Cue":
        strategies = self.applied_strategies
        if strategy:
            strategies = strategies + (strategy,)
        return replace(self, en=en, applied_strategies=strategies)


@dataclass(frozen=True)
class _CueSpec:
    """分割候補の1ピース。時刻とアライン精度を持つ採点・変換用の中間表現。"""

    text: str
    start: float
    end: float
    align_conf: str  # exact / proportional


def _norm_timing(text: str) -> str:
    """タイミング照合用の正規化。句読点・空白を除去する (本番 normalizeTimingText)。"""
    return _TIMING_STRIP_RE.sub("", text)


def _split_by_duration(
    text: str, start: float, end: float, max_dur: float
) -> list[tuple[str, float, float]]:
    """テキストと時間範囲を、max_dur 以下になるよう均等分割する。"""
    span = max(0.1, end - start)
    parts = max(1, math.ceil(span / max_dur))
    if parts == 1:
        return [(text, start, end)]
    chunks: list[tuple[str, float, float]] = []
    for i in range(parts):
        c_start = start + span * i / parts
        c_end = start + span * (i + 1) / parts
        t_lo = len(text) * i // parts
        t_hi = len(text) * (i + 1) // parts
        chunks.append((text[t_lo:t_hi], round(c_start, 3), round(c_end, 3)))
    return chunks


def _segment_text(asr_segment: dict) -> str:
    return (
        asr_segment.get("ja_corrected")
        or asr_segment.get("text")
        or asr_segment.get("ja", "")
    )


def _even_split(asr_segment: dict, next_cue_id: int) -> list[Cue]:
    """強モデル分割が使えない場合のフォールバック: 時間均等分割。"""
    seg_id = asr_segment["id"]
    ja = _segment_text(asr_segment)
    start = float(asr_segment["start"])
    end = float(asr_segment["end"])
    cues: list[Cue] = []
    cue_id = next_cue_id
    for chunk, c_start, c_end in _split_by_duration(
        ja, start, end, constants.TARGET_CUE_DURATION
    ):
        cues.append(
            Cue(
                id=cue_id,
                source_segment_id=seg_id,
                start=c_start,
                end=c_end,
                ja=chunk.strip(),
            )
        )
        cue_id += 1
    return cues


def _candidate_sane(joined: str, original: str) -> bool:
    """候補がテキストを改変していないか確認する (分割は '|' 挿入のみ許す).

    校正は工程0 (correct.py) の責務。re_segment の強モデルは分割のみ行う。
    句読点・空白の差は許容するが、語句の追加・欠落・幻覚を起こした候補は弾く。
    """
    return bool(joined.strip()) and _norm_timing(joined) == _norm_timing(original)


def _find_boundary_word_index(
    word_norm_texts: list[str],
    word_concat: str,
    piece_norm: str,
    search_after_word_idx: int,
) -> int | None:
    """優先1: ピース先頭の正規化テキストを word列にプレフィックスマッチする。

    本番 splitJa.ts findBoundaryWordIndex の移植。先頭6文字を search_after 番目
    以降の word から探し、該当 word のインデックスを返す。無ければ None。
    """
    prefix = piece_norm[: min(6, len(piece_norm))]
    if not prefix:
        return None
    after_char_pos = sum(
        len(word_norm_texts[i])
        for i in range(min(search_after_word_idx, len(word_norm_texts)))
    )
    match_char_pos = word_concat.find(prefix, after_char_pos)
    if match_char_pos == -1:
        return None
    cum = 0
    for i, t in enumerate(word_norm_texts):
        if cum + len(t) > match_char_pos:
            return i
        cum += len(t)
    return None


def _char_proportional_word_index(
    word_norm_chars: list[int],
    total_word_chars: int,
    piece_char_counts: list[int],
    piece_index: int,
    total_piece_chars: int,
) -> int:
    """優先2: 文字数累積比率で境界 word インデックスを推定する。

    本番 splitJa.ts charProportionalWordIndex の移植。
    """
    chars_before = sum(max(1, c) for c in piece_char_counts[:piece_index])
    target = (chars_before / max(1, total_piece_chars)) * total_word_chars
    cum = 0
    for j, wc in enumerate(word_norm_chars):
        if cum > target:
            return j
        cum += wc
    return len(word_norm_chars)


def _proportional_specs(
    pieces: list[str],
    piece_char_counts: list[int],
    total_piece_chars: int,
    seg_start: float,
    seg_end: float,
) -> list[_CueSpec]:
    """優先3: word が無い場合の純文字比例による時刻割り当て。"""
    duration = max(0.1, seg_end - seg_start)
    specs: list[_CueSpec] = []
    last = len(pieces) - 1
    for i, piece in enumerate(pieces):
        chars_before = sum(max(1, c) for c in piece_char_counts[:i])
        chars_upto = sum(max(1, c) for c in piece_char_counts[: i + 1])
        start = (
            seg_start
            if i == 0
            else seg_start + duration * chars_before / total_piece_chars
        )
        end = (
            seg_end
            if i == last
            else seg_start + duration * chars_upto / total_piece_chars
        )
        end = max(start + 0.05, end)
        specs.append(_CueSpec(piece, round(start, 3), round(end, 3), "proportional"))
    return specs


def _candidate_specs(
    marked: str,
    words: list[dict],
    seg_start: float,
    seg_end: float,
) -> list[_CueSpec]:
    """候補 ('|' 区切り) を _CueSpec のリストへ変換する (本番 splitJa の3段階アライン).

    各ピースについて優先1 (プレフィックスマッチ) → 優先2 (文字比例) で先頭 word を
    確定し、word が取れれば exact、取れなければ proportional の時刻を割り当てる。
    word列が空なら全ピース優先3 (純文字比例)。
    """
    pieces = [p.strip() for p in marked.split(CLAUSE_DELIMITER) if p.strip()]
    if not pieces:
        return []

    duration = max(0.1, seg_end - seg_start)
    piece_char_counts = [len(_norm_timing(p)) for p in pieces]
    total_piece_chars = sum(max(1, c) for c in piece_char_counts)

    seg_words = [w for w in words if w]
    if not seg_words:
        return _proportional_specs(
            pieces, piece_char_counts, total_piece_chars, seg_start, seg_end
        )

    word_norm_texts = [_norm_timing(str(w.get("word", ""))) for w in seg_words]
    word_concat = "".join(word_norm_texts)
    word_norm_chars = [max(1, len(t)) for t in word_norm_texts]
    total_word_chars = sum(word_norm_chars)

    # 各ピースの先頭 word インデックスを確定する。
    start_word_idx = [0] * len(pieces)
    for i in range(1, len(pieces)):
        prev = start_word_idx[i - 1]
        piece_norm = _norm_timing(pieces[i])
        matched = _find_boundary_word_index(
            word_norm_texts, word_concat, piece_norm, prev
        )
        if matched is not None and matched > prev:
            start_word_idx[i] = matched
        else:
            fallback = _char_proportional_word_index(
                word_norm_chars,
                total_word_chars,
                piece_char_counts,
                i,
                total_piece_chars,
            )
            start_word_idx[i] = min(
                max(prev + 1, fallback), len(seg_words) - 1
            )

    specs: list[_CueSpec] = []
    last = len(pieces) - 1
    for i, piece in enumerate(pieces):
        w_start = start_word_idx[i]
        w_end = start_word_idx[i + 1] if i < last else len(seg_words)
        sliced = seg_words[w_start:w_end]

        chars_before = sum(max(1, c) for c in piece_char_counts[:i])
        chars_upto = sum(max(1, c) for c in piece_char_counts[: i + 1])
        prop_start = (
            seg_start
            if i == 0
            else seg_start + duration * chars_before / total_piece_chars
        )
        prop_end = (
            seg_end
            if i == last
            else seg_start + duration * chars_upto / total_piece_chars
        )

        first_t = sliced[0].get("start") if sliced else None
        last_t = sliced[-1].get("end") if sliced else None
        if sliced and first_t is not None and last_t is not None:
            start, end, conf = float(first_t), float(last_t), "exact"
        else:
            start, end, conf = prop_start, prop_end, "proportional"
        end = max(start + 0.05, end)
        specs.append(_CueSpec(piece, round(start, 3), round(end, 3), conf))
    return specs


def score_candidate(specs: list[_CueSpec], expansion_k: float) -> float:
    """分割候補を制約スコアで採点する (低いほど良い)。

    翻訳前に行うため英語文字数は `ja長 × expansion_k` で見積もる。
    各キューについて推定CPS超過・最長表示時間超過・短尺(快適下限未満)を罰する。
    キュー数が異なる候補を比較できるようキュー平均ペナルティを返す。
    """
    if not specs:
        return float("inf")
    total = 0.0
    for spec in specs:
        dur = max(0.001, spec.end - spec.start)
        est_cps = expansion_k * len(spec.text) / dur
        cps_over = max(0.0, (est_cps - constants.TARGET_CPS) / constants.TARGET_CPS)
        long_over = max(
            0.0, (dur - constants.MAX_CUE_DURATION) / constants.MAX_CUE_DURATION
        )
        short = 0.0
        if dur < constants.COMFORT_MIN_CUE_DURATION:
            short = (
                constants.COMFORT_MIN_CUE_DURATION - dur
            ) / constants.COMFORT_MIN_CUE_DURATION
        if dur < constants.MIN_CUE_DURATION:
            short += 2.0  # ハード下限割れは強く罰する
        total += (
            constants.W_CPS * cps_over
            + constants.W_CPS * long_over
            + constants.W_DURATION * short
        )
    return total / len(specs)


def _propose_candidates(
    ja: str,
    duration: float,
    strong_backend: LLMBackend,
    segment_prompt: str,
) -> list[str]:
    """強モデルに意味の塊での分割候補を複数提案させる。"""
    target = max(1, round(duration / constants.TARGET_CUE_DURATION))
    user = (
        f"Segment duration: {duration:.1f} seconds. "
        f"Aim for about {target} cues; each cue should ideally stay on screen "
        f"{constants.COMFORT_MIN_CUE_DURATION:.1f}-"
        f"{constants.MAX_CUE_DURATION:.0f} seconds. Japanese text:\n{ja}"
    )
    resp = clean_llm_output(strong_backend.complete(segment_prompt, user, 0.4))
    return re.findall(r"<candidate>(.*?)</candidate>", resp, re.DOTALL)


def _specs_to_cues(
    specs: list[_CueSpec],
    seg_id: int,
    next_cue_id: int,
) -> list[Cue]:
    """_CueSpec リストを Cue 群へ変換する。

    最長表示時間を超えるピースはさらに均等分割する (端数処理のフォールバック)。
    その内部境界は文字比例推定になるため align_conf を proportional へ降格する。
    """
    cues: list[Cue] = []
    cue_id = next_cue_id
    for spec in specs:
        chunks = _split_by_duration(
            spec.text, spec.start, spec.end, constants.MAX_CUE_DURATION
        )
        conf = "proportional" if len(chunks) > 1 else spec.align_conf
        for chunk, s, e in chunks:
            piece = chunk.strip()
            if not piece:
                continue
            cues.append(
                Cue(
                    id=cue_id,
                    source_segment_id=seg_id,
                    start=round(s, 3),
                    end=round(e, 3),
                    ja=piece,
                    align_conf=conf,
                )
            )
            cue_id += 1
    return cues


def re_segment(
    asr_segment: dict,
    next_cue_id: int,
    strong_backend: LLMBackend | None = None,
    segment_prompt: str = prompts.DEFAULT.segment,
    expansion_k: float = constants.JA_EN_EXPANSION_K,
) -> list[Cue]:
    """1つのASRセグメントを字幕キュー群へ再分割する。

    strong_backend が与えられれば「候補提案 → 制約採点 → 最良採用」を行い、
    本番 splitJa の3段階アラインでタイムスタンプを割り当てる。
    無い場合・全候補がテキストを改変・呼び出し失敗 のときは均等分割にフォール
    バックする (1件の失敗で実行全体を止めない)。
    """
    seg_id = asr_segment["id"]
    ja = _segment_text(asr_segment)
    words = asr_segment.get("words") or []
    seg_start = float(asr_segment["start"])
    seg_end = float(asr_segment["end"])
    duration = seg_end - seg_start

    if strong_backend is None:
        return _even_split(asr_segment, next_cue_id)

    best_specs: list[_CueSpec] | None = None
    best_penalty = float("inf")
    try:
        for _ in range(2):  # 全候補が無効なら1回だけ再試行
            for cand in _propose_candidates(
                ja, duration, strong_backend, segment_prompt
            ):
                cand = cand.strip()
                joined = "".join(cand.split(CLAUSE_DELIMITER))
                if not _candidate_sane(joined, ja):
                    continue
                specs = _candidate_specs(cand, words, seg_start, seg_end)
                if not specs:
                    continue
                penalty = score_candidate(specs, expansion_k)
                if penalty < best_penalty:
                    best_penalty, best_specs = penalty, specs
            if best_specs is not None:
                break
    except RuntimeError as e:
        print(f"  [re_segment] seg {seg_id}: 強モデル呼び出し失敗 -> 均等分割 ({e})")
        return _even_split(asr_segment, next_cue_id)

    if best_specs is None:
        return _even_split(asr_segment, next_cue_id)

    cues = _specs_to_cues(best_specs, seg_id, next_cue_id)
    return cues if cues else _even_split(asr_segment, next_cue_id)


def re_segment_all(
    asr_segments: list[dict],
    strong_backend: LLMBackend | None = None,
    segment_prompt: str = prompts.DEFAULT.segment,
    expansion_k: float = constants.JA_EN_EXPANSION_K,
    max_cues: int | None = None,
) -> list[Cue]:
    """全ASRセグメントを連続IDのキュー群へ再分割する。

    max_cues を与えると、その件数に達した時点で再分割を打ち切る (動作確認用)。
    """
    cues: list[Cue] = []
    next_id = 1
    for i, seg in enumerate(asr_segments, start=1):
        new_cues = re_segment(
            seg, next_id, strong_backend, segment_prompt, expansion_k
        )
        cues.extend(new_cues)
        next_id += len(new_cues)
        if strong_backend is not None and i % 20 == 0:
            print(f"  [re_segment] {i}/{len(asr_segments)} ASRセグメント処理済み")
        if max_cues is not None and len(cues) >= max_cues:
            break
    return cues
