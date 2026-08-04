import type { EnBlock, JaBlock } from './blockTypes'
import type { CorrectedSegmentLite } from './correct'

/**
 * このモジュールが測っているもの / 測っていないもの（実測に基づく注意書き）。
 *
 * 測っているもの:
 *   「原文 segment」と「その時間帯に重なる block 群の jaText を連結したもの」を
 *   文字 LCS で比較した、純粋な文字レベルの重なり率。それだけ。
 *
 * 測っていないもの・使ってはいけない理由:
 *   このパイプラインは `correctJa`（表記・言い回しの整形）と `correctionEngine` の
 *   `split_block`（フィラー除去）で、意図的に日本語を書き換える。したがって
 *   overlapRatio が低いことは「内容が失われた」ことを意味しない。
 *
 *   実測（293セグメント中 62件が 0.9 未満）での内訳:
 *     - correctJa 等による書き換え: 81%
 *     - block への誤帰属（時間重なりのズレ）: 8%
 *     - フィラー除去: 11%
 *     - 内容欠落: 0件
 *   埋め込みベースの指標に替えても「書き換え」と「欠落」は分離できない（AUC 0.787、実測）。
 *
 *   過去に this ratio を自動修復の判断根拠として使ったところ（原文を duration 比で機械的に
 *   再配分して jaText を上書きする決定的処理）、937 ブロック中 26% の日本語が壊れ、
 *   文節途中で切れる境界が 11 → 97 に増える結果になった（この処理は削除済み）。
 *   generalRepairAgent も同様に、この指標を満たすために LLM へ ja_span の書き換えを
 *   許可していたことがあった（その許可は撤回済み。en のみ変更可）。
 *
 *   → **この値を合否判定・自動修復のトリガーとして使ってはならない。**
 *     trace に observations として残し、人間が後から確認するための観測値としてのみ扱う。
 */

export interface SourceTextOverlapEntry {
  sourceSegmentId: number
  sourceText: string
  coveredText: string
  /** 原文に対する、担当ブロックの日本語の文字レベル重なり率（LCS長 / 原文正規化長）。合否ではない。 */
  overlapRatio: number
  sourceChars: number
  coveredChars: number
  affectedBlockIds: number[]
  segmentStart: number
  segmentEnd: number
}

/**
 * source segment 群と、それを担当する block 群との文字レベル重なりの観測結果。
 * 合否の概念は持たない（ok / passedSegments / failedSegments / threshold は存在しない）。
 */
export interface SourceTextOverlapReport {
  totalSegments: number
  /** 全体平均の重なり率（measure できた segment のみで計算）。 */
  avgOverlapRatio: number | null
  /** 閾値で絞らない、測定できた全 segment 分の観測値。 */
  observations: SourceTextOverlapEntry[]
}

/**
 * 句読点等を無視した正規化テキスト。
 */
function normalizeOverlapText(text: string): string {
  return text.replace(/[。、「」『』（）()［］[\]！？!?・,，、.\s]/g, '')
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
 * source segment 群と、それを担当する block 群との文字レベル重なりを観測する（決定的・LCSベース）。
 *
 * 各 segment について:
 *   1. 時間範囲が重なる block を全て集める
 *   2. それらの jaText を時刻順に連結
 *   3. 連結後テキスト vs segment.correctedText を LCS で比較
 *   4. overlapRatio = LCS長 / segment正規化長
 *   5. 閾値による足切りはしない。測定できた segment は全て observations に入れる。
 *
 * 短い segment（normalize 後 20 文字未満）は測定対象外（誤差影響が大きく、観測値として
 * 信頼できないため）。合否判定ではないので「除外」であって「不合格」ではない。
 *
 * この関数の戻り値は何も駆動しない。trace への記録専用。
 */
export function measureSourceTextLexicalOverlap(
  blocks: Array<EnBlock | JaBlock>,
  correctedSegments: CorrectedSegmentLite[],
): SourceTextOverlapReport {
  const observations: SourceTextOverlapEntry[] = []
  const ratios: number[] = []

  const sortedBlocks = [...blocks].sort((a, b) => a.start - b.start)

  for (const segment of correctedSegments) {
    const sourceRaw = segment.correctedText ?? ''
    const sourceNorm = normalizeOverlapText(sourceRaw)
    if (sourceNorm.length < 20) continue // 短すぎる segment は測定対象外（誤差影響大のため）

    const overlapping = sortedBlocks.filter((b) =>
      timeOverlaps(b.start, b.end, segment.start, segment.end),
    )
    const coveredRaw = overlapping.map((b) => b.jaText).join('')
    const coveredNorm = normalizeOverlapText(coveredRaw)

    const matched = lcsLength(sourceNorm, coveredNorm)
    const ratio = sourceNorm.length > 0 ? matched / sourceNorm.length : 0
    ratios.push(ratio)

    observations.push({
      sourceSegmentId: segment.id,
      sourceText: sourceRaw.slice(0, 250),
      coveredText: coveredRaw.slice(0, 250),
      overlapRatio: Math.round(ratio * 1000) / 1000,
      sourceChars: sourceNorm.length,
      coveredChars: coveredNorm.length,
      affectedBlockIds: overlapping.map((b) => b.id),
      segmentStart: segment.start,
      segmentEnd: segment.end,
    })
  }

  const avgOverlapRatio = ratios.length > 0
    ? Math.round((ratios.reduce((a, b) => a + b, 0) / ratios.length) * 1000) / 1000
    : null

  return {
    totalSegments: ratios.length,
    avgOverlapRatio,
    observations,
  }
}
