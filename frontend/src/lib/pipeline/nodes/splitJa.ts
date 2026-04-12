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
 * 各文が correctedSegments のどのセグメント ID に由来するかを文字位置で計算する。
 * 文が複数セグメントにまたがる場合は両方の ID を含む。
 */
function computeSourceSegmentIds(
  sentences: readonly string[],
  fullText: string,
  correctedSegments: readonly CorrectedSegment[],
): readonly (readonly number[])[] {
  let offset = 0
  const segRanges = correctedSegments.map(seg => {
    const charStart = offset
    offset += seg.correctedText.length
    return { id: seg.original.id, charStart, charEnd: offset }
  })

  let searchFrom = 0
  return sentences.map(sentence => {
    const pos = fullText.indexOf(sentence, searchFrom)
    if (pos === -1) return []
    const sentEnd = pos + sentence.length
    searchFrom = sentEnd
    return segRanges
      .filter(s => s.charStart < sentEnd && s.charEnd > pos)
      .map(s => s.id)
  })
}

/**
 * correctedSegments の id → 時間範囲のルックアップマップを構築する。
 * フォールバック時に文字位置から割り出したセグメント時間を使うために利用。
 */
function buildSegTimeMap(
  correctedSegments: readonly CorrectedSegment[],
): Map<number, { start: number; end: number }> {
  return new Map(
    correctedSegments.map(seg => [
      seg.original.id,
      { start: seg.original.start, end: seg.original.end },
    ])
  )
}

function assignTimestamps(
  sentences: readonly string[],
  sourceSegmentIdsPerSentence: readonly (readonly number[])[],
  correctedSegments: readonly CorrectedSegment[],
  allWords: readonly WordTimestampFlat[],
  totalDuration: number,
  attempt: number,
): readonly JapaneseSentenceBlock[] {
  let searchFrom = 0
  const segTimeMap = buildSegTimeMap(correctedSegments)

  return sentences.map((jaText, i) => {
    const range =
      allWords.length > 0
        ? findTimeRangeSequential(jaText, allWords, searchFrom)
        : null

    const id = i + 1
    const blockKey = `a${attempt}s${id}`
    const sourceSegmentIds = sourceSegmentIdsPerSentence[i] ?? []

    if (range !== null) {
      searchFrom = range.nextSearchFrom
      return {
        id,
        start: range.start,
        end: range.end,
        jaText,
        sourceSegmentIds,
        alignConfidence: 'exact' as const,
        attempt,
        blockKey,
      }
    }

    // フォールバック: sourceSegmentIds からセグメント時間範囲を取得して比例配分
    // → lastKnownEnd の連鎖を廃止し、動画末尾へのパイルアップを防ぐ
    const segRanges = sourceSegmentIds
      .map(sid => segTimeMap.get(sid))
      .filter((r): r is { start: number; end: number } => r != null)
    const fallbackStart = segRanges.length > 0
      ? Math.min(...segRanges.map(r => r.start))
      : (i / Math.max(1, sentences.length)) * totalDuration
    const fallbackEnd = segRanges.length > 0
      ? Math.max(...segRanges.map(r => r.end))
      : ((i + 1) / Math.max(1, sentences.length)) * totalDuration

    return {
      id,
      start: fallbackStart,
      end: Math.max(fallbackStart, fallbackEnd),
      jaText,
      sourceSegmentIds,
      alignConfidence: 'proportional' as const,
      attempt,
      blockKey,
    }
  })
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

    const allWords = flattenWords(correctedSegments)
    const fullText = correctedSegments.map(s => s.correctedText).join('')
    const totalDuration =
      correctedSegments.length > 0
        ? correctedSegments[correctedSegments.length - 1].original.end
        : 0

    const sentences = fullText.split(SENTENCE_END_RE).map(s => s.trim()).filter(Boolean)
    const sourceSegmentIdsPerSentence = computeSourceSegmentIds(sentences, fullText, correctedSegments)
    const primaryBlocks = assignTimestamps(sentences, sourceSegmentIdsPerSentence, correctedSegments, allWords, totalDuration, attempt)

    if (splitHints.length === 0) return primaryBlocks

    return refineWithHints(primaryBlocks, splitHints, allWords, attempt)
  },
}
