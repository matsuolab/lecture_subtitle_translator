"""自己進化ハーネス B — オフライン最適化ループ.

製品パイプライン A を実行 → 全キューのスコアを分析 → メタLLM が PromptSet を改善
→ 再実行、を世代として回す。B は製品には載らず、見つけた良い PromptSet を
A へ反映するためのオフライン最適化ツール。

最適化目標は avg_score (全キュー平均スコア) の最大化のみ。score は
    score = W_ALIGN * 意味類似度 - CPS罰 - 行罰 - セグ罰 - 短尺罰
であり、制約違反 (CPS等) と意味忠実度の両方を1つの勾配に統合している。
過剰凝縮は意味類似度を下げるため avg_score 最適化では自然に抑制される。

【閉ループ設計 — 2026-05-21】
旧ループはメタLLMが新プロンプトを出すだけで「その変更が効いたか」を一度も
観測しない開ループだった。本実装はメタLLMに次を必ず観測させる:
  - 直近世代 vs その前の世代の キュー単位スコア差分 (回帰の可視化)
  - score 損失の要因別内訳 (意味 / CPS / 行 / セグ / 短尺)
  - スコアの世代推移
これによりメタLLMは単発生成ではなく「行動→結果観測→次の判断」を回す
エージェントとして動く。

過剰進化対策:
  - メタプロンプトで各プロンプトを簡潔に保つよう明示的に指示。
  - best-keep: 進化の基点は常に「これまでで最良 (最高 avg_score) の世代」。
"""

import re
from dataclasses import dataclass

import openai

from poc.subtitle_agent import constants, prompts
from poc.subtitle_agent.evaluate import EvalResult
from poc.subtitle_agent.llm_backend import LLMBackend
from poc.subtitle_agent.optimizer import OptimizeResult, build_cues, optimize_cues

WORST_CUE_SLICE = 6     # メタLLM に見せる最悪スコアのキュー数
REGRESSION_SLICE = 5    # メタLLM に見せる回帰キューの最大数
_REGRESSION_EPS = 0.01  # これ未満のスコア低下は誤差として無視する

_META_SYSTEM = "You are a subtitle pipeline optimization agent."


@dataclass(frozen=True)
class GenerationResult:
    """1世代の実行結果。"""

    generation: int
    result: OptimizeResult
    prompt_set: prompts.PromptSet
    focus: str


def fitness(result: OptimizeResult) -> float:
    """世代の総合適応度 = 全キュー平均スコア。スコア向上が唯一の最適化目標。"""
    return result.avg_score


def _cue_losses(e: EvalResult) -> dict[str, float]:
    """1キューの *回収可能な* score 損失を要因別に分解する。

    意味要因は 1.0 ではなく REFERENCE_SIMILARITY (良訳の典型類似度) を基準にする。
    日英埋め込み類似度は完璧な翻訳でも ~0.86 が上限で、それ以上は回収不能な固定
    コスト。1.0 基準にするとメタLLMが幻の意味改善を追い CPS を犠牲にするため。
    CPS・行・セグ・短尺の罰則は全て回収可能なのでそのまま計上する。
    """
    semantic = constants.W_ALIGN * max(
        0.0, constants.REFERENCE_SIMILARITY - e.similarity
    )
    if e.rejected:
        # 意味崩壊。CPS等の罰則は未計測なので意味要因のみ計上する。
        return {
            "semantic": semantic,
            "CPS": 0.0,
            "line": 0.0,
            "segment": 0.0,
            "short": 0.0,
        }
    return {
        "semantic": semantic,
        "CPS": constants.W_CPS * e.cps_penalty,
        "line": constants.W_LINE * e.line_penalty,
        "segment": constants.W_SEGMENT * e.segment_penalty,
        "short": constants.W_DURATION * e.short_penalty,
    }


def _loss_breakdown(result: OptimizeResult) -> dict[str, float]:
    """全キューの score 損失を要因別に集計する。"""
    totals: dict[str, float] = {
        "semantic": 0.0,
        "CPS": 0.0,
        "line": 0.0,
        "segment": 0.0,
        "short": 0.0,
    }
    for r in result.cue_results:
        for cause, amount in _cue_losses(r.evaluation).items():
            totals[cause] += amount
    return totals


def _dominant_cause(e: EvalResult) -> str:
    """このキューで最も score を失っている要因名を返す。"""
    losses = _cue_losses(e)
    return max(losses, key=losses.get)


def _worst_cues(result: OptimizeResult) -> list:
    """score が最も低い (損失が大きい) キューを抽出する (Failure Slicing)。

    旧PoCの知見: 全キューを送るとコンテキスト超過。最悪例に絞る。
    違反キューに限定せず全キューから選ぶ (緩い成功も損失が大きければ拾う)。
    """
    return sorted(result.cue_results, key=lambda r: r.evaluation.score)[
        :WORST_CUE_SLICE
    ]


