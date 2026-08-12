import type { TranscriptSegment } from './types'
import type { SubtitleBlock } from '@/types/subtitle'
import type { AdminSettings } from '@/types/adminSettings'
import type { PipelineAuditReport, PipelineNodeTrace, PipelineStageSnapshot } from '@/types/pipeline'
import { resetLlmActivity } from '@/lib/aiGateway/llmActivity'

import { buildPipelineThresholdsFromSettings } from './pipelineThresholdFields'
import { runPhase1 } from './phase1'
import { runPhase2 } from './phase2'
import { runPhase3 } from './phase3'
import { runNodeWithHeartbeat, type LocalPipelineProgressDetail } from './runNodeWithHeartbeat'
import { buildSourceSegmentEvidence, type SourceSegmentEvidence } from '@/types/sourceEvidence'

export type { LocalPipelineProgressDetail } from './runNodeWithHeartbeat'

export interface LocalPipelineResult {
  blocks: SubtitleBlock[]
  traces: PipelineNodeTrace[]
  audit: PipelineAuditReport
  stageSnapshots: PipelineStageSnapshot[]
  sourceEvidence: SourceSegmentEvidence[]
}

export interface LocalPipelineGlossary {
  correctionTerms: string[]
  translationTerms: string[]
}

export interface LocalPipelineDebugFailure {
  traces?: PipelineNodeTrace[]
  stageSnapshots?: PipelineStageSnapshot[]
  sourceEvidence?: SourceSegmentEvidence[]
}

export function getLocalPipelineDebugFailure(error: unknown): LocalPipelineDebugFailure {
  if (!error || typeof error !== 'object') return {}
  const row = error as Record<string, unknown>
  return {
    traces: Array.isArray(row.localPipelineTraces) ? row.localPipelineTraces as PipelineNodeTrace[] : undefined,
    stageSnapshots: Array.isArray(row.localPipelineStageSnapshots) ? row.localPipelineStageSnapshots as PipelineStageSnapshot[] : undefined,
    sourceEvidence: Array.isArray(row.localPipelineSourceEvidence) ? row.localPipelineSourceEvidence as SourceSegmentEvidence[] : undefined,
  }
}

function attachLocalPipelineDebugFailure(
  error: unknown,
  traces: PipelineNodeTrace[],
  stageSnapshots: PipelineStageSnapshot[],
  sourceEvidence: SourceSegmentEvidence[] = [],
): Error {
  const err = error instanceof Error ? error : new Error(String(error))
  Object.assign(err, {
    localPipelineTraces: traces,
    localPipelineStageSnapshots: stageSnapshots,
    localPipelineSourceEvidence: sourceEvidence,
  })
  return err
}

function compactText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  return text ? text : undefined
}

function compactNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function compactBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function normalizeSnapshotItem(item: unknown): Record<string, unknown> {
  if (!item || typeof item !== 'object') return { value: item }
  const row = item as Record<string, unknown>
  // correctJa の出力（CorrectedSegmentLite）は correctedText を持つ。
  // splitJa 後の JaBlock では jaText が「補正後」になる。両方を残せるよう transcriptText の優先順を整理。
  const snapshot: Record<string, unknown> = {
    id: row.id,
    start: compactNumber(row.start) ?? compactNumber(row.startTime),
    end: compactNumber(row.end) ?? compactNumber(row.endTime),
    transcriptText: compactText(row.jaText) ?? compactText(row.correctedText) ?? compactText(row.ja_corrected) ?? compactText(row.target) ?? compactText(row.text),
    rawTranscriptText: compactText(row.text),
    correctedText: compactText(row.correctedText),
    subtitleText: compactText(row.enText) ?? compactText(row.source),
    rawSubtitleText: compactText(row.enRaw),
    jaChars: compactNumber(row.jaChars),
    enChars: compactNumber(row.enChars),
    charCount: compactNumber(row.charCount),
    cps: compactNumber(row.cps),
    maxLineLen: compactNumber(row.maxLineLen),
    violation: compactText(row.violation),
    alignConf: compactText(row.alignConf),
    merged: compactBoolean(row.merged),
    contextGroupId: compactText(row.contextGroupId),
    contextGroupIndex: compactNumber(row.contextGroupIndex),
    contextGroupSize: compactNumber(row.contextGroupSize),
    contextGroupRole: compactText(row.contextGroupRole),
    contextGroupReason: compactText(row.contextGroupReason),
    contextGroupText: compactText(row.contextGroupText),
    contextGroupSourceIds: Array.isArray(row.contextGroupSourceIds) ? row.contextGroupSourceIds : undefined,
    sourceRefs: Array.isArray(row.sourceRefs) ? row.sourceRefs : undefined,
    reviewPriority: compactText(row.reviewPriority),
    reviewDisposition: compactText(row.reviewDisposition),
    correctionDistance: compactNumber(row.correctionDistance) ?? compactNumber(row.correction_distance),
    correctionFlagged: compactBoolean(row.correctionFlagged) ?? compactBoolean(row.correction_flagged),
    translationFlagged: compactBoolean(row.translation_flagged),
    translationProvider: compactText(row.translation_provider),
    correctionAttempts: Array.isArray(row.correctionAttempts) ? row.correctionAttempts : undefined,
    correctionFailureReason: compactText(row.correctionFailureReason),
    correctionRetryAttempts: compactNumber(row.correctionRetryAttempts),
    translationFailureReason: compactText(row.translationFailureReason),
    translationRetryAttempts: compactNumber(row.translationRetryAttempts),
    expansionFailureReason: compactText(row.expansionFailureReason),
  }

  return Object.fromEntries(
    Object.entries(snapshot).filter(([, value]) => value !== undefined),
  )
}

export function normalizeSnapshotItems(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result.map(normalizeSnapshotItem)
  if (result && typeof result === 'object') {
    const row = result as Record<string, unknown>
    if (Array.isArray(row.misses)) {
      return row.misses.map((miss, index) => ({ id: index + 1, miss }))
    }
    // 観測系（sourceTextLexicalOverlap）: summary を1番目に + 各 observation を続けて記録。
    // 合否を持たない観測専用ノードのため、閾値で絞らず全件をそのまま残す。
    if (Array.isArray(row.observations)) {
      return [buildSnapshotSummary(row, 'observations'), ...buildSnapshotDetailItems(row.observations, 'observation')]
    }
    // デバッグ計測（correctionDebug など）: summary を1番目に + 各 entry を続けて
    // agent 系 result は entries と blocks の両方を持つため、blocks より先にここで扱う。
    if (Array.isArray(row.entries)) {
      return [buildSnapshotSummary(row, ['entries', 'blocks']), ...buildSnapshotDetailItems(row.entries, 'entry')]
    }
    if (Array.isArray(row.blocks)) return row.blocks.map(normalizeSnapshotItem)
    // それ以外の summary 形オブジェクトは単一 item として保存（ノードが走ったことが分かる）
    return [{ _kind: 'summary', ...row }]
  }
  return []
}

/**
 * validator / debug 系の結果オブジェクトから、明細配列を除いたサマリー部分を抽出。
 * 1番目の item として保存され、ノードが何を出力したかを俯瞰できるようにする。
 */
function buildSnapshotSummary(row: Record<string, unknown>, excludeKeys: string | string[]): Record<string, unknown> {
  const excluded = new Set(Array.isArray(excludeKeys) ? excludeKeys : [excludeKeys])
  const summary: Record<string, unknown> = { _kind: 'summary' }
  for (const [k, v] of Object.entries(row)) {
    if (excluded.has(k)) continue
    if (v === undefined) continue
    if (typeof v === 'function') continue
    summary[k] = v
  }
  return summary
}

/**
 * 明細配列の各要素を、そのまま (スナップショット用に項目種別タグだけ付けて) 返す。
 * Block 用の normalizeSnapshotItem は明細用フィールドを潰してしまうので使わない。
 */
function buildSnapshotDetailItems(items: unknown[], kind: string): Record<string, unknown>[] {
  return items.map((item) => {
    if (item && typeof item === 'object') {
      return { _kind: kind, ...(item as Record<string, unknown>) }
    }
    return { _kind: kind, value: item }
  })
}

