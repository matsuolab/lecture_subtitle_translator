/**
 * splitJa ノード。
 * 補正済み日本語テキストを文単位に分割し、WhisperX 単語タイムスタンプで
 * 各文の start/end を確定する（#32 日本語サイドアライメント）。
 *
 * LLM 不使用。純粋 TypeScript。
 * retry 時は splitHints を受け取り、該当時間範囲の文を句読点でさらに細分化する。
 */

import type { NodeContract, NodeContext } from '../nodeContract'
import type {
  CorrectedSegment,
  JapaneseSentenceBlock,
  SplitHint,
} from '../types'
import { findTimeRangeSequential } from '../utils/diffAlign'
import type { WordTimestampFlat } from '../utils/diffAlign'

export interface SplitJaInput {
  readonly correctedSegments: readonly CorrectedSegment[]
  readonly splitHints: readonly SplitHint[]
  readonly attempt: number
}

const SENTENCE_END_RE = /(?<=[。！？\n])/
const CLAUSE_RE = /(?<=[、])/

function flattenWords(segments: readonly CorrectedSegment[]): readonly WordTimestampFlat[] {
  return segments.flatMap(seg =>
    seg.original.words.map(w => ({ word: w.word, start: w.start, end: w.end }))
  )
}

/**
 * セグメント内の CorrectedSegment.original.words を WordTimestampFlat[] に変換する。
 */
function segmentWords(seg: CorrectedSegment): readonly WordTimestampFlat[] {
  return seg.original.words
    .filter(w => w.start !== undefined && w.end !== undefined)
    .map(w => ({ word: w.word, start: w.start, end: w.end }))
}

/**
 * セグメントTSを基準として JapaneseSentenceBlock[] を構築する。
 *
 * 設計方針:
 *   各 CorrectedSegment を独立して処理する。
 *   - 1文のみ → WhisperXセグメントTS（start/end）をそのまま使用（exact）
 *   - 複数文 → そのセグメントの word TS のみで局所アライメント
 *              マッチ失敗 → そのセグメントの時間窓内で均等配分（proportional）
 *
 * グローバル結合を廃止することで:
 *   - fallback 時のTS範囲がセグメント幅に収まる（パイルアップ不可能）
 *   - 他セグメントの単語に誤マッチする問題を排除
 *   - 1文=1セグメントの大半のケースでセグメントTSをそのまま利用できる
 */
function buildPrimaryBlocks(
  correctedSegments: readonly CorrectedSegment[],
  attempt: number,
): readonly JapaneseSentenceBlock[] {
  const blocks: JapaneseSentenceBlock[] = []
  let idCounter = 1

  for (const seg of correctedSegments) {
    const sentences = seg.correctedText.split(SENTENCE_END_RE).map(s => s.trim()).filter(Boolean)
    if (sentences.length === 0) continue

    if (sentences.length === 1) {
      // 分割不要 → WhisperXセグメントTSを直接使用
      const id = idCounter++
      blocks.push({
        id,
        start: seg.original.start,
        end: seg.original.end,
        jaText: sentences[0],
        sourceSegmentIds: [seg.original.id],
        alignConfidence: 'exact',
        attempt,
        blockKey: `a${attempt}s${id}`,
      })
      continue
    }

    // 複数文 → このセグメントの word TS のみで局所アライメント
    const words = segmentWords(seg)
    let searchFrom = 0

    for (let j = 0; j < sentences.length; j++) {
      const jaText = sentences[j]
      const range = words.length > 0
        ? findTimeRangeSequential(jaText, words, searchFrom)
        : null

      const id = idCounter++
      const blockKey = `a${attempt}s${id}`
      const segDur = seg.original.end - seg.original.start

      if (range !== null) {
        searchFrom = range.nextSearchFrom
        blocks.push({
          id,
          start: range.start,
          end: range.end,
          jaText,
          sourceSegmentIds: [seg.original.id],
          alignConfidence: 'exact',
          attempt,
          blockKey,
        })
      } else {
        // fallback: このセグメントの時間窓内で均等配分
        blocks.push({
          id,
          start: seg.original.start + segDur * (j / sentences.length),
          end: seg.original.start + segDur * ((j + 1) / sentences.length),
          jaText,
          sourceSegmentIds: [seg.original.id],
          alignConfidence: 'proportional',
          attempt,
          blockKey,
        })
      }
    }
  }

  return blocks
}

/**
 * SplitHint が指定した時間範囲と重なるブロックを句読点（、）でさらに細分化する。
 * CPS 違反のロールバック retry 用。
 */
function refineWithHints(
  blocks: readonly JapaneseSentenceBlock[],
  hints: readonly SplitHint[],
  allWords: readonly WordTimestampFlat[],
  attempt: number,
): readonly JapaneseSentenceBlock[] {
  let idCounter = 1
  const result: JapaneseSentenceBlock[] = []

  for (const block of blocks) {
    const isHinted = hints.some(h => block.start < h.end && block.end > h.start)

    if (!isHinted) {
      const id = idCounter++
      result.push({ ...block, id, blockKey: `a${attempt}s${id}` })
      continue
    }

    const subSentences = block.jaText.split(CLAUSE_RE).map(s => s.trim()).filter(Boolean)
    if (subSentences.length <= 1) {
      const id = idCounter++
      result.push({ ...block, id, blockKey: `a${attempt}s${id}` })
      continue
    }

    // ブロックの時間窓内の単語だけで再アライメント
    const blockWords = allWords.filter(
      w => w.start >= block.start - 0.05 && w.end <= block.end + 0.05
    )
    let subSearch = 0

    for (let j = 0; j < subSentences.length; j++) {
      const jaText = subSentences[j]
      const range = findTimeRangeSequential(jaText, blockWords, subSearch)
      const id = idCounter++
      const blockKey = `a${attempt}s${id}`

      if (range !== null) {
        subSearch = range.nextSearchFrom
        result.push({
          id,
          start: range.start,
          end: range.end,
          jaText,
          sourceSegmentIds: block.sourceSegmentIds,
          alignConfidence: 'exact',
          attempt,
          parentBlockId: block.id,
          blockKey,
        })
      } else {
        const ratio = j / subSentences.length
        const blockDur = block.end - block.start
        result.push({
          id,
          start: block.start + blockDur * ratio,
          end: block.start + blockDur * ((j + 1) / subSentences.length),
          jaText,
          sourceSegmentIds: block.sourceSegmentIds,
          alignConfidence: 'proportional',
          attempt,
          parentBlockId: block.id,
          blockKey,
        })
      }
    }
  }

  return result
}

export const splitJaNode: NodeContract<SplitJaInput, readonly JapaneseSentenceBlock[]> = {
  id: 'splitJa',
  schemaVersion: '1.0',

  async run(input: SplitJaInput, ctx: NodeContext): Promise<readonly JapaneseSentenceBlock[]> {
    const { correctedSegments, splitHints, attempt } = input
    ctx.onProgress('splitJa: 日本語文分割中...')

    const primaryBlocks = buildPrimaryBlocks(correctedSegments, attempt)

    if (splitHints.length === 0) return primaryBlocks

    // refineWithHints は時間窓フィルタで自動的に該当セグメントの単語のみ使うため
    // 全単語のフラットリストを渡す（内部で block.start/end に絞り込まれる）
    const allWords = flattenWords(correctedSegments)
    return refineWithHints(primaryBlocks, splitHints, allWords, attempt)
  },
}
