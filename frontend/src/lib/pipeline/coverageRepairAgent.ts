import type { AdminSettings } from '@/types/adminSettings'
import type { EnBlock, PipelineThresholds } from './blockTypes'
import type { CorrectedSegmentLite } from './correct'
import type { CoverageIssue, CoverageReport } from './coverageValidator'
import type { PipelineCorrectionAttemptSummary } from '@/types/pipeline'
import { validateCoverage } from './coverageValidator'
import { requireAiConnection, requireChatModelForProvider, resolveJsonResponseFormatForProvider } from './aiProvider'
import { resolveCompressModelId } from './prompts'
import { tauriFetch } from '@/lib/tauriFetch'
import { safePush, getCurrentLlmUsageSink } from './llmUsageSink'
import { parseJsonObjectFromLlmContent } from './jsonResponse'

/**
 * 1 issue の LLM 呼出に関する詳細ログ。
 * Pipeline trace（PipelineStageSnapshot）に保存され、全動作を後から追跡可能にする。
 */
export interface CoverageRepairLogEntry {
  sourceSegmentId: number
  affectedBlockIds: number[]
  beforeCoverageRatio: number
  afterCoverageRatio: number | null
  changedBlocks: Array<{
    blockId: number
    beforeEn: string
    afterEn: string
    beforeJaSpan: string
    afterJaSpan: string
  }>
  status: 'improved' | 'no_change' | 'reverted' | 'llm_error' | 'parse_error'
  rationale?: string
  errorMessage?: string
  promptTokens?: number
  completionTokens?: number
  reasoningTokens?: number
  model?: string
  effort?: string
}

/**
 * coverage_repair_agent の実行結果サマリー。
 * snapshot に summary として記録される（+ entries: CoverageRepairLogEntry[]）。
 */
export interface CoverageRepairResult {
  enabled: boolean
  totalIssues: number
  improved: number
  unchanged: number
  reverted: number
  errors: number
  blocks: EnBlock[]
  /** validator log: 詳細を items として残すための専用フィールド */
  entries: CoverageRepairLogEntry[]
  /** 全 repair 完了後の最終 CoverageReport */
  finalReport: CoverageReport | null
}

/**
 * LLM が返す JSON のスキーマ:
 * {
 *   "rationale": "短い説明",
 *   "rewrites": [
 *     { "block_id": 12, "ja_span": "...", "en": "..." },
 *     ...
 *   ]
 * }
 */
interface LlmRewrite {
  blockId: number
  jaSpan: string
  en: string
}

interface LlmResponse {
  rewrites: LlmRewrite[]
  rationale: string
}

/**
 * coverage_repair_agent のモデル選択。
 * 専用設定 coverageRepairModel が空欄なら compressModel にフォールバック（後方互換）。
 */
function resolveCoverageRepairModelId(settings: AdminSettings): string {
  return settings.coverageRepairModel?.trim() || resolveCompressModelId(settings)
}

const SYSTEM_PROMPT = `You are CoverageRepairAgent for academic lecture subtitles.

A chunk of subtitles has a source-coverage problem: the union of all cue Japanese spans
does not fully represent the source Japanese segment. Some content from the source
Japanese is missing from the cues' ja_span and / or en text.

Your job: rewrite the affected cues so that the source Japanese is fully represented.

You will be given:
- source_segment: the full corrected Japanese with original (pre-correctJa) and correction_distance.
  If correction_distance is large, technical terms or formulas were rewritten by correctJa — preserve them carefully.
- constraints: hard limits (max_cps, max_chars_per_line, max_segment_chars). Your output MUST respect these.
- affected_cues_to_repair: each cue includes current state AND correction_attempts history (strategies already tried).
  Use the history to avoid repeating failed strategies.
- context_cues_before / after: neighbor cues for coherent flow.

Rules:
- Return JSON only: { "rationale": "...", "rewrites": [{ "block_id": N, "ja_span": "...", "en": "..." }] }
- Only return rewrites for the cues you want to change. Other cues stay as-is.
- Preserve the cue's start/end timing (you do NOT modify timing).
- Extend or shift each ja_span to claim more of the source Japanese where appropriate.
- Rewrite the en text so it expresses the new content compactly.
- Compute allowed en chars as floor(duration_sec * max_cps). Stay within this budget.
- Do not exceed max_chars_per_line per line, max_segment_chars total.
- Do not add content not present in the source Japanese.
- Preserve technical terms / formulas exactly as written in the source (especially the post-correctJa form).
- Do not invent proper nouns (person names, organization names) that are not in source.
- If correction_attempts shows compress_micro / compress_rephrase already failed, do not just shorten — restructure.
- If you cannot repair without violating constraints, return empty rewrites array with a rationale explaining why.`

