import type { EnBlock, JaBlock } from './blockTypes'
import type { CorrectedSegmentLite } from './correct'

/**
 * source_text_undercovered 違反の詳細。
 * チャンク／segment 単位での日本語カバレッジ不足を表す。
 */
export interface CoverageIssue {
  sourceSegmentId: number
  sourceText: string
  coveredText: string
  coverageRatio: number
  sourceChars: number
  coveredChars: number
  affectedBlockIds: number[]
  segmentStart: number
  segmentEnd: number
}

/**
 * チャンク全体のカバレッジ検証結果。
 */
export interface CoverageReport {
  ok: boolean
  threshold: number
  totalSegments: number
  passedSegments: number
  failedSegments: number
  issues: CoverageIssue[]
  /**
   * 全体平均カバレッジ率（measure できた segment のみで計算）。
   */
  avgCoverageRatio: number | null
}

/**
 * カバレッジ判定の標準閾値。LCS ベース。これより下回ったら issue として記録。
 */
export const DEFAULT_COVERAGE_THRESHOLD = 0.9

/**
 * 句読点等を無視した正規化テキスト。
 */
function normalizeCoverageText(text: string): string {
  return text.replace(/[。、「」『』（）()［］\[\]！？!?・,，、.\s]/g, '')
}

/**
 * Longest Common Subsequence length。
 * 2つの文字列の共通部分文字列の最大長を返す。
 */
function lcsLength(a: string, b: string): number {
  if (!a || !b) return 0
  let previous = new Array(b.length + 1).fill(0)
  for (let i = 1; i <= a.length; i += 1) {
    const current = new Array(b.length + 1).fill(0)
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = a[i - 1] === b[j - 1]
        ? previous[j - 1] + 1
        : Math.max(previous[j], current[j - 1])
    }
    previous = current
  }
  return previous[b.length]
}

/**
 * block が segment と時間的に重なるかを判定。
 * 半開区間 [start, end) で扱い、わずかな浮動小数誤差は許容する。
 */
function timeOverlaps(
  blockStart: number,
  blockEnd: number,
  segmentStart: number,
  segmentEnd: number,
  toleranceSec = 0.001,
): boolean {
  return blockEnd > segmentStart - toleranceSec && blockStart < segmentEnd + toleranceSec
}

/**
 * source segment 群と、それを担当する block 群とのカバレッジを検証する。
 *
 * 各 segment について:
 *   1. 時間範囲が重なる block を全て集める
 *   2. それらの jaText を時刻順に連結
 *   3. 連結後テキスト vs segment.correctedText を LCS で比較
 *   4. coverageRatio = LCS長 / segment正規化長
 *   5. ratio < threshold なら CoverageIssue として記録
 *
 * 短い segment（normalize 後 20 文字未満）は判定対象外（誤差影響大のため）。
 */
export function validateCoverage(
  blocks: Array<EnBlock | JaBlock>,
  correctedSegments: CorrectedSegmentLite[],
  threshold: number = DEFAULT_COVERAGE_THRESHOLD,
): CoverageReport {
  const issues: CoverageIssue[] = []
  const ratios: number[] = []

  const sortedBlocks = [...blocks].sort((a, b) => a.start - b.start)

  for (const segment of correctedSegments) {
    const sourceRaw = segment.correctedText ?? ''
    const sourceNorm = normalizeCoverageText(sourceRaw)
    if (sourceNorm.length < 20) continue // 短すぎる segment は判定スキップ

    const overlapping = sortedBlocks.filter((b) =>
      timeOverlaps(b.start, b.end, segment.start, segment.end),
    )
    const coveredRaw = overlapping.map((b) => b.jaText).join('')
    const coveredNorm = normalizeCoverageText(coveredRaw)

    const matched = lcsLength(sourceNorm, coveredNorm)
    const ratio = sourceNorm.length > 0 ? matched / sourceNorm.length : 0
    ratios.push(ratio)

    if (ratio < threshold) {
      issues.push({
        sourceSegmentId: segment.id,
        sourceText: sourceRaw.slice(0, 250),
        coveredText: coveredRaw.slice(0, 250),
        coverageRatio: Math.round(ratio * 1000) / 1000,
        sourceChars: sourceNorm.length,
        coveredChars: coveredNorm.length,
        affectedBlockIds: overlapping.map((b) => b.id),
        segmentStart: segment.start,
        segmentEnd: segment.end,
      })
    }
  }

  const passed = ratios.filter((r) => r >= threshold).length
  const avgCoverageRatio = ratios.length > 0
    ? Math.round((ratios.reduce((a, b) => a + b, 0) / ratios.length) * 1000) / 1000
    : null

  return {
    ok: issues.length === 0,
    threshold,
    totalSegments: ratios.length,
    passedSegments: passed,
    failedSegments: issues.length,
    issues,
    avgCoverageRatio,
  }
}

/**
 * source_text_undercovered 違反の人間可読メッセージを生成する。
 */
export function formatCoverageIssue(issue: CoverageIssue): string {
  const pct = Math.round(issue.coverageRatio * 100)
  return (
    `Source segment ${issue.sourceSegmentId} is only ${pct}% covered ` +
    `by block ja_text (need >= ${Math.round(DEFAULT_COVERAGE_THRESHOLD * 100)}%). ` +
    `Source JA text: "${issue.sourceText}". ` +
    `Currently covered by blocks: "${issue.coveredText}". ` +
    `Affected block IDs: [${issue.affectedBlockIds.join(', ')}].`
  )
}
