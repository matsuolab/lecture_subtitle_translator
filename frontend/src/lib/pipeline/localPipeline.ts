import type { TranscriptSegment } from './types'
import type { SubtitleBlock } from '@/types/subtitle'
import type { AdminSettings } from '@/types/adminSettings'
import type { PipelineAuditReport, PipelineNodeTrace } from '@/types/pipeline'

import type { PipelineThresholds } from './blockTypes'
import { runPhase1 } from './phase1'
import { runPhase2 } from './phase2'
import { runPhase3 } from './phase3'

export interface LocalPipelineResult {
  blocks: SubtitleBlock[]
  traces: PipelineNodeTrace[]
  audit: PipelineAuditReport
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
): Promise<LocalPipelineResult> {
  const traces: PipelineNodeTrace[] = []
  const thresholds = buildPipelineThresholds(settings)

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

  const jaBlocks = await runPhase1(
    transcriptSegments,
    settings,
    thresholds,
    runNode,
    {
      glossaryTerms: [],
    },
  )
  const enBlocks = await runPhase2(jaBlocks, settings, thresholds, runNode, (nodeId, message) => {
    record(nodeId, 'success', 0, message)
  })
  const phase3 = await runPhase3(enBlocks, [], runNode)

  const mustReviewCount = phase3.reviewItems.filter((item) => item.priority === 'must_review').length
  const shouldReviewCount = phase3.reviewItems.filter((item) => item.priority === 'should_review').length
  const autoPassCount = Math.max(0, phase3.blocks.length - mustReviewCount - shouldReviewCount)

  return {
    blocks: phase3.blocks,
    traces,
    audit: {
      mustReviewCount,
      shouldReviewCount,
      autoPassCount,
      reviewItems: phase3.reviewItems,
      nodeTraces: traces,
    },
  }
}
