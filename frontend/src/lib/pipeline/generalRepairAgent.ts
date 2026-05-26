import type { AdminSettings } from '@/types/adminSettings'
import type { EnBlock, PipelineThresholds } from './blockTypes'
import type { CorrectedSegmentLite } from './correct'
import type { CoverageReport } from './coverageValidator'
import type { PipelineCorrectionAttemptSummary } from '@/types/pipeline'
import { validateCoverage } from './coverageValidator'
import { checkCpsViolations } from './checkCpsViolations'
import { meetsConstraints } from './correctionAgent/patchUtils'
import { requireAiConnection, requireChatModelForProvider, resolveJsonResponseFormatForProvider } from './aiProvider'
import { resolveCompressModelId } from './prompts'
import { tauriFetch } from '@/lib/tauriFetch'
import { parseJsonObjectFromLlmContent } from './jsonResponse'

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
  if (maxEffort === 'medium') return ['low', 'medium']
  return ['low', 'medium', 'high']
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
  status: 'improved' | 'no_change' | 'reverted' | 'llm_error' | 'parse_error'
  rationale?: string
  errorMessage?: string
  promptTokens?: number
  completionTokens?: number
  reasoningTokens?: number
  model: string
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

const SYSTEM_PROMPT = `You are GeneralRepairAgent — the LAST repair pass for academic lecture subtitles.

The pipeline has already tried rule-based corrections and a coverage-focused repair agent.
What remains are the hardest cases. You get one more chance per effort level (low → medium → high).
If you cannot fix it, the block goes to manual_review.

You will be given:
- chunk_blocks: all blocks for the current chunk, in time order, with current violations and correction history.
- residual_violations: per-block violations (cps_over, line_length_only, long_segment, etc.) + chunk-level coverage gaps.
- constraints: hard limits (max_cps, max_chars_per_line, max_segment_chars, min_duration, etc.). MUST respect.
- source_segments: original Japanese corrected text (post-correctJa) for coverage reference.

Your job: rewrite the affected cues to resolve as many violations as possible.

Rules:
- Return JSON only: { "rationale": "...", "rewrites": [{ "block_id": N, "ja_span": "...", "en": "..." }] }
- Only return rewrites for the cues you want to change. Other cues stay as-is.
- You may modify both ja_span (to expand/shift source coverage) and en (to fix CPS/line/length).
- Preserve the cue's start/end timing (you do NOT modify timing).
- Compute allowed en chars as floor(duration_sec × max_cps). Stay within this budget.
- Respect max_chars_per_line per line and max_segment_chars total.
- Do not add content not in the source Japanese.
- Preserve technical terms / formulas exactly (post-correctJa form).
- Do not invent proper nouns (person names, organization names) that are not in source.
- Use correction_attempts history to AVOID repeating strategies that already failed.
- If you cannot repair a cue without violating constraints, leave it out of rewrites and explain in rationale.
- For coverage gaps: prefer rephrasing existing en to absorb missing content, rather than fabricating.`

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
): Promise<LlmCallResult> {
  const connection = requireAiConnection(settings, 'general repair')
  const resolvedModel = requireChatModelForProvider(settings, model, 'general repair')

  try {
    const response = await tauriFetch(`${connection.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(connection.apiKey ? { Authorization: `Bearer ${connection.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: resolvedModel,
        reasoning_effort: effort,
        response_format: resolveJsonResponseFormatForProvider(settings),
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
      }),
    })

    if (!response.ok) {
      const detail = await response.text()
      return { parsed: null, errorMessage: `general_repair API HTTP ${response.status}: ${detail.slice(0, 200)}` }
    }

    const payload = (await response.json()) as Record<string, unknown>
    const choices = Array.isArray(payload.choices) ? payload.choices : []
    const firstChoice = choices[0] as Record<string, unknown> | undefined
    const message = firstChoice?.message as Record<string, unknown> | undefined
    const content: string = typeof message?.content === 'string' ? message.content : ''

    const usage = payload.usage as Record<string, unknown> | undefined
    const promptTokens = typeof usage?.prompt_tokens === 'number' ? usage.prompt_tokens : undefined
    const completionTokens = typeof usage?.completion_tokens === 'number' ? usage.completion_tokens : undefined
    const completionDetails = usage?.completion_tokens_details as Record<string, unknown> | undefined
    const reasoningTokens = typeof completionDetails?.reasoning_tokens === 'number' ? completionDetails.reasoning_tokens : undefined

    if (!content.trim()) {
      return { parsed: null, errorMessage: 'general_repair response empty', promptTokens, completionTokens, reasoningTokens }
    }

    try {
      const obj = parseJsonObjectFromLlmContent(content, 'general_repair')
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
      return { parsed: { rewrites, rationale }, promptTokens, completionTokens, reasoningTokens }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { parsed: null, errorMessage: `general_repair JSON parse failed: ${msg}`, promptTokens, completionTokens, reasoningTokens }
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

    const llmResult = await callRepairLlm(prompt, settings, model, effort)

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

    // 仮適用 → violation 再計算 → coverage 再計算
    const rewrittenBlocks = applyRewrites(currentBlocks, rewrites)
    const proposedBlocks = checkCpsViolations(rewrittenBlocks, thresholds)
    const proposedCoverage = validateCoverage(proposedBlocks, correctedSegments)
    const afterViolations = countViolatingBlocks(proposedBlocks)
    const afterCoverageFailed = proposedCoverage.failedSegments

    const afterSnapshot = snapshotAffected(proposedBlocks, affectedBlockIds)
    const changedIds = rewrites
      .map((r) => r.blockId)
      .filter((id) => {
        const before = currentBlocks.find((b) => b.id === id)
        const after = proposedBlocks.find((b) => b.id === id)
        if (!before || !after) return false
        return before.enText !== after.enText || before.jaText !== after.jaText
      })

    const improvedAny =
      afterViolations < beforeViolations || afterCoverageFailed < beforeCoverageFailed
    const regressed =
      afterViolations > beforeViolations || afterCoverageFailed > beforeCoverageFailed

    if (improvedAny && !regressed) {
      currentBlocks = proposedBlocks
      currentCoverage = proposedCoverage
      entries.push({
        ...baseEntry,
        status: 'improved',
        blocksAfter: afterSnapshot,
        changedBlockIds: changedIds,
        violationsAfter: afterViolations,
        coverageFailedAfter: afterCoverageFailed,
        rationale: llmResult.parsed.rationale,
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
        rationale: llmResult.parsed.rationale,
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
