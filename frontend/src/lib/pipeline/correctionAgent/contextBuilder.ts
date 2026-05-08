import type { AdminSettings } from '@/types/adminSettings'
import type { EnBlock, PipelineThresholds } from '../blockTypes'
import type { AgentThresholds, CorrectionAttempt, DecisionContext } from './types'

export function buildContext(
  block: EnBlock,
  blockIndex: number,
  timeline: EnBlock[],
  attemptHistory: CorrectionAttempt[],
  thresholds: PipelineThresholds & AgentThresholds,
  settings: AdminSettings,
): DecisionContext {
  const prevBlock = blockIndex > 0 ? timeline[blockIndex - 1] : undefined
  const nextBlock = blockIndex < timeline.length - 1 ? timeline[blockIndex + 1] : undefined

  const gapBeforeMs = prevBlock
    ? Math.max(0, Math.round((block.start - prevBlock.end) * 1000))
    : 0

  const gapAfterMs = nextBlock
    ? Math.max(0, Math.round((nextBlock.start - block.end) * 1000))
    : 0

  const physicalMaxChars = Math.floor(thresholds.verboseCps * (block.end - block.start))

  const prevPhysicalMax = prevBlock
    ? Math.floor(thresholds.verboseCps * (prevBlock.end - prevBlock.start))
    : undefined
  const nextPhysicalMax = nextBlock
    ? Math.floor(thresholds.verboseCps * (nextBlock.end - nextBlock.start))
    : undefined

  return {
    block,
    blockIndex,
    prevBlock,
    nextBlock,
    gapBeforeMs,
    gapAfterMs,
    physicalMaxChars,
    neighborSlack: {
      prev: prevBlock && prevPhysicalMax !== undefined
        ? Math.max(0, prevPhysicalMax - prevBlock.enChars)
        : undefined,
      next: nextBlock && nextPhysicalMax !== undefined
        ? Math.max(0, nextPhysicalMax - nextBlock.enChars)
        : undefined,
    },
    attemptHistory,
    thresholds,
    settings,
  }
}
