import type { AdminSettings } from '@/types/adminSettings'
import { createAiGateway } from '@/lib/aiGateway'
import type { EnBlock, PipelineThresholds } from './blockTypes'
import type { CorrectedSegmentLite } from './correct'
import type { CoverageReport } from './coverageValidator'
import type { PipelineCorrectionAttemptSummary } from '@/types/pipeline'
import { validateCoverage } from './coverageValidator'
import { checkCpsViolations } from './checkCpsViolations'
import { meetsConstraints } from './correctionAgent/patchUtils'
import { requireChatModelForProvider } from './aiProvider'
import { resolveCompressModelId } from './prompts'
import { loadLanguageProfileConfig, type LanguageProfileConfig } from './languageProfileConfig'
import { parseJsonObjectFromLlmContent } from './jsonResponse'
import { getCurrentLlmUsageSink } from './llmUsageSink'

/**
 * 段階的 escalation のエフォート値。PoC の検証で low が大半、medium で残り、high で最後の救済の構造を確認済み。
 */
export type RepairEffort = 'low' | 'medium' | 'high'

/**
 * generalRepairMaxEffort 設定値からエスカレーション配列を構築する。
 * 'low': ['low'] / 'medium': ['low', 'medium'] / 'high': ['low', 'medium', 'high']
 */
export function buildEffortsFromMax(maxEffort: 'low' | 'medium' | 'high'): RepairEffort[] {
  if (maxEffort === 'low') return ['low']
  // Release cost guard: keep the final high-effort pass opt-in for later validation.
  // Existing saved settings may still contain "high", so cap both medium/high here.
  return ['low', 'medium']
}

/**
 * general_repair_agent のモデル選択。
 * 専用設定 generalRepairModel が空欄なら compressModel にフォールバック。
 */
function resolveGeneralRepairModelId(settings: AdminSettings): string {
  return settings.generalRepairModel?.trim() || resolveCompressModelId(settings)
}

/**
 * 1 attempt あたりのログ。effort / token / before-after を完全に記録する。
 */
export interface GeneralRepairLogEntry {
  attempt: number
  effort: RepairEffort
  blocksTargetedIds: number[]
  blocksBefore: Array<{ blockId: number; jaSpan: string; en: string; violation: string }>
  blocksAfter: Array<{ blockId: number; jaSpan: string; en: string; violation: string }>
  changedBlockIds: number[]
  violationsBefore: number
  violationsAfter: number
  coverageFailedBefore: number
  coverageFailedAfter: number
  status: 'improved' | 'improved_partial' | 'no_change' | 'reverted' | 'llm_error' | 'parse_error'
  rationale?: string
  errorMessage?: string
  promptTokens?: number
  completionTokens?: number
  reasoningTokens?: number
  model: string
  /**
   * 部分採用で除外された rewrite。LLM の提案数のうち、自分の block で hard regression を
   * 起こすため採用しなかったものを記録する。0 件なら全採用、>=1 件なら partial。
   */
  droppedRewrites?: DroppedRewrite[]
}

/**
 * general_repair_agent の最終結果。Pipeline trace に保存（snapshot 経由）。
 */
export interface GeneralRepairResult {
  enabled: boolean
  /** 修復対象の初期違反数（block 単位 + coverage segment 単位）*/
  initialViolatingBlocks: number
  initialCoverageFailed: number
  finalViolatingBlocks: number
  finalCoverageFailed: number
  attemptedEfforts: RepairEffort[]
  blocks: EnBlock[]
  entries: GeneralRepairLogEntry[]
  finalCoverageReport: CoverageReport | null
}

interface LlmRewrite {
  blockId: number
  jaSpan: string
  en: string
}

interface LlmResponse {
  rewrites: LlmRewrite[]
  rationale: string
}

