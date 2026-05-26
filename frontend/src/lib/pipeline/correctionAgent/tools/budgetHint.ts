import type { EnBlock, PipelineThresholds } from '../../blockTypes'

/**
 * compress 系ツールが LLM に渡す「予算情報」のヒントを構築する。
 *
 * - duration_sec / max_cps から allowed_chars を逆算
 * - 現在の en_chars と比較して chars_to_remove を提示
 * - 行長・行数制約も提示
 *
 * これらは production の DecisionMetrics で既に計算済みだが、ツールごとに ctx へ
 * 引き回すと型が増えるので、ブロック + thresholds から再計算するヘルパーとして提供。
 *
 * LLM が文字数を厳密に守れる訳ではないが、目標値を明示することで違反量の縮小が期待できる。
 * （PoC で実証された改善: cps_over の場合に LLM へ chars_to_remove を渡すと適切な短縮率になりやすい）
 */
export function buildBudgetHint(block: EnBlock, thresholds: PipelineThresholds): string {
  const duration = Math.max(0.001, block.end - block.start)
  const currentChars = block.enChars
  const allowedChars = Math.floor(duration * thresholds.verboseCps)
  const charsToRemove = Math.max(0, currentChars - allowedChars)
  const currentCps = Math.round((currentChars / duration) * 10) / 10
  const maxLineLen = thresholds.maxLineLen
  const maxLines = 2 // 既存実装上 2 行想定（formatLines も同様）
  const maxSegmentChars = maxLineLen * maxLines

  const violationParts: string[] = []
  if (charsToRemove > 0) {
    violationParts.push(
      `CPS違反: 現在 ${currentChars}文字を ${duration.toFixed(2)}秒で表示 (cps=${currentCps}, max=${thresholds.verboseCps})。` +
        `${allowedChars}文字以下に縮める必要があり、約${charsToRemove}文字削減が目安`,
    )
  }
  if (block.maxLineLen > maxLineLen) {
    violationParts.push(`行長違反: 最大 ${block.maxLineLen}文字 (max=${maxLineLen})`)
  }
  if (currentChars > maxSegmentChars) {
    violationParts.push(`総文字数違反: ${currentChars}文字 (max=${maxSegmentChars} = 2行×${maxLineLen}文字)`)
  }
  const violationSummary = violationParts.length > 0 ? `\n${violationParts.join('\n')}` : ''

  return (
    `Constraints (must respect):\n` +
    `- duration: ${duration.toFixed(2)}s\n` +
    `- max_cps: ${thresholds.verboseCps}\n` +
    `- allowed_chars: ${allowedChars} (= floor(duration × max_cps))\n` +
    `- max_chars_per_line: ${maxLineLen}\n` +
    `- max_lines: ${maxLines}\n` +
    `- max_segment_chars: ${maxSegmentChars}\n` +
    `\nCurrent state:\n` +
    `- en_chars: ${currentChars}\n` +
    `- max_line_len: ${block.maxLineLen}\n` +
    `- cps: ${currentCps}` +
    violationSummary
  )
}
