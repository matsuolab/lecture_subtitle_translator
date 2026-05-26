import type { EnBlock } from './blockTypes'
import type { CorrectedSegmentLite } from './correct'
import type { CoverageIssue, CoverageReport } from './coverageValidator'
import { validateCoverage } from './coverageValidator'

/**
 * 1 segment 単位での再配分ログ。
 * coverage_repair_agent 同様、Pipeline trace に保存して後で挙動を追跡できるようにする。
 */
export interface RedistributeLogEntry {
  sourceSegmentId: number
  affectedBlockIds: number[]
  beforeCoverageRatio: number
  afterCoverageRatio: number
  changedBlocks: Array<{
    blockId: number
    beforeJaSpan: string
    afterJaSpan: string
    beforeChars: number
    afterChars: number
  }>
  /**
   * - 'improved': 再配分でカバレッジが上昇した（このまま採用）
   * - 'no_change': 提案が元と同じ
   * - 'reverted': 提案後にカバレッジが下がった（元に戻した）
   * - 'segment_not_found': segment 不一致でスキップ
   */
  status: 'improved' | 'no_change' | 'reverted' | 'segment_not_found'
  reason?: string
}

/**
 * 再配分の全体結果。Pipeline trace に保存（snapshot 経由）。
 */
export interface RedistributeResult {
  totalIssues: number
  improved: number
  unchanged: number
  reverted: number
  blocks: EnBlock[]
  entries: RedistributeLogEntry[]
  finalReport: CoverageReport
}

/**
 * 句読点・空白を含む生テキストの長さに対し、視覚的文字長を返す。
 * normalizeCoverageText と一致させたいが、ここでは「再配分される元テキスト」を
 * 維持したまま処理するため、生文字列を時間比例で切る。
 */

/**
 * source_text_undercovered の issue を「ja_span の時間比例再配分」で決定的に救う試み。
 *
 * 仕組み:
 *   1. issue 対象 segment と、それを覆っている block 群を時系列順に取り出す
 *   2. 各 block の duration から segment 全体に対する占有率を計算
 *   3. segment の corrected text を生のまま、占有率に応じて切り分け、各 block に再割当
 *   4. 再配分後の coverage を再計算し、ratio が上がっていたら採用、そうでなければ revert
 *
 * 注意点:
 *   - en text には触らない（決定的処理のため）
 *   - ja_span 拡張は coverage_validator の判定だけ通せれば良い（後段 coverage_repair_agent の発動回避が目的）
 *   - 再配分が悪化させるケース（splitJa の semantic split を破壊）に備えて、必ず再 validate して revert する
 *
 * 救えるパターン:
 *   - 末尾の取りこぼし (segment 末尾の数文字が最終 cue に含まれていない)
 *   - cue 境界の微妙なズレ
 *
 * 救えないパターン:
 *   - 翻訳時に意味的に省略された内容（en の rewrite が必要 → coverage_repair_agent の領域）
 */
export function redistributeJaSpan(
  blocks: EnBlock[],
  correctedSegments: CorrectedSegmentLite[],
  coverageReport: CoverageReport,
): RedistributeResult {
  if (coverageReport.issues.length === 0) {
    return {
      totalIssues: 0,
      improved: 0,
      unchanged: 0,
      reverted: 0,
      blocks,
      entries: [],
      finalReport: coverageReport,
    }
  }

  let currentBlocks = blocks
  const entries: RedistributeLogEntry[] = []

  for (const issue of coverageReport.issues) {
    const entry = redistributeOneIssue(issue, currentBlocks, correctedSegments)
    entries.push(entry)
    if (entry.status === 'improved') {
      currentBlocks = applyChanges(currentBlocks, entry.changedBlocks)
    }
  }

  const finalReport = validateCoverage(currentBlocks, correctedSegments)

  return {
    totalIssues: coverageReport.issues.length,
    improved: entries.filter((e) => e.status === 'improved').length,
    unchanged: entries.filter((e) => e.status === 'no_change').length,
    reverted: entries.filter((e) => e.status === 'reverted').length,
    blocks: currentBlocks,
    entries,
    finalReport,
  }
}

function applyChanges(
  blocks: EnBlock[],
  changes: RedistributeLogEntry['changedBlocks'],
): EnBlock[] {
  if (changes.length === 0) return blocks
  const byId = new Map<number, { afterJaSpan: string; afterChars: number }>()
  for (const c of changes) {
    byId.set(c.blockId, { afterJaSpan: c.afterJaSpan, afterChars: c.afterChars })
  }
  return blocks.map((b) => {
    const c = byId.get(b.id)
    if (!c) return b
    return {
      ...b,
      jaText: c.afterJaSpan,
      jaChars: c.afterChars,
    }
  })
}

