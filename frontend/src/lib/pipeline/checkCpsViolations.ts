import type { EnBlock, PipelineThresholds } from './blockTypes'
import { computeMetrics, classifyViolation } from './metrics'

export function checkCpsViolations(
  blocks: EnBlock[],
  thresholds: PipelineThresholds,
): EnBlock[] {
  return blocks.map((block) => {
    const metrics = computeMetrics(block)
    // 'untranslated' は translateEn が「未翻訳のまま流す」と決めた特殊状態なので、
    // ここで CPS / line_length 等の通常 violation で上書きしない。
    // 後段の general_repair_agent / manual_review で扱う。
    const violation = block.violation === 'untranslated'
      ? 'untranslated'
      : classifyViolation(block, thresholds)
    return {
      ...block,
      enChars: metrics.enChars,
      cps: Math.round(metrics.cps * 10) / 10,
      maxLineLen: metrics.maxLineLen,
      violation,
    }
  })
}