interface RepairPromptInput {
  sourceSegment: CorrectedSegmentLite
  affectedBlocks: EnBlock[]
  coverageRatio: number
  contextBlocksBefore: EnBlock[]
  contextBlocksAfter: EnBlock[]
  thresholds: PipelineThresholds
}

/**
 * correctionAttempts を簡潔な形に整形（LLM のコンテキスト節約のため、
 * strategy / changed / before-after chars / 違反種類だけ残す）。
 */
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
  // affected blocks: 完全情報（履歴含む）。agent が修正対象を理解するため。
  const formatAffectedBlock = (b: EnBlock): Record<string, unknown> => ({
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
    context_group_text: b.contextGroupText,
    compress_count: b.compressCount,
    expand_count: b.expandCount,
    correction_attempts: summarizeCorrectionAttempts(b.correctionAttempts),
  })
  // context blocks: 周辺認識用。詳細は不要だが timing と現在 violation は伝える。
  const formatContextBlock = (b: EnBlock): Record<string, unknown> => ({
    block_id: b.id,
    start: b.start,
    end: b.end,
    ja_span: b.jaText,
    en: b.enText,
    current_violation: b.violation,
    context_group_id: b.contextGroupId,
    context_group_role: b.contextGroupRole,
  })

  return JSON.stringify({
    source_segment: {
      id: input.sourceSegment.id,
      start: input.sourceSegment.start,
      end: input.sourceSegment.end,
      ja_text: input.sourceSegment.correctedText,
      // correctJa での補正情報（特殊用語や数式が補正された痕跡）
      original_ja_text: input.sourceSegment.text,
      correction_distance: input.sourceSegment.correctionDistance,
      correction_flagged: input.sourceSegment.correctionFlagged,
    },
    current_coverage_ratio: input.coverageRatio,
    // ハード制約: 新しい en text はこの範囲を超えてはいけない
    constraints: {
      max_cps: input.thresholds.verboseCps,
      max_chars_per_line: input.thresholds.maxLineLen,
      max_segment_chars: input.thresholds.maxLineLen * 2, // 2行想定
      slow_cps: input.thresholds.slowCps,
    },
    // 修正対象の cues。correction_attempts に過去の試行履歴が含まれている。
    // 同じ戦略を繰り返さないように agent が判断できる。
    affected_cues_to_repair: input.affectedBlocks.map(formatAffectedBlock),
    context_cues_before: input.contextBlocksBefore.map(formatContextBlock),
    context_cues_after: input.contextBlocksAfter.map(formatContextBlock),
    instruction:
      'Rewrite the affected cues to cover the missing source Japanese content. ' +
      'Use correction_attempts history to avoid repeating strategies that already failed. ' +
      'Use the original_ja_text vs ja_text diff to identify technical terms that correctJa rewrote — preserve them carefully. ' +
      'Keep timing (do NOT modify start/end). Respect the constraints exactly.',
  })
}

interface LlmCallResult {
  parsed: LlmResponse | null
  errorMessage?: string
  promptTokens?: number
  completionTokens?: number
  reasoningTokens?: number
}

async function callCoverageRepairLlm(
  prompt: string,
  settings: AdminSettings,
  model: string,
  effort: string,
): Promise<LlmCallResult> {
  const connection = requireAiConnection(settings, 'coverage repair')
  const resolvedModel = requireChatModelForProvider(settings, model, 'coverage repair')

  const callStartedAt = Date.now()
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
      return { parsed: null, errorMessage: `coverage_repair API HTTP ${response.status}: ${detail.slice(0, 200)}` }
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
    const promptDetails = usage?.prompt_tokens_details as Record<string, unknown> | undefined
    const cachedInputTokens = typeof promptDetails?.cached_tokens === 'number' ? promptDetails.cached_tokens : undefined
    safePush(getCurrentLlmUsageSink(), {
      nodeId: `coverageRepairAgent[effort=${effort}]`,
      model: resolvedModel,
      promptTokens: promptTokens ?? 0,
      completionTokens: completionTokens ?? 0,
      reasoningTokens,
      cachedInputTokens,
      durationMs: Date.now() - callStartedAt,
    })

    if (!content.trim()) {
      return { parsed: null, errorMessage: 'coverage_repair response empty', promptTokens, completionTokens, reasoningTokens }
    }

    try {
      const obj = parseJsonObjectFromLlmContent(content, 'coverage_repair')
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
      return { parsed: null, errorMessage: `coverage_repair JSON parse failed: ${msg}`, promptTokens, completionTokens, reasoningTokens }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { parsed: null, errorMessage: `coverage_repair fetch failed: ${msg}` }
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
      // jaChars は semanticSplitJa と同じ式（空白除去後の文字数）で再計算
      jaChars: r.jaSpan.replace(/\s/g, '').length,
      enText: r.en,
      enRaw: r.en,
      enTextOriginal: b.enTextOriginal ?? b.enText,
    }
  })
}