function redistributeOneIssue(
  issue: CoverageIssue,
  currentBlocks: EnBlock[],
  correctedSegments: CorrectedSegmentLite[],
): RedistributeLogEntry {
  const segment = correctedSegments.find((s) => s.id === issue.sourceSegmentId)
  if (!segment) {
    return {
      sourceSegmentId: issue.sourceSegmentId,
      affectedBlockIds: issue.affectedBlockIds,
      beforeCoverageRatio: issue.coverageRatio,
      afterCoverageRatio: issue.coverageRatio,
      changedBlocks: [],
      status: 'segment_not_found',
      reason: 'source segment id not found in correctedSegments',
    }
  }

  // 対象 block を時系列順で抽出
  const affected = currentBlocks
    .filter((b) => issue.affectedBlockIds.includes(b.id))
    .sort((a, b) => a.start - b.start)

  if (affected.length === 0) {
    return {
      sourceSegmentId: issue.sourceSegmentId,
      affectedBlockIds: issue.affectedBlockIds,
      beforeCoverageRatio: issue.coverageRatio,
      afterCoverageRatio: issue.coverageRatio,
      changedBlocks: [],
      status: 'segment_not_found',
      reason: 'no affected blocks found in currentBlocks',
    }
  }

  // segment の corrected text を生で扱う（コピー前の文字列）。
  // 文字数で切り分けるので「正規化前」を採用（句読点も再配分対象）。
  const sourceText = segment.correctedText ?? ''
  const sourceLen = sourceText.length
  if (sourceLen === 0) {
    return {
      sourceSegmentId: issue.sourceSegmentId,
      affectedBlockIds: issue.affectedBlockIds,
      beforeCoverageRatio: issue.coverageRatio,
      afterCoverageRatio: issue.coverageRatio,
      changedBlocks: [],
      status: 'no_change',
      reason: 'source text empty',
    }
  }

  // 各 block の duration 比率 → 文字数の比例配分
  const totalDuration = affected.reduce((sum, b) => sum + Math.max(0, b.end - b.start), 0)
  if (totalDuration <= 0) {
    return {
      sourceSegmentId: issue.sourceSegmentId,
      affectedBlockIds: issue.affectedBlockIds,
      beforeCoverageRatio: issue.coverageRatio,
      afterCoverageRatio: issue.coverageRatio,
      changedBlocks: [],
      status: 'no_change',
      reason: 'total duration is zero',
    }
  }

  // 切り分け境界を文字数として計算（累積）
  // 最後の block には残りを全部押し込む（端数 / 取りこぼし防止）
  const boundaries: number[] = []
  let cumulativeDuration = 0
  for (let i = 0; i < affected.length - 1; i += 1) {
    const block = affected[i]
    const dur = Math.max(0, block.end - block.start)
    cumulativeDuration += dur
    const boundaryChar = Math.round((cumulativeDuration / totalDuration) * sourceLen)
    boundaries.push(Math.min(sourceLen, Math.max(0, boundaryChar)))
  }

  // 各 block に文字範囲を割当
  const changedBlocks: RedistributeLogEntry['changedBlocks'] = []
  let cursor = 0
  for (let i = 0; i < affected.length; i += 1) {
    const block = affected[i]
    const startChar = cursor
    const endChar = i === affected.length - 1 ? sourceLen : boundaries[i] ?? cursor
    cursor = endChar
    const newSpan = sourceText.slice(startChar, endChar)
    if (newSpan === block.jaText) continue // 変化なし
    changedBlocks.push({
      blockId: block.id,
      beforeJaSpan: block.jaText,
      afterJaSpan: newSpan,
      beforeChars: block.jaChars,
      afterChars: newSpan.replace(/\s/g, '').length,
    })
  }

  if (changedBlocks.length === 0) {
    return {
      sourceSegmentId: issue.sourceSegmentId,
      affectedBlockIds: issue.affectedBlockIds,
      beforeCoverageRatio: issue.coverageRatio,
      afterCoverageRatio: issue.coverageRatio,
      changedBlocks: [],
      status: 'no_change',
      reason: 'proposal identical to current',
    }
  }

  // 提案を仮適用して再 validate
  const proposed = applyChanges(currentBlocks, changedBlocks)
  const recheck = validateCoverage(proposed, correctedSegments)
  const recheckedIssue = recheck.issues.find((i) => i.sourceSegmentId === issue.sourceSegmentId)
  const afterRatio = recheckedIssue ? recheckedIssue.coverageRatio : 1.0

  // 改善判定（少しでも上がったら採用、下がったら revert）
  if (afterRatio > issue.coverageRatio + 0.001) {
    return {
      sourceSegmentId: issue.sourceSegmentId,
      affectedBlockIds: issue.affectedBlockIds,
      beforeCoverageRatio: issue.coverageRatio,
      afterCoverageRatio: afterRatio,
      changedBlocks,
      status: 'improved',
    }
  }

  return {
    sourceSegmentId: issue.sourceSegmentId,
    affectedBlockIds: issue.affectedBlockIds,
    beforeCoverageRatio: issue.coverageRatio,
    afterCoverageRatio: afterRatio,
    changedBlocks,
    status: 'reverted',
    reason: 'redistribution did not improve coverage',
  }
}
