import type { PipelineThresholds } from '../blockTypes'
import type { AgentThresholds, CorrectionStrategy, DecisionContext } from './types'
import { buildMetrics } from './metrics'

export function getFeasibleStrategies(
  ctx: DecisionContext,
  thresholds: PipelineThresholds & AgentThresholds,
): CorrectionStrategy[] {
  const m = buildMetrics(ctx, thresholds)
  const { attemptHistory } = ctx
  const tried = new Set(attemptHistory.map(a => a.strategy))
  const failed = m.failed

  const compressCount = ctx.block.compressCount ?? 0
  const strategies: CorrectionStrategy[] = []

  if (
    m.borrowViable &&
    !tried.has('borrow_gap')
  ) {
    strategies.push('borrow_gap')
  }

  if (
    compressCount < thresholds.maxCompressPerBlock &&
    !failed.has('compress_rephrase') &&
    !tried.has('compress_rephrase')
  ) {
    strategies.push('compress_rephrase')
  }

  if (
    compressCount < thresholds.maxCompressPerBlock &&
    !failed.has('compress_trim') &&
    !tried.has('compress_trim')
  ) {
    strategies.push('compress_trim')
  }

  if (m.splitViable && !tried.has('split_block')) {
    strategies.push('split_block')
  }

  if (
    compressCount < thresholds.maxCompressPerBlock &&
    !failed.has('compress_core') &&
    !tried.has('compress_core')
  ) {
    strategies.push('compress_core')
  }

  if (
    thresholds.enableOffloadNeighbor &&
    !tried.has('offload_neighbor')
  ) {
    strategies.push('offload_neighbor')
  }

  return strategies
}