// transcript（元言語=校正済みソース）のラベルはプロンプトへ注入する。
// 既定構成（transcript=Japanese）では従来のハードコード文字列とバイト一致する（generalRepairAgent.test.ts で固定）。
function buildSystemPrompt(transcriptLabel: string): string {
  return `You are GeneralRepairAgent — the LAST repair pass for academic lecture subtitles.

The pipeline has already tried rule-based corrections and a coverage-focused repair agent.
What remains are the hardest cases. You get one more chance per effort level (low → medium → high).
If you cannot fix it, the block goes to manual_review.

You will be given:
- chunk_blocks: all blocks for the current chunk, in time order, with current violations and correction history.
- residual_violations: per-block violations (cps_over, line_length_only, long_segment, etc.) + chunk-level coverage gaps.
- constraints: hard limits (max_cps, max_chars_per_line, max_segment_chars, min_duration, etc.). MUST respect.
- source_segments: original ${transcriptLabel} corrected text (post-correctJa) for coverage reference.

Your job: rewrite the affected cues to resolve as many violations as possible.

Rules:
- Return JSON only: { "rationale": "...", "rewrites": [{ "block_id": N, "ja_span": "...", "en": "..." }] }
- Only return rewrites for the cues you want to change. Other cues stay as-is.
- You may modify both ja_span (to expand/shift source coverage) and en (to fix CPS/line/length).
- Preserve the cue's start/end timing (you do NOT modify timing).
- Compute allowed en chars as floor(duration_sec × max_cps). Stay within this budget.
- Respect max_chars_per_line per line and max_segment_chars total.
- Do not add content not in the source ${transcriptLabel}.
- Preserve technical terms / formulas exactly (post-correctJa form).
- Do not invent proper nouns (person names, organization names) that are not in source.
- Use correction_attempts history to AVOID repeating strategies that already failed.
- If you cannot repair a cue without violating constraints, leave it out of rewrites and explain in rationale.
- For coverage gaps: prefer rephrasing existing en to absorb missing content, rather than fabricating.`
}

interface RepairPromptInput {
  chunkBlocks: EnBlock[]
  affectedBlockIds: Set<number>
  correctedSegments: CorrectedSegmentLite[]
  coverageReport: CoverageReport
  thresholds: PipelineThresholds
}

function summarizeCorrectionAttempts(
  attempts: PipelineCorrectionAttemptSummary[] | undefined,
): Array<Record<string, unknown>> | undefined {
  if (!attempts || attempts.length === 0) return undefined
  return attempts.map((a) => ({
    strategy: a.strategy,
    changed: a.changed,
    before_chars: a.beforeChars,
    after_chars: a.afterChars,
    before_violation: a.beforeViolation,
    after_violation: a.afterViolation,
    rationale: a.rationale,
    semantic_similarity: a.semanticSimilarity,
    semantic_outcome: a.semanticOutcome,
  }))
}

function buildRepairUserPrompt(input: RepairPromptInput): string {
  const isAffected = (id: number): boolean => input.affectedBlockIds.has(id)
  const formatBlock = (b: EnBlock): Record<string, unknown> => ({
    block_id: b.id,
    start: b.start,
    end: b.end,
    duration_sec: Math.round((b.end - b.start) * 1000) / 1000,
    ja_span: b.jaText,
    en: b.enText,
    en_chars: b.enChars,
    cps: b.cps,
    max_line_len: b.maxLineLen,
    current_violation: b.violation,
    align_conf: b.alignConf,
    context_group_id: b.contextGroupId,
    context_group_role: b.contextGroupRole,
    context_group_index: b.contextGroupIndex,
    context_group_size: b.contextGroupSize,
    context_group_text: b.contextGroupText,
    compress_count: b.compressCount,
    expand_count: b.expandCount,
    is_target: isAffected(b.id),
    correction_attempts: isAffected(b.id) ? summarizeCorrectionAttempts(b.correctionAttempts) : undefined,
  })

  const perBlockViolations = input.chunkBlocks
    .filter((b) => isAffected(b.id) && !meetsConstraints(b))
    .map((b) => ({
      block_id: b.id,
      violation: b.violation,
      en_chars: b.enChars,
      cps: b.cps,
      max_line_len: b.maxLineLen,
    }))
  const coverageViolations = input.coverageReport.issues.map((i) => ({
    source_segment_id: i.sourceSegmentId,
    coverage_ratio: i.coverageRatio,
    affected_block_ids: i.affectedBlockIds,
    missing_hint: `Source needs >= 90% coverage but currently only ${Math.round(i.coverageRatio * 100)}%.`,
  }))

  return JSON.stringify({
    chunk_blocks: input.chunkBlocks.map(formatBlock),
    residual_violations: {
      per_block: perBlockViolations,
      coverage: coverageViolations,
    },
    source_segments: input.correctedSegments.map((s) => ({
      id: s.id,
      start: s.start,
      end: s.end,
      ja_text: s.correctedText,
      original_ja_text: s.text,
      correction_distance: s.correctionDistance,
    })),
    constraints: {
      max_cps: input.thresholds.verboseCps,
      max_chars_per_line: input.thresholds.maxLineLen,
      max_segment_chars: input.thresholds.maxLineLen * 2,
      slow_cps: input.thresholds.slowCps,
      short_duration_sec: input.thresholds.shortDurationSec,
      long_duration_sec: input.thresholds.longDurationSec,
    },
    instruction:
      'Rewrite the target blocks (is_target=true) to resolve remaining violations. ' +
      'Use correction_attempts to avoid repeating failed strategies. ' +
      'For coverage gaps, extend ja_span and rephrase en to absorb missing source. ' +
      'Keep timing. Respect constraints.',
  })
}

