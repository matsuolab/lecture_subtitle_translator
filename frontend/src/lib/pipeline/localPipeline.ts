import type { TranscriptSegment } from './types'
import type { SubtitleBlock } from '@/types/subtitle'
import type { AdminSettings } from '@/types/adminSettings'
import type { PipelineAuditReport, PipelineNodeTrace, PipelineStageSnapshot } from '@/types/pipeline'

import type { PipelineThresholds } from './blockTypes'
import { runPhase1 } from './phase1'
import { runPhase2 } from './phase2'
import { runPhase3 } from './phase3'

export interface LocalPipelineResult {
  blocks: SubtitleBlock[]
  traces: PipelineNodeTrace[]
  audit: PipelineAuditReport
  stageSnapshots: PipelineStageSnapshot[]
}

export interface LocalPipelineGlossary {
  correctionTerms: string[]
  translationTerms: string[]
}

export interface LocalPipelineDebugFailure {
  traces?: PipelineNodeTrace[]
  stageSnapshots?: PipelineStageSnapshot[]
}

export function getLocalPipelineDebugFailure(error: unknown): LocalPipelineDebugFailure {
  if (!error || typeof error !== 'object') return {}
  const row = error as Record<string, unknown>
  return {
    traces: Array.isArray(row.localPipelineTraces) ? row.localPipelineTraces as PipelineNodeTrace[] : undefined,
    stageSnapshots: Array.isArray(row.localPipelineStageSnapshots) ? row.localPipelineStageSnapshots as PipelineStageSnapshot[] : undefined,
  }
}

function attachLocalPipelineDebugFailure(
  error: unknown,
  traces: PipelineNodeTrace[],
  stageSnapshots: PipelineStageSnapshot[],
): Error {
  const err = error instanceof Error ? error : new Error(String(error))
  Object.assign(err, {
    localPipelineTraces: traces,
    localPipelineStageSnapshots: stageSnapshots,
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
  const snapshot: Record<string, unknown> = {
    id: row.id,
    start: compactNumber(row.start) ?? compactNumber(row.startTime),
    end: compactNumber(row.end) ?? compactNumber(row.endTime),
    transcriptText: compactText(row.jaText) ?? compactText(row.ja_corrected) ?? compactText(row.target) ?? compactText(row.text),
    rawTranscriptText: compactText(row.text),
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
    reviewPriority: compactText(row.reviewPriority),
    reviewDisposition: compactText(row.reviewDisposition),
    correctionDistance: compactNumber(row.correction_distance),
    correctionFlagged: compactBoolean(row.correction_flagged),
    translationFlagged: compactBoolean(row.translation_flagged),
    translationProvider: compactText(row.translation_provider),
    correctionAttempts: Array.isArray(row.correctionAttempts) ? row.correctionAttempts : undefined,
  }

  return Object.fromEntries(
    Object.entries(snapshot).filter(([, value]) => value !== undefined),
  )
}

function normalizeSnapshotItems(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result.map(normalizeSnapshotItem)
  if (result && typeof result === 'object') {
    const row = result as Record<string, unknown>
    if (Array.isArray(row.blocks)) return row.blocks.map(normalizeSnapshotItem)
    if (Array.isArray(row.misses)) {
      return row.misses.map((miss, index) => ({ id: index + 1, miss }))
    }
  }
  return []
}

function buildPipelineThresholds(settings: AdminSettings): PipelineThresholds {
  return {
    shortDurationSec: settings.pipelineShortDurationSec,
    longDurationSec: settings.pipelineLongDurationSec,
    mergedLongDurationSec: settings.pipelineMergedLongDurationSec,
    overCompressedRatio: settings.pipelineOverCompressedRatio,
    overCompressedJaChars: settings.pipelineOverCompressedJaChars,
    verboseEnRatio: settings.pipelineVerboseEnRatio,
    verboseCps: settings.enMaxCps,
    maxLineLen: settings.enMaxCharsPerLine,
    slowCps: settings.pipelineSlowCps,
    maxExpandPerBlock: settings.pipelineMaxExpandPerBlock,
    maxCompressPerBlock: settings.pipelineMaxCompressPerBlock,
    maxPhase2Retries: settings.pipelineMaxPhase2Retries,
  }
}

export async function runLocalPostPipeline(
  transcriptSegments: TranscriptSegment[],
  settings: AdminSettings,
  onStep?: (step: string) => void,
  glossary: LocalPipelineGlossary = { correctionTerms: [], translationTerms: [] },
): Promise<LocalPipelineResult> {
  const traces: PipelineNodeTrace[] = []
  const stageSnapshots: PipelineStageSnapshot[] = []
  const thresholds = buildPipelineThresholds(settings)

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

  const runNode = async <T>(nodeId: string, run: () => Promise<T> | T): Promise<T> => {
    onStep?.(nodeId)
    const startedAt = Date.now()
    try {
      const result = await run()
      record(nodeId, 'success', Date.now() - startedAt)
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
    const jaBlocks = await runPhase1(
      transcriptSegments,
      settings,
      thresholds,
      runNode,
      {
        glossaryTerms: glossary.correctionTerms,
      },
    )
    const enBlocks = await runPhase2(jaBlocks, settings, thresholds, runNode, (nodeId, message) => {
      record(nodeId, 'success', 0, message)
    }, glossary.translationTerms)
    const phase3 = await runPhase3(enBlocks, glossary.translationTerms, thresholds, runNode)

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
      audit: {
        mustReviewCount,
        shouldReviewCount,
        autoPassCount,
        reviewItems: phase3.reviewItems,
        nodeTraces: traces,
      },
    }
  } catch (error) {
    throw attachLocalPipelineDebugFailure(error, traces, stageSnapshots)
  }
}
