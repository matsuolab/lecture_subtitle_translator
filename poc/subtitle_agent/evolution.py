"""自己進化ハーネス B — オフライン最適化ループ.

製品パイプライン A を実行 → 失敗を分析 → Claude (メタLLM) が PromptSet を改善
→ 再実行、を世代として回す。B は製品には載らず、見つけた良い PromptSet を
A へ反映するためのオフライン最適化ツール。

過剰進化対策:
  - メタプロンプトで各プロンプトを簡潔に保つよう明示的に指示。
  - best-keep: 進化の基点は常に「これまでで最良の世代」の PromptSet。
    退化した世代から進化させ続けてプロンプトが肥大化するのを防ぐ。
"""

import re
from dataclasses import dataclass

import openai

from poc.subtitle_agent import constants, prompts
from poc.subtitle_agent.llm_backend import LLMBackend
from poc.subtitle_agent.optimizer import OptimizeResult, build_cues, optimize_cues

FAILURE_SLICE_SIZE = 5


@dataclass(frozen=True)
class GenerationResult:
    """1世代の実行結果。"""

    generation: int
    result: OptimizeResult
    prompt_set: prompts.PromptSet
    focus: str


def fitness(result: OptimizeResult) -> float:
    """世代の総合適応度。遵守率を主、平均スコアを従とする。"""
    return result.compliance_rate + result.avg_score


def _worst_cues(result: OptimizeResult) -> list:
    """違反キューから最も深刻な代表例を抽出する (Failure Slicing)。

    旧PoCの知見: 全失敗例を送るとコンテキスト超過。最悪例のみに絞る。
    """
    failed = [r for r in result.cue_results if not r.evaluation.compliant]

    def severity(r) -> float:
        e = r.evaluation
        cps_over = max(0.0, e.cps - constants.TARGET_CPS) / constants.TARGET_CPS
        return cps_over + (1.0 - e.similarity)

    return sorted(failed, key=severity, reverse=True)[:FAILURE_SLICE_SIZE]


def _build_meta_prompt(
    result: OptimizeResult, prompt_set: prompts.PromptSet, gen: int
) -> str:
    """Claude メタLLM へ送る失敗分析・進化指示プロンプトを組み立てる。"""
    cases = []
    for r in _worst_cues(result):
        c, e = r.cue, r.evaluation
        cases.append(
            f"- Cue {c.id} (duration {c.duration:.1f}s)\n"
            f"  Japanese source: {c.ja}\n"
            f"  English subtitle: {c.en.replace(chr(10), ' / ')}\n"
            f"  CPS: {e.cps:.1f} (limit {constants.TARGET_CPS}) | "
            f"max line: {e.line_chars_max} (limit {constants.MAX_LINE_CHARS}) | "
            f"segment chars: {e.segment_chars} (limit {constants.MAX_SEGMENT_CHARS}) | "
            f"semantic similarity: {e.similarity:.3f} (threshold "
            f"{constants.SIMILARITY_THRESHOLD})"
        )
    cases_str = "\n".join(cases) if cases else "(no violating cues)"

    return (
        "You are a subtitle pipeline optimization agent. A Japanese university "
        "lecture is being translated into compliant English subtitles. The "
        "subtitle cues are already segmented and fixed; you tune two prompts "
        "(translate, condense) so the English satisfies: CPS <= "
        f"{constants.TARGET_CPS}, max {constants.MAX_LINE_CHARS} chars/line, "
        f"max {constants.MAX_SEGMENT_CHARS} chars/cue, and semantic similarity "
        f">= {constants.SIMILARITY_THRESHOLD}.\n\n"
        f"GENERATION {gen} RESULT: compliance rate {result.compliance_rate:.1f}%, "
        f"avg similarity {result.avg_similarity:.3f}, avg score "
        f"{result.avg_score:.3f}.\n\n"
        f"--- CURRENT PROMPTS (label: {prompt_set.label}) ---\n"
        f"[translate]\n{prompt_set.translate}\n\n"
        f"[condense]\n{prompt_set.condense}\n\n"
        "--- WORST FAILING CUES ---\n"
        f"{cases_str}\n\n"
        "Analyze the root cause of these failures, then design IMPROVED versions "
        "of the two prompts that directly address them.\n"
        "CRITICAL CONSTRAINTS on your output:\n"
        "- Keep both prompts CONCISE. Do NOT just append rules; rewrite for "
        "clarity. Bloated prompts hurt the small local model.\n"
        "- Output ONLY the XML block below, nothing else:\n\n"
        "<evolution>\n"
        "  <analysis>root cause analysis</analysis>\n"
        "  <focus>short summary of what this generation improves</focus>\n"
        "  <translate_prompt>improved translate prompt</translate_prompt>\n"
        "  <condense_prompt>improved condense prompt</condense_prompt>\n"
        "</evolution>"
    )