/**
 * coverage_repair_agent のメインエントリ。
 *
 * - settings.coverageRepairEnabled === false の場合は何もせず blocks をそのまま返す
 * - coverageReport.issues が空なら何もしない
 * - 各 issue について 1 回ずつ LLM を呼ぶ（1 chunk あたり 1 issue=1 segment）
 * - LLM 失敗時・回答が空・カバレッジが改善しなかった場合は blocks を revert
 * - 全ログを CoverageRepairResult.entries に残す（snapshot 経由で trace に保存）
 */
export async function runCoverageRepairAgent(
  blocks: EnBlock[],
  correctedSegments: CorrectedSegmentLite[],
  coverageReport: CoverageReport,
  settings: AdminSettings,
  thresholds: PipelineThresholds,
): Promise<CoverageRepairResult> {
  if (!settings.coverageRepairEnabled) {
    return emptyResult(blocks, coverageReport, false)
  }

  if (coverageReport.issues.length === 0) {
    return emptyResult(blocks, coverageReport, true)
  }

  const model = resolveCoverageRepairModelId(settings)
  const effort = settings.coverageRepairEffort
  let currentBlocks = blocks
  const entries: CoverageRepairLogEntry[] = []

  // Issue は LCS で計算済みの coverage 違反 (1 segment = 1 issue)
  for (const issue of coverageReport.issues) {
    const entry = await repairOneIssue(issue, currentBlocks, correctedSegments, settings, model, effort, thresholds)
    entries.push(entry)
    if (entry.status === 'improved') {
      // 適用後の blocks に対して以降の issue を処理する
      currentBlocks = applyEntryRewrites(currentBlocks, entry)
    }
  }

  const finalReport = validateCoverage(currentBlocks, correctedSegments)
  const improved = entries.filter((e) => e.status === 'improved').length
  const unchanged = entries.filter((e) => e.status === 'no_change').length
  const reverted = entries.filter((e) => e.status === 'reverted').length
  const errors = entries.filter((e) => e.status === 'llm_error' || e.status === 'parse_error').length

  return {
    enabled: true,
    totalIssues: coverageReport.issues.length,
    improved,
    unchanged,
    reverted,
    errors,
    blocks: currentBlocks,
    entries,
    finalReport,
  }
}

function emptyResult(blocks: EnBlock[], coverageReport: CoverageReport, enabled: boolean): CoverageRepairResult {
  return {
    enabled,
    totalIssues: coverageReport.issues.length,
    improved: 0,
    unchanged: 0,
    reverted: 0,
    errors: 0,
    blocks,
    entries: [],
    finalReport: coverageReport,
  }
}

function applyEntryRewrites(blocks: EnBlock[], entry: CoverageRepairLogEntry): EnBlock[] {
  if (entry.changedBlocks.length === 0) return blocks
  const byId = new Map<number, { afterEn: string; afterJaSpan: string }>()
  for (const c of entry.changedBlocks) byId.set(c.blockId, { afterEn: c.afterEn, afterJaSpan: c.afterJaSpan })
  return blocks.map((b) => {
    const c = byId.get(b.id)
    if (!c) return b
    return {
      ...b,
      jaText: c.afterJaSpan,
      jaChars: c.afterJaSpan.replace(/\s/g, '').length,
      enText: c.afterEn,
      enRaw: c.afterEn,
      enTextOriginal: b.enTextOriginal ?? b.enText,
    }
  })
}

