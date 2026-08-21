import type { EnBlock, PipelineThresholds } from './blockTypes'
import { computeMetrics } from './metrics'
import { splitSubtitleLines } from './textUtils'

/**
 * 字幕テキストを表示用に折り返す。
 * 折り返し規則は thresholds.subtitleScript で切り替わる（未指定はラテン系＝従来と同一）。
 */
export function formatLines(blocks: EnBlock[], thresholds: PipelineThresholds): EnBlock[] {
  const script = thresholds.subtitleScript ?? 'latin'
  return blocks.map((block) => {
    const enText = splitSubtitleLines(block.enRaw ?? block.enText, thresholds.maxLineLen, script)
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