def _regressions(
    current: OptimizeResult, previous: OptimizeResult | None
) -> list[tuple]:
    """previous 比で score が下がったキューを返す (閉ループの観測材料)。

    返り値: (cue_id, prev_score, cur_score, cue) を低下幅の大きい順。
    """
    if previous is None:
        return []
    prev_scores = {r.cue.id: r.evaluation.score for r in previous.cue_results}
    out: list[tuple] = []
    for r in current.cue_results:
        ps = prev_scores.get(r.cue.id)
        if ps is not None and r.evaluation.score < ps - _REGRESSION_EPS:
            out.append((r.cue.id, ps, r.evaluation.score, r.cue))
    out.sort(key=lambda x: x[1] - x[2], reverse=True)
    return out[:REGRESSION_SLICE]


def _format_worst_cues(result: OptimizeResult) -> str:
    lines: list[str] = []
    for r in _worst_cues(result):
        c, e = r.cue, r.evaluation
        lines.append(
            f"- Cue {c.id} (score {e.score:.2f}, biggest loss: "
            f"{_dominant_cause(e)})\n"
            f"  JA: {c.ja}\n"
            f"  EN: {c.en.replace(chr(10), ' / ')}\n"
            f"  CPS {e.cps:.1f}/{constants.TARGET_CPS} | "
            f"max line {e.line_chars_max}/{constants.MAX_LINE_CHARS} | "
            f"segment {e.segment_chars}/{constants.MAX_SEGMENT_CHARS} | "
            f"similarity {e.similarity:.3f}"
        )
    return "\n".join(lines) if lines else "(none)"


def _format_last_change(history: list[GenerationResult]) -> str:
    """メタLLM に前回の自分の変更の結果を見せる (開ループを閉じる中核)。"""
    if len(history) < 2:
        return "This is the first evolution; there is no prior change to review."
    latest, prev = history[-1], history[-2]
    delta = latest.result.avg_score - prev.result.avg_score
    verb = "improved" if delta >= 0 else "REGRESSED"
    head = (
        f"Your last prompt edit produced generation {latest.generation} "
        f"(avg score {latest.result.avg_score:.4f}). Versus generation "
        f"{prev.generation} ({prev.result.avg_score:.4f}) it {verb} the "
        f"average by {delta:+.4f}."
    )
    regs = _regressions(latest.result, prev.result)
    if not regs:
        return head + " No individual cue regressed."
    lines = [
        head,
        "Cues that REGRESSED (your fix must not sacrifice these again):",
    ]
    for cue_id, ps, cs, c in regs:
        lines.append(
            f"- Cue {cue_id}: score {ps:.2f} -> {cs:.2f}\n"
            f"  JA: {c.ja}\n"
            f"  EN: {c.en.replace(chr(10), ' / ')}"
        )
    return "\n".join(lines)


def _build_meta_prompt(
    history: list[GenerationResult], best: GenerationResult
) -> str:
    """メタLLM へ送るスコア分析・進化指示プロンプトを組み立てる。

    best (進化の基点) のスコア損失内訳・最悪キューと、history (直近の自分の
    変更の結果) を渡し、メタLLMが閉ループで判断できるようにする。
    """
    result = best.result
    loss = _loss_breakdown(result)
    trajectory = "\n".join(
        f"  Gen {g.generation}: avg score {g.result.avg_score:.4f}  "
        f"(compliance {g.result.compliance_rate:.1f}%)"
        for g in history
    )
    loss_lines = "\n".join(
        f"  - {cause:<9}: {amount:.2f}"
        for cause, amount in sorted(
            loss.items(), key=lambda x: x[1], reverse=True
        )
    )
    return (
        "You optimize a Japanese->English lecture subtitle pipeline. Your "
        "single objective is to MAXIMIZE the average quality score over all "
        "cues.\n\n"
        f"Per-cue score = {constants.W_ALIGN}*semantic_similarity - "
        "penalties(CPS, line, segment, too-short). Both higher similarity and "
        "fewer constraint violations raise the score; over-condensing lowers "
        "similarity and therefore lowers the score. Constraints: CPS<="
        f"{constants.TARGET_CPS}, <={constants.MAX_LINE_CHARS} chars/line, "
        f"<={constants.MAX_SEGMENT_CHARS} chars/cue.\n"
        "IMPORTANT: semantic_similarity is a cross-lingual embedding score; even "
        f"a perfect translation tops out around {constants.REFERENCE_SIMILARITY}. "
        "The 'semantic' loss below already counts ONLY the recoverable part "
        "(distance below that ceiling), so do not chase similarity beyond it.\n\n"
        "You tune TWO prompts: [translate] (Japanese->English) and [condense] "
        "(shorten an English subtitle while keeping its meaning). Cue "
        "segmentation is fixed - ignore it.\n\n"
        f"=== SCORE TRAJECTORY ===\n{trajectory}\n\n"
        f"=== RESULT OF YOUR LAST CHANGE ===\n{_format_last_change(history)}\n\n"
        f"=== BEST SO FAR: generation {best.generation} "
        f"(avg score {result.avg_score:.4f}) ===\n"
        f"Total RECOVERABLE score lost across {result.total} cues, by cause "
        f"(attack the largest):\n{loss_lines}\n\n"
        f"=== WORST CUES (lowest score) ===\n{_format_worst_cues(result)}\n\n"
        "=== CURRENT PROMPTS (you evolve from BEST, label: "
        f"{best.prompt_set.label}) ===\n"
        f"[translate]\n{best.prompt_set.translate}\n\n"
        f"[condense]\n{best.prompt_set.condense}\n\n"
        "Decide, in order: (1) which loss cause is dominant, (2) whether it is "
        "a [translate] problem (produce shorter / more faithful English "
        "upstream) or a [condense] problem (shrink without losing meaning), "
        "(3) if your last change regressed any cue, state why and how you will "
        "avoid it now. Then rewrite the two prompts to raise the average "
        "score.\n"
        "CONSTRAINTS on your output:\n"
        "- Keep both prompts CONCISE. Rewrite for clarity; do NOT just append "
        "rules. Bloated prompts hurt the small local translation model.\n"
        "- Output ONLY the XML block below, nothing else:\n\n"
        "<evolution>\n"
        "  <analysis>dominant loss cause + review of your last change</analysis>\n"
        "  <focus>short summary of what this generation improves</focus>\n"
        "  <translate_prompt>improved translate prompt</translate_prompt>\n"
        "  <condense_prompt>improved condense prompt</condense_prompt>\n"
        "</evolution>"
    )