interface LlmCallResult {
  parsed: LlmResponse | null
  errorMessage?: string
  promptTokens?: number
  completionTokens?: number
  reasoningTokens?: number
}

async function callRepairLlm(
  prompt: string,
  settings: AdminSettings,
  model: string,
  effort: RepairEffort,
  languages: LanguageProfileConfig,
): Promise<LlmCallResult> {
  const resolvedModel = requireChatModelForProvider(settings, model, 'general repair')

  try {
    const result = await createAiGateway(settings).chatText({
      nodeName: `generalRepairAgent[effort=${effort}]`,
      model: resolvedModel,
      reasoningEffort: effort,
      responseFormat: undefined,
      usageSink: getCurrentLlmUsageSink(),
      messages: [
        { role: 'system', content: buildSystemPrompt(languages.transcript.label) },
        { role: 'user', content: prompt },
      ],
    })

    if (result.errorMessage) {
      return {
        parsed: null,
        errorMessage: `general_repair API failed: ${result.errorMessage}`,
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
        reasoningTokens: result.reasoningTokens,
      }
    }

    try {
      const obj = parseJsonObjectFromLlmContent(result.content, 'general_repair')
      const rationale = typeof obj.rationale === 'string' ? obj.rationale : ''
      const rewritesRaw = Array.isArray(obj.rewrites) ? obj.rewrites : []
      const rewrites: LlmRewrite[] = []
      for (const r of rewritesRaw) {
        if (!r || typeof r !== 'object') continue
        const row = r as Record<string, unknown>
        const blockId = typeof row.block_id === 'number' ? row.block_id : null
        const jaSpan = typeof row.ja_span === 'string' ? row.ja_span : null
        const en = typeof row.en === 'string' ? row.en : null
        if (blockId === null || jaSpan === null || en === null) continue
        rewrites.push({ blockId, jaSpan, en })
      }
      return {
        parsed: { rewrites, rationale },
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
        reasoningTokens: result.reasoningTokens,
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return {
        parsed: null,
        errorMessage: `general_repair JSON parse failed: ${msg}`,
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
        reasoningTokens: result.reasoningTokens,
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { parsed: null, errorMessage: `general_repair fetch failed: ${msg}` }
  }
}

function applyRewrites(blocks: EnBlock[], rewrites: LlmRewrite[]): EnBlock[] {
  if (rewrites.length === 0) return blocks
  const byId = new Map<number, LlmRewrite>()
  for (const r of rewrites) byId.set(r.blockId, r)
  return blocks.map((b) => {
    const r = byId.get(b.id)
    if (!r) return b
    return {
      ...b,
      jaText: r.jaSpan,
      jaChars: r.jaSpan.replace(/\s/g, '').length,
      enText: r.en,
      enRaw: r.en,
      enTextOriginal: b.enTextOriginal ?? b.enText,
    }
  })
}

function snapshotAffected(blocks: EnBlock[], affectedIds: Set<number>): Array<{ blockId: number; jaSpan: string; en: string; violation: string }> {
  return blocks
    .filter((b) => affectedIds.has(b.id))
    .map((b) => ({ blockId: b.id, jaSpan: b.jaText, en: b.enText, violation: b.violation }))
}

function countViolatingBlocks(blocks: EnBlock[]): number {
  return blocks.filter((b) => !meetsConstraints(b)).length
}

export function hasHardMetricRegression(
  beforeBlocks: EnBlock[],
  afterBlocks: EnBlock[],
  changedIds: number[],
  thresholds: PipelineThresholds,
): boolean {
  for (const id of changedIds) {
    const before = beforeBlocks.find((b) => b.id === id)
    const after = afterBlocks.find((b) => b.id === id)
    if (!before || !after) continue

    const beforeWasWithinCps = before.cps <= thresholds.verboseCps
    if (beforeWasWithinCps && after.cps > thresholds.verboseCps) return true

    const maxSegmentChars = thresholds.maxLineLen * 2
    const beforeWasWithinSegmentChars = before.enChars <= maxSegmentChars
    if (beforeWasWithinSegmentChars && after.enChars > maxSegmentChars) return true
  }

  return false
}

export interface DroppedRewrite {
  blockId: number
  reason: string
}

/**
 * rewrite を block 単位で safety judge する。
 * 元設計は「attempt 単位の all-or-nothing accept/reject」だったが、
 * 動画全体一括投入では 1 件の hard regression で数十件の improvement を捨てるため
 * 部分採用へ移行する。各 rewrite を独立評価し、自分の block で hard regression を
 * 起こさないものだけ採用する。
 */
export function partitionRewritesBySafety(
  beforeBlocks: EnBlock[],
  proposedBlocks: EnBlock[],
  rewrites: Array<{ blockId: number; jaSpan: string; en: string }>,
  thresholds: PipelineThresholds,
): { safe: Array<{ blockId: number; jaSpan: string; en: string }>; dropped: DroppedRewrite[] } {
  const safe: Array<{ blockId: number; jaSpan: string; en: string }> = []
  const dropped: DroppedRewrite[] = []
  const maxSegmentChars = thresholds.maxLineLen * 2

  for (const r of rewrites) {
    const before = beforeBlocks.find((b) => b.id === r.blockId)
    const after = proposedBlocks.find((b) => b.id === r.blockId)
    if (!before || !after) {
      dropped.push({ blockId: r.blockId, reason: 'block not found in before/after snapshot' })
      continue
    }
    const beforeWasWithinCps = before.cps <= thresholds.verboseCps
    if (beforeWasWithinCps && after.cps > thresholds.verboseCps) {
      dropped.push({
        blockId: r.blockId,
        reason: `cps regression: ${before.cps.toFixed(1)} -> ${after.cps.toFixed(1)} (limit ${thresholds.verboseCps})`,
      })
      continue
    }
    const beforeWasWithinSegmentChars = before.enChars <= maxSegmentChars
    if (beforeWasWithinSegmentChars && after.enChars > maxSegmentChars) {
      dropped.push({
        blockId: r.blockId,
        reason: `total chars regression: ${before.enChars} -> ${after.enChars} (limit ${maxSegmentChars})`,
      })
      continue
    }
    safe.push(r)
  }

  return { safe, dropped }
}

/**
 * general_repair_agent のメインエントリ。
 *
 * - settings.generalRepairEnabled === false の場合は何もせず blocks をそのまま返す
 * - 修復対象が無ければ何もしない
 * - 各 effort で 1 回ずつ LLM 呼出（最大 3 回）
 * - 各 attempt で:
 *   - LLM 呼出 → 提案 rewrites を仮適用
 *   - checkCpsViolations で violation 再計算
 *   - validateCoverage で coverage 再計算
 *   - 「違反数 < 元 OR coverage failed 数 < 元」なら採用、そうでなければ revert
 *   - 全違反解消なら break（後続 effort 不要）
 * - 全 attempt 失敗時も blocks の violation は残ったまま → 後段で manual_review 確定
 */
export async function runGeneralRepairAgent(
  blocks: EnBlock[],
  correctedSegments: CorrectedSegmentLite[],
  coverageReport: CoverageReport,
  settings: AdminSettings,
  thresholds: PipelineThresholds,
  effortsParam?: RepairEffort[],
): Promise<GeneralRepairResult> {
  // settings.generalRepairMaxEffort から escalation 配列を構築（明示引数があればそちらを優先）
  const efforts: RepairEffort[] = effortsParam ?? buildEffortsFromMax(settings.generalRepairMaxEffort)
  const initialViolatingBlocks = countViolatingBlocks(blocks)
  const initialCoverageFailed = coverageReport.failedSegments

  if (!settings.generalRepairEnabled) {
    return {
      enabled: false,
      initialViolatingBlocks,
      initialCoverageFailed,
      finalViolatingBlocks: initialViolatingBlocks,
      finalCoverageFailed: initialCoverageFailed,
      attemptedEfforts: [],
      blocks,
      entries: [],
      finalCoverageReport: coverageReport,
    }
  }

  if (initialViolatingBlocks === 0 && initialCoverageFailed === 0) {
    return {
      enabled: true,
      initialViolatingBlocks: 0,
      initialCoverageFailed: 0,
      finalViolatingBlocks: 0,
      finalCoverageFailed: 0,
      attemptedEfforts: [],
      blocks,
      entries: [],
      finalCoverageReport: coverageReport,
    }
  }

  const model = resolveGeneralRepairModelId(settings)
  const languages = loadLanguageProfileConfig(settings)
  let currentBlocks = blocks
  let currentCoverage = coverageReport
  const entries: GeneralRepairLogEntry[] = []
  const attemptedEfforts: RepairEffort[] = []

  for (let attemptIdx = 0; attemptIdx < efforts.length; attemptIdx += 1) {
    const effort = efforts[attemptIdx]
    attemptedEfforts.push(effort)

    // 対象 block: 違反のある block + coverage 影響 block を集める
    const affectedBlockIds = new Set<number>()
    for (const b of currentBlocks) {
      if (!meetsConstraints(b)) affectedBlockIds.add(b.id)
    }
    for (const issue of currentCoverage.issues) {
      for (const id of issue.affectedBlockIds) affectedBlockIds.add(id)
    }

    if (affectedBlockIds.size === 0) {
      // 全部解消済み（理屈上は前 attempt で break しているはずだが念のため）
      break
    }

    const beforeViolations = countViolatingBlocks(currentBlocks)
    const beforeCoverageFailed = currentCoverage.failedSegments
    const beforeSnapshot = snapshotAffected(currentBlocks, affectedBlockIds)

    const prompt = buildRepairUserPrompt({
      chunkBlocks: currentBlocks,
      affectedBlockIds,
      correctedSegments,
      coverageReport: currentCoverage,
      thresholds,
    })

    const llmResult = await callRepairLlm(prompt, settings, model, effort, languages)

    const baseEntry: Omit<GeneralRepairLogEntry, 'status'> = {
      attempt: attemptIdx + 1,
      effort,
      blocksTargetedIds: [...affectedBlockIds],
      blocksBefore: beforeSnapshot,
      blocksAfter: beforeSnapshot,
      changedBlockIds: [],
      violationsBefore: beforeViolations,
      violationsAfter: beforeViolations,
      coverageFailedBefore: beforeCoverageFailed,
      coverageFailedAfter: beforeCoverageFailed,
      model,
      promptTokens: llmResult.promptTokens,
      completionTokens: llmResult.completionTokens,
      reasoningTokens: llmResult.reasoningTokens,
    }

    if (!llmResult.parsed) {
      const status = llmResult.errorMessage?.includes('JSON parse failed') ? 'parse_error' : 'llm_error'
      entries.push({ ...baseEntry, status, errorMessage: llmResult.errorMessage })
      continue
    }

    const rewrites = llmResult.parsed.rewrites
    if (rewrites.length === 0) {
      entries.push({ ...baseEntry, status: 'no_change', rationale: llmResult.parsed.rationale })
      continue
    }

    // 仮適用 → 部分採用フィルタ → 残ったものだけ再適用して global validate
    // 部分採用化: 1 件の hard regression で全件 revert していた旧設計を改める。
    // 自分の block で hard regression を起こす rewrite だけを除外し、残りは採用する。
    const rewrittenBlocksAll = applyRewrites(currentBlocks, rewrites)
    const proposedBlocksAll = checkCpsViolations(rewrittenBlocksAll, thresholds)
    const { safe: safeRewrites, dropped: droppedRewrites } = partitionRewritesBySafety(
      currentBlocks,
      proposedBlocksAll,
      rewrites,
      thresholds,
    )

    if (safeRewrites.length === 0) {
      // すべて hard regression → revert
      entries.push({
        ...baseEntry,
        status: 'reverted',
        blocksAfter: snapshotAffected(proposedBlocksAll, affectedBlockIds),
        changedBlockIds: [],
        violationsAfter: beforeViolations,
        coverageFailedAfter: beforeCoverageFailed,
        rationale: `${llmResult.parsed.rationale}; reverted: all ${droppedRewrites.length} rewrites caused hard regression`,
        droppedRewrites,
      })
      continue
    }

    const safeApplied = applyRewrites(currentBlocks, safeRewrites)
    const proposedBlocks = checkCpsViolations(safeApplied, thresholds)
    const proposedCoverage = validateCoverage(proposedBlocks, correctedSegments)
    const afterViolations = countViolatingBlocks(proposedBlocks)
    const afterCoverageFailed = proposedCoverage.failedSegments

    const afterSnapshot = snapshotAffected(proposedBlocks, affectedBlockIds)
    const changedIds = safeRewrites
      .map((r) => r.blockId)
      .filter((id) => {
        const before = currentBlocks.find((b) => b.id === id)
        const after = proposedBlocks.find((b) => b.id === id)
        if (!before || !after) return false
        return before.enText !== after.enText || before.jaText !== after.jaText
      })

    // 部分採用後の global check: 違反数が増えていない (= no net regression) なら採用。
    // coverage 悪化は採用しない (safe rewrite でも ja_span 変更で coverage を下げる可能性あり)
    const improvedAny =
      afterViolations < beforeViolations || afterCoverageFailed < beforeCoverageFailed
    const regressed =
      afterViolations > beforeViolations || afterCoverageFailed > beforeCoverageFailed

    if (improvedAny && !regressed) {
      currentBlocks = proposedBlocks
      currentCoverage = proposedCoverage
      const isPartial = droppedRewrites.length > 0
      entries.push({
        ...baseEntry,
        status: isPartial ? 'improved_partial' : 'improved',
        blocksAfter: afterSnapshot,
        changedBlockIds: changedIds,
        violationsAfter: afterViolations,
        coverageFailedAfter: afterCoverageFailed,
        rationale: isPartial
          ? `${llmResult.parsed.rationale}; accepted ${safeRewrites.length}/${rewrites.length} rewrites (${droppedRewrites.length} dropped for hard regression)`
          : llmResult.parsed.rationale,
        droppedRewrites: isPartial ? droppedRewrites : undefined,
      })
      if (afterViolations === 0 && afterCoverageFailed === 0) break
    } else {
      entries.push({
        ...baseEntry,
        status: 'reverted',
        blocksAfter: afterSnapshot,
        changedBlockIds: changedIds,
        violationsAfter: afterViolations,
        coverageFailedAfter: afterCoverageFailed,
        rationale: regressed
          ? `${llmResult.parsed.rationale}; reverted: net violation/coverage regression after partial adoption`
          : `${llmResult.parsed.rationale}; reverted: no net improvement after partial adoption`,
        droppedRewrites: droppedRewrites.length > 0 ? droppedRewrites : undefined,
      })
    }
  }

  return {
    enabled: true,
    initialViolatingBlocks,
    initialCoverageFailed,
    finalViolatingBlocks: countViolatingBlocks(currentBlocks),
    finalCoverageFailed: currentCoverage.failedSegments,
    attemptedEfforts,
    blocks: currentBlocks,
    entries,
    finalCoverageReport: currentCoverage,
  }
}

export const __testing = {
  buildSystemPrompt,
}
