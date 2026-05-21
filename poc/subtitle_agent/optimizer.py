"""製品パイプライン A — キューベースの字幕最適化.

処理フロー:
  0. correct      : ASRセグメントをLLM日本語校正 (破綻日本語修復, correct.py)
  1. re_segment   : ASRセグメントを字幕キューへ再分割 (カード1)
  2. translate    : 各キューを英訳
  3. line_break   : 2行レイアウト (カード6)
  4. evaluate     : CPS・行長・セグメント長・意味保持を評価
  5. repair       : 違反キューを condense_text で凝縮 (カード2) し最良をキープ
  6. aggregate    : 全キューを対象に合格率・平均類似度・平均スコアを集計

評価・集計は「全キュー」を対象にする (違反キューに限定しない)。
"""

from dataclasses import dataclass, replace

import openai

from poc.subtitle_agent import constants, prompts
from poc.subtitle_agent.correct import correct_segments
from poc.subtitle_agent.cue import Cue, re_segment_all
from poc.subtitle_agent.evaluate import EvalResult, evaluate_subtitle
from poc.subtitle_agent.llm import translate_ja_to_en
from poc.subtitle_agent.llm_backend import LLMBackend
from poc.subtitle_agent.strategies import apply_line_break, condense_text, severity_for

MAX_CONDENSE_ROUNDS = 3


@dataclass(frozen=True)
class CueResult:
    """1キューの最適化結果。"""

    cue: Cue
    evaluation: EvalResult
    llm_calls: int


@dataclass(frozen=True)
class OptimizeResult:
    """パイプライン A の1回の実行結果。集計は全キュー対象。"""

    cue_results: list[CueResult]
    total: int
    compliant: int
    compliance_rate: float
    avg_similarity: float
    avg_score: float
    rejected: int
    prompt_label: str


def _with_status(cue: Cue, status: str) -> Cue:
    return replace(cue, status=status)


def _repair_cue(
    cue: Cue,
    evaluation: EvalResult,
    client: openai.OpenAI,
    prompt_set: prompts.PromptSet,
    chat_model: str,
    emb_model: str,
) -> CueResult:
    """違反キューを凝縮 (condense_text) で修復する。最良スコアの候補をキープする。"""
    best = CueResult(cue=cue, evaluation=evaluation, llm_calls=1)
    work = cue
    calls = 1

    for _ in range(MAX_CONDENSE_ROUNDS):
        if best.evaluation.compliant:
            break
        severity = severity_for(best.evaluation.cps)
        shorter = condense_text(
            work.en, severity, client, chat_model, prompt_set.condense
        )
        calls += 1
        candidate = work.with_en(apply_line_break(shorter), "condense_text")
        cand_eval = evaluate_subtitle(
            candidate.ja,
            candidate.en,
            candidate.start,
            candidate.end,
            calls,
            client,
            emb_model,
        )
        if cand_eval.rejected:
            break  # 凝縮しすぎて意味が崩壊 -> これ以上縮めない
        if cand_eval.score > best.evaluation.score:
            best = CueResult(cue=candidate, evaluation=cand_eval, llm_calls=calls)
        work = candidate

    status = "PASS" if best.evaluation.compliant else "FLAGGED"
    return CueResult(_with_status(best.cue, status), best.evaluation, best.llm_calls)


def build_cues(
    asr_segments: list[dict],
    strong_backend: LLMBackend | None = None,
    segment_prompt: str = prompts.DEFAULT.segment,
    expansion_k: float = constants.JA_EN_EXPANSION_K,
    limit: int | None = None,
) -> list[Cue]:
    """ASRセグメント群を校正・再分割し字幕キューを得る (パイプライン A の工程0-1)。

    工程0 (correct) と工程1 (re_segment) は強モデル呼び出しを伴い高コストなため、
    自己進化では世代ループの外で1回だけ呼び全世代でキュー集合を固定する
    (校正・分割は進化対象外)。strong_backend は強モデル役。None の場合は校正を
    省き均等分割にフォールバックする。
    """
    if strong_backend is not None:
        print("\n[OPTIMIZE] >>> 0. correct: ASRセグメントをLLM日本語校正...")
        asr_segments = correct_segments(asr_segments, strong_backend)

    print("\n[OPTIMIZE] >>> 1. re_segment: ASRセグメントを字幕キューへ再分割...")
    cues = re_segment_all(
        asr_segments, strong_backend, segment_prompt, expansion_k, max_cues=limit
    )
    if limit is not None:
        cues = cues[:limit]
    print(f"[OPTIMIZE] {len(asr_segments)} ASRセグメント -> {len(cues)} キュー")
    return cues


def optimize_cues(
    cues: list[Cue],
    client: openai.OpenAI,
    prompt_set: prompts.PromptSet = prompts.DEFAULT,
    chat_model: str = constants.CHAT_MODEL,
    emb_model: str = constants.EMBEDDING_MODEL,
) -> OptimizeResult:
    """固定キュー集合を翻訳・評価・修復し集計する (パイプライン A の工程2以降)。

    自己進化はこの工程だけを世代ごとに回す (translate/condense プロンプトを進化)。
    """
    results: list[CueResult] = []
    for i, cue in enumerate(cues, start=1):
        en = translate_ja_to_en(cue.ja, client, chat_model, prompt_set.translate)
        cue = cue.with_en(apply_line_break(en), "translate")
        evaluation = evaluate_subtitle(
            cue.ja, cue.en, cue.start, cue.end, 1, client, emb_model
        )
        if evaluation.compliant:
            results.append(
                CueResult(_with_status(cue, "PASS"), evaluation, llm_calls=1)
            )
        else:
            results.append(
                _repair_cue(
                    cue, evaluation, client, prompt_set, chat_model, emb_model
                )
            )
        if i % 25 == 0:
            print(f"[OPTIMIZE] {i}/{len(cues)} キュー処理済み")

    total = len(results)
    compliant = sum(1 for r in results if r.evaluation.compliant)
    rejected = sum(1 for r in results if r.evaluation.rejected)
    avg_similarity = (
        sum(r.evaluation.similarity for r in results) / total if total else 0.0
    )
    avg_score = sum(r.evaluation.score for r in results) / total if total else 0.0

    return OptimizeResult(
        cue_results=results,
        total=total,
        compliant=compliant,
        compliance_rate=(compliant / total * 100) if total else 0.0,
        avg_similarity=avg_similarity,
        avg_score=avg_score,
        rejected=rejected,
        prompt_label=prompt_set.label,
    )


def optimize(
    asr_segments: list[dict],
    client: openai.OpenAI,
    prompt_set: prompts.PromptSet = prompts.DEFAULT,
    strong_backend: LLMBackend | None = None,
    chat_model: str = constants.CHAT_MODEL,
    emb_model: str = constants.EMBEDDING_MODEL,
    expansion_k: float = constants.JA_EN_EXPANSION_K,
    limit: int | None = None,
) -> OptimizeResult:
    """パイプライン A を単発実行する (再分割 + 翻訳・評価・修復)。"""
    cues = build_cues(
        asr_segments, strong_backend, prompt_set.segment, expansion_k, limit
    )
    return optimize_cues(cues, client, prompt_set, chat_model, emb_model)
