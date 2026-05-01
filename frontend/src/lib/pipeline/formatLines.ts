import type { EnBlock, PipelineThresholds } from './blockTypes'
import { computeMetrics } from './metrics'
import { splitEnLines42 } from './textUtils'

export function formatLines(blocks: EnBlock[], thresholds: PipelineThresholds): EnBlock[] {
  return blocks.map((block) => {
    const enText = splitEnLines42(block.enRaw ?? block.enText, thresholds.maxLineLen)
    const metrics = computeMetrics({ ...block, enText })
    return {
      ...block,
      enText,
      enChars: metrics.enChars,
      cps: metrics.cps,
      maxLineLen: metrics.maxLineLen,
    }
  })
}