def _extract(tag: str, text: str) -> str | None:
    m = re.search(rf"<{tag}>(.*?)</{tag}>", text, re.DOTALL)
    return m.group(1).strip() if m else None


def evolve_prompts(
    history: list[GenerationResult],
    best: GenerationResult,
    meta_backend: LLMBackend,
) -> tuple[prompts.PromptSet, str, str]:
    """メタLLM にスコアを分析させ、進化した PromptSet を生成する。

    history で前回の変更の結果 (閉ループ) を、best で進化の基点を与える。
    返り値: (新PromptSet, focus, analysis)。
    パース失敗時は best の該当プロンプトをそのまま引き継ぐ。
    """
    gen = history[-1].generation
    print(f"[META-EVOLUTION] >>> 世代 {gen} -> {gen + 1} : メタLLM に分析を依頼...")
    meta_prompt = _build_meta_prompt(history, best)
    resp = meta_backend.complete(_META_SYSTEM, meta_prompt, 0.3)

    analysis = _extract("analysis", resp) or "(analysis 抽出失敗)"
    focus = _extract("focus", resp) or "(focus 抽出失敗)"
    new_translate = _extract("translate_prompt", resp) or best.prompt_set.translate
    new_condense = _extract("condense_prompt", resp) or best.prompt_set.condense

    # segment は進化対象外 (分割は世代ループ外で固定済み)。best から引き継ぐ。
    new_set = prompts.PromptSet(
        translate=new_translate,
        condense=new_condense,
        segment=best.prompt_set.segment,
        label=f"gen{gen + 1}",
    )
    print(f"[META-EVOLUTION] 進化の焦点: {focus}")
    return new_set, focus, analysis


def run_evolution(
    asr_segments: list[dict],
    client: openai.OpenAI,
    generations: int,
    strong_backend: LLMBackend | None,
    meta_backend: LLMBackend,
    limit: int | None = None,
) -> list[GenerationResult]:
    """自己進化メタループを generations 世代回す。

    strong_backend は校正・再分割の強モデル役、meta_backend はプロンプト進化役。
    校正・再分割は進化対象外。世代ループの前に1回だけ実行しキュー集合を全世代で
    固定する (高コストな強モデル呼び出しを世代数ぶん払わず、fitness信号を
    translate/condense の改善に純化するため)。
    best-keep: 進化の基点は常に最良 (最高 avg_score) 世代の PromptSet。
    遵守率100%到達で早期終了。
    """
    cues = build_cues(
        asr_segments, strong_backend, prompts.DEFAULT.segment, limit=limit
    )
    print(f"[EVOLUTION] 再分割完了: {len(cues)} キュー (全世代で固定)")

    history: list[GenerationResult] = []
    prompt_set = prompts.DEFAULT
    focus = "Initial Baseline"
    best: GenerationResult | None = None

    for gen in range(generations):
        print(
            f"\n{'=' * 50}\n  [ Generation {gen} ] "
            f"prompt='{prompt_set.label}'\n{'=' * 50}"
        )
        result = optimize_cues(cues, client, prompt_set)
        gen_result = GenerationResult(gen, result, prompt_set, focus)
        history.append(gen_result)
        print(
            f"  [Gen {gen}] avg score {result.avg_score:.4f}  "
            f"遵守率 {result.compliance_rate:.1f}%  "
            f"平均類似度 {result.avg_similarity:.4f}"
        )

        if best is None or fitness(result) > fitness(best.result):
            best = gen_result

        if result.compliance_rate >= 100.0:
            print("[META-EVOLUTION] 遵守率100%到達。進化を終了します。")
            break
        if gen == generations - 1:
            break

        # best-keep: 最良世代を基点に、直近の変更結果を観測させて進化する。
        prompt_set, focus, _ = evolve_prompts(history, best, meta_backend)

    return history
