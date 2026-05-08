import type { EnBlock, PipelineThresholds } from '../blockTypes'
import { classifyViolation, computeMetrics } from '../metrics'
import { formatLines } from '../formatLines'
import type { AgentThresholds, TimelinePatch } from './types'

export function applyPatch(timeline: EnBlock[], patch: TimelinePatch): EnBlock[] {
  if (patch.replaceBlocks.length === 0) return timeline

  const firstId = patch.replaceBlocks[0].id
  const replaceIdx = timeline.findIndex(b => b.id === firstId)
  if (replaceIdx === -1) return timeline

  const result = [
    ...timeline.slice(0, replaceIdx),
    ...patch.replaceBlocks,
    ...timeline.slice(replaceIdx + 1),
  ]

  if (patch.updatedNeighborBlocks && patch.updatedNeighborBlocks.length > 0) {
    for (const neighbor of patch.updatedNeighborBlocks) {
      const idx = result.findIndex(b => b.id === neighbor.id)
      if (idx !== -1) result[idx] = neighbor
    }
  }

  return result
}

export function normalizeAndValidate(
  patch: TimelinePatch,
  thresholds: PipelineThresholds & AgentThresholds,
): TimelinePatch {
  const normalizedBlocks = patch.replaceBlocks.map(block => {
    const formatted = formatLines([block], thresholds)[0]
    const metrics = computeMetrics(formatted)
    const violation = classifyViolation(formatted, thresholds)
    return {
      ...formatted,
      enChars: metrics.enChars,
      cps: Math.round(metrics.cps * 10) / 10,
      maxLineLen: metrics.maxLineLen,
      violation,
    }
  })

  const normalizedNeighbors = patch.updatedNeighborBlocks?.map(block => {
    const formatted = formatLines([block], thresholds)[0]
    const metrics = computeMetrics(formatted)
    const violation = classifyViolation(formatted, thresholds)
    return {
      ...formatted,
      enChars: metrics.enChars,
      cps: Math.round(metrics.cps * 10) / 10,
      maxLineLen: metrics.maxLineLen,
      violation,
    }
  })

  return {
    ...patch,
    replaceBlocks: normalizedBlocks,
    updatedNeighborBlocks: normalizedNeighbors,
  }
}

export function meetsConstraints(block: EnBlock): boolean {
  return block.violation === 'ok' || block.violation === 'slow_speech'
}

export function markManualReview(block: EnBlock): EnBlock {
  return { ...block, violation: block.violation }
}
