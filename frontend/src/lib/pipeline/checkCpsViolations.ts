import type { EnBlock, PipelineThresholds } from './blockTypes'
import { computeMetrics, classifyViolation } from './metrics'

export function checkCpsViolations(
  blocks: EnBlock[],
  thresholds: PipelineThresholds,
): EnBlock[] {
  return blocks.map((block) => {
    const metrics = computeMetrics(block)
    return {
      ...block,
      enChars: metrics.enChars,
      cps: Math.round(metrics.cps * 10) / 10,
      maxLineLen: metrics.maxLineLen,
      violation: classifyViolation(block, thresholds),
    }
  })
}