export async function runLocalPostPipeline(
  transcriptSegments: TranscriptSegment[],
  settings: AdminSettings,
  onStep?: (step: string, detail?: LocalPipelineProgressDetail) => void,
  glossary: LocalPipelineGlossary = { correctionTerms: [], translationTerms: [] },
): Promise<LocalPipelineResult> {
  // 前回実行のカウントが残らないよう、パイプライン開始時に必ずリセットする。
  resetLlmActivity()

  const traces: PipelineNodeTrace[] = []
  const stageSnapshots: PipelineStageSnapshot[] = []
  const thresholds = buildPipelineThresholdsFromSettings(settings)
  let sourceEvidence: SourceSegmentEvidence[] = []

  const recordStageSnapshot = (stage: string, result: unknown): void => {
    const items = normalizeSnapshotItems(result)
    stageSnapshots.push({
      stage,
      at: Date.now(),
      itemCount: items.length,
      items,
    })
  }

  const record = (
    nodeId: string,
    status: 'success' | 'failure',
    durationMs: number,
    summary?: string,
  ): void => {
    traces.push({ nodeId, status, attempt: 1, durationMs, provider: 'local-ts', model: 'local', summary })
  }

  // summarize は任意。ノードの実行結果から「成功時のtrace summary」を取り出すための
  // フック（例: semanticSplitJa のトークン単位判定結果を人が読める形でtraceへ残す。
  // phase1.ts の RunNode 参照）。既存の呼び出し側の大半は summary 不要のため省略可能。
  const runNode = async <T>(
    nodeId: string,
    run: () => Promise<T> | T,
    summarize?: (result: T) => string | undefined,
  ): Promise<T> => {
    const startedAt = Date.now()
    try {
      const result = await runNodeWithHeartbeat(nodeId, run, onStep)
      record(nodeId, 'success', Date.now() - startedAt, summarize?.(result))
      recordStageSnapshot(nodeId, result)
      return result
    } catch (error) {
      record(
        nodeId,
        'failure',
        Date.now() - startedAt,
        error instanceof Error ? error.message : String(error),
      )
      throw error
    }
  }

  recordStageSnapshot('transcribe', transcriptSegments)

  try {
    const phase1Result = await runPhase1(
      transcriptSegments,
      settings,
      thresholds,
      runNode,
      (nodeId, message) => {
        record(nodeId, 'success', 0, message)
      },
      {
        glossaryTerms: glossary.correctionTerms,
      },
    )
    sourceEvidence = buildSourceSegmentEvidence(phase1Result.correctedSegments)
    const enBlocks = await runPhase2(
      phase1Result.blocks,
      settings,
      thresholds,
      runNode,
      (nodeId, message) => {
        record(nodeId, 'success', 0, message)
      },
      glossary.translationTerms,
      { correctedSegments: phase1Result.correctedSegments },
    )
    const phase3 = await runPhase3(enBlocks, settings, glossary.translationTerms, thresholds, runNode)

    const terminologyMustCount = phase3.reviewItems
      .filter((item) => item.blockId === undefined && item.priority === 'must_review')
      .length
    const terminologyShouldCount = phase3.reviewItems
      .filter((item) => item.blockId === undefined && item.priority === 'should_review')
      .length
    const mustReviewCount = phase3.blocks
      .filter((block) => block.reviewPriority === 'must_review')
      .length + terminologyMustCount
    const shouldReviewCount = phase3.blocks
      .filter((block) => block.reviewPriority === 'should_review')
      .length + terminologyShouldCount
    const autoPassCount = phase3.blocks
      .filter((block) => block.reviewPriority === 'auto_pass')
      .length

    return {
      blocks: phase3.blocks,
      traces,
      stageSnapshots,
      sourceEvidence,
      audit: {
        mustReviewCount,
        shouldReviewCount,
        autoPassCount,
        reviewItems: phase3.reviewItems,
        nodeTraces: traces,
      },
    }
  } catch (error) {
    throw attachLocalPipelineDebugFailure(error, traces, stageSnapshots, sourceEvidence)
  }
}