def _extract(tag: str, text: str) -> str | None:
    m = re.search(rf"<{tag}>(.*?)</{tag}>", text, re.DOTALL)
    return m.group(1).strip() if m else None


_META_SYSTEM = "You are a subtitle pipeline optimization agent."


def evolve_prompts(
    result: OptimizeResult,
    prompt_set: prompts.PromptSet,
    gen: int,
    meta_backend: LLMBackend,
) -> tuple[prompts.PromptSet, str, str]:
    """メタLLM に失敗を分析させ、進化した PromptSet を生成する。

    返り値: (新PromptSet, focus, analysis)。
    パース失敗時は現行 PromptSet をそのまま返す。
    """
    print(f"[META-EVOLUTION] >>> 世代 {gen} -> {gen + 1} : メタLLM に分析を依頼...")
    meta_prompt = _build_meta_prompt(result, prompt_set, gen)
    resp = meta_backend.complete(_META_SYSTEM, meta_prompt, 0.3)

    analysis = _extract("analysis", resp) or "(analysis 抽出失敗)"
    focus = _extract("focus", resp) or "(focus 抽出失敗)"
    new_translate = _extract("translate_prompt", resp) or prompt_set.translate
    new_condense = _extract("condense_prompt", resp) or prompt_set.condense

    # segment は進化対象外 (分割は世代ループ外で固定済み)。そのまま引き継ぐ。
    new_set = prompts.PromptSet(
        translate=new_translate,
        condense=new_condense,
        segment=prompt_set.segment,
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

    strong_backend は再分割の候補提案役、meta_backend はプロンプト進化役。
    再分割は進化対象外。世代ループの前に1回だけ実行しキュー集合を全世代で固定する
    (高コストな強モデル呼び出しを世代数ぶん払わず、fitness信号を translate/condense
    の改善に純化するため)。世代ループは translate/condense の進化のみを回す。
    best-keep: 進化の基点は常に最良世代の PromptSet。遵守率100%到達で早期終了。
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
        print(f"\n{'=' * 50}\n  [ Generation {gen} ] prompt='{prompt_set.label}'\n{'=' * 50}")
        result = optimize_cues(cues, client, prompt_set)
        gen_result = GenerationResult(gen, result, prompt_set, focus)
        history.append(gen_result)
        print(
            f"  [Gen {gen}] 遵守率 {result.compliance_rate:.1f}%  "
            f"平均類似度 {result.avg_similarity:.4f}  "
            f"平均スコア {result.avg_score:.4f}"
        )

        if best is None or fitness(result) > fitness(best.result):
            best = gen_result

        if result.compliance_rate >= 100.0:
            print("[META-EVOLUTION] 遵守率100%到達。進化を終了します。")
            break
        if gen == generations - 1:
            break

        # best-keep: 最良世代の PromptSet を基点に進化させる
        prompt_set, focus, _ = evolve_prompts(
            best.result, best.prompt_set, gen, meta_backend
        )

    return history
