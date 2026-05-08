import type { PipelineThresholds } from '../blockTypes'
import type { AgentThresholds, CompressionTier, CorrectionAttempt, DecisionContext, DecisionMetrics } from './types'

export function buildMetrics(
  ctx: DecisionContext,
  thresholds: PipelineThresholds & AgentThresholds,
): DecisionMetrics {
  const { block, gapBeforeMs, gapAfterMs, attemptHistory } = ctx
  const durationMs = Math.round((block.end - block.start) * 1000)
  const durationSec = block.end - block.start
  const currentChars = block.enChars
  const physicalMaxChars = Math.floor(thresholds.verboseCps * durationSec)
  const deficitChars = Math.max(0, currentChars - physicalMaxChars)
  const overRatio = physicalMaxChars > 0 ? currentChars / physicalMaxChars : Infinity
  const requiredDurationMs = Math.ceil((currentChars / thresholds.verboseCps) * 1000)
  const missingDurationMs = Math.max(0, requiredDurationMs - durationMs)

  const borrowableBeforeMs = Math.max(0, gapBeforeMs - thresholds.minInterSubtitleGapMs)
  const borrowableAfterMs = Math.max(0, gapAfterMs - thresholds.minInterSubtitleGapMs)
  const totalBorrowableMs = borrowableBeforeMs + borrowableAfterMs

  const keepRatioNeeded = physicalMaxChars > 0 ? physicalMaxChars / currentChars : 1
  const reductionRatioNeeded = Math.max(0, 1 - keepRatioNeeded)

  const minSplitDurationMs =
    2 * thresholds.subtitleMinDurationSec * 1000 + thresholds.minInterSubtitleGapMs
  const splitDepth = (block as { splitDepth?: number }).splitDepth ?? 0
  const splitViable =
    durationMs >= minSplitDurationMs && splitDepth < thresholds.maxSplitDepth

  const borrowViable =
    totalBorrowableMs >= thresholds.minUsefulBorrowMs &&
    missingDurationMs <= totalBorrowableMs

  const tier = classifyCompressionNeed(deficitChars, overRatio)

  const tried = new Set(attemptHistory.map(a => a.strategy))
  const failed = new Set(attemptHistory.filter(a => isFailedAttempt(a, thresholds)).map(a => a.strategy))

  return {
    durationMs,
    durationSec,
    currentChars,
    physicalMaxChars,
    deficitChars,
    overRatio,
    requiredDurationMs,
    missingDurationMs,
    borrowableBeforeMs,
    borrowableAfterMs,
    totalBorrowableMs,
    keepRatioNeeded,
    reductionRatioNeeded,
    splitViable,
    borrowViable,
    tier,
    tried,
    failed,
  }
}

export function classifyCompressionNeed(deficitChars: number, overRatio: number): CompressionTier {
  if (deficitChars <= 0) return 'none'
  if (overRatio <= 1.10) return 'tiny'
  if (overRatio <= 1.25) return 'small'
  if (overRatio <= 1.45) return 'medium'
  if (overRatio <= 1.80) return 'large'
  return 'extreme'
}

export function isFailedAttempt(
  attempt: CorrectionAttempt,
  thresholds: Pick<AgentThresholds, 'minReductionDeltaChars' | 'minReductionDeltaRatio'>,
): boolean {
  if (!attempt.changed) return true
  const deltaChars = attempt.beforeChars - attempt.afterChars
  if (deltaChars < thresholds.minReductionDeltaChars) return true
  const deltaRatio = deltaChars / attempt.beforeChars
  if (deltaRatio < thresholds.minReductionDeltaRatio) return true
  if (attempt.afterViolation === attempt.beforeViolation && deltaRatio < 0.08) return true
  return false
}