async function repairOneIssue(
  issue: CoverageIssue,
  currentBlocks: EnBlock[],
  correctedSegments: CorrectedSegmentLite[],
  settings: AdminSettings,
  model: string,
  effort: string,
  thresholds: PipelineThresholds,
): Promise<CoverageRepairLogEntry> {
  const sourceSegment = correctedSegments.find((s) => s.id === issue.sourceSegmentId)
  const affectedBlocks = currentBlocks.filter((b) => issue.affectedBlockIds.includes(b.id))

  if (!sourceSegment || affectedBlocks.length === 0) {
    return {
      sourceSegmentId: issue.sourceSegmentId,
      affectedBlockIds: issue.affectedBlockIds,
      beforeCoverageRatio: issue.coverageRatio,
      afterCoverageRatio: null,
      changedBlocks: [],
      status: 'llm_error',
      errorMessage: 'source segment or affected blocks not found',
    }
  }

  // context: 周辺 cue（前後 2 つずつ）を渡すと LLM が文脈を保ちやすい
  const sortedAll = [...currentBlocks].sort((a, b) => a.start - b.start)
  const firstAffectedIdx = sortedAll.findIndex((b) => issue.affectedBlockIds.includes(b.id))
  const lastAffectedIdx = sortedAll.length - 1 - [...sortedAll].reverse().findIndex((b) => issue.affectedBlockIds.includes(b.id))
  const contextBefore = firstAffectedIdx > 0 ? sortedAll.slice(Math.max(0, firstAffectedIdx - 2), firstAffectedIdx) : []
  const contextAfter = lastAffectedIdx >= 0 ? sortedAll.slice(lastAffectedIdx + 1, lastAffectedIdx + 3) : []

  const prompt = buildRepairUserPrompt({
    sourceSegment,
    affectedBlocks,
    coverageRatio: issue.coverageRatio,
    contextBlocksBefore: contextBefore,
    contextBlocksAfter: contextAfter,
    thresholds,
  })

  const llmResult = await callCoverageRepairLlm(prompt, settings, model, effort)

  const baseEntry: Omit<CoverageRepairLogEntry, 'status'> = {
    sourceSegmentId: issue.sourceSegmentId,
    affectedBlockIds: issue.affectedBlockIds,
    beforeCoverageRatio: issue.coverageRatio,
    afterCoverageRatio: null,
    changedBlocks: [],
    model,
    effort,
    promptTokens: llmResult.promptTokens,
    completionTokens: llmResult.completionTokens,
    reasoningTokens: llmResult.reasoningTokens,
  }

  if (!llmResult.parsed) {
    const status = llmResult.errorMessage?.includes('JSON parse failed') ? 'parse_error' : 'llm_error'
    return { ...baseEntry, status, errorMessage: llmResult.errorMessage }
  }

  const rewrites = llmResult.parsed.rewrites
  if (rewrites.length === 0) {
    return { ...baseEntry, status: 'no_change', rationale: llmResult.parsed.rationale }
  }

  const proposedBlocks = applyRewrites(currentBlocks, rewrites)
  const recheck = validateCoverage(proposedBlocks, correctedSegments)
  // この issue の segment が、提案後にどうなったか
  const recheckedIssue = recheck.issues.find((i) => i.sourceSegmentId === issue.sourceSegmentId)
  const afterRatio = recheckedIssue ? recheckedIssue.coverageRatio : 1.0

  const changedBlocks = rewrites
    .map((r) => {
      const before = currentBlocks.find((b) => b.id === r.blockId)
      if (!before) return null
      return {
        blockId: r.blockId,
        beforeEn: before.enText,
        afterEn: r.en,
        beforeJaSpan: before.jaText,
        afterJaSpan: r.jaSpan,
      }
    })
    .filter((c): c is { blockId: number; beforeEn: string; afterEn: string; beforeJaSpan: string; afterJaSpan: string } => c !== null)

  // 改善判定: afterRatio が beforeRatio より上昇していれば improved
  if (afterRatio > issue.coverageRatio + 0.001) {
    return {
      ...baseEntry,
      status: 'improved',
      afterCoverageRatio: afterRatio,
      changedBlocks,
      rationale: llmResult.parsed.rationale,
    }
  }

  // 改善しなかった or 悪化 → revert
  return {
    ...baseEntry,
    status: 'reverted',
    afterCoverageRatio: afterRatio,
    changedBlocks,
    rationale: llmResult.parsed.rationale,
  }
}
