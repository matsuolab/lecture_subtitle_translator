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

  // 時間が長すぎる違反（long_segment / merged_long）には圧縮系を呼ばない。
  // 圧縮しても duration は変わらないため違反が解消しない。split_block / borrow_gap で対応する。
  const isDurationViolation =
    ctx.block.violation === 'long_segment' || ctx.block.violation === 'merged_long'

  if (
    m.borrowViable &&
    !tried.has('borrow_gap')
  ) {
    strategies.push('borrow_gap')
  }

  // tier=tiny（≤10%超過）の場合のみ compress_micro を候補に。
  // 1単語ずつ精密に削るための専用ツール。
  if (
    !isDurationViolation &&
    m.tier === 'tiny' &&
    compressCount < thresholds.maxCompressPerBlock &&
    !failed.has('compress_micro') &&
    !tried.has('compress_micro')
  ) {
    strategies.push('compress_micro')
  }

  if (
    !isDurationViolation &&
    compressCount < thresholds.maxCompressPerBlock &&
    !failed.has('compress_rephrase') &&
    !tried.has('compress_rephrase')
  ) {
    strategies.push('compress_rephrase')
  }

  if (
    !isDurationViolation &&
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
    !isDurationViolation &&
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
