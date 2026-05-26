import type { Constraints, CuePlan, FixtureChunk, FixtureSegment, WordTimestamp } from './schema.js'
import { normalizeSpaces } from './lineFormat.js'

export interface BaselineBlock {
  id: number
  start: number
  end: number
  jaText: string
  jaChars: number
  alignConf: 'exact' | 'proportional' | 'merged'
  words: WordTimestamp[]
  merged?: boolean
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}

function splitJaIntoSentences(text: string): string[] {
  const normalized = normalizeSpaces(text)
  if (!normalized) return []
  const sentences = normalized
    .split(/(?<=[。！？!?])/)
    .map((sentence) => normalizeSpaces(sentence))
    .filter(Boolean)
  return sentences.length > 0 ? sentences : [normalized]
}

function normalizeTimingText(text: string): string {
  return normalizeSpaces(text).replace(/[。、「」『』（）()［］\[\]！？!?・,，、.\s]/g, '')
}

function findBoundaryWordIndex(
  wordNormTexts: string[],
  wordConcat: string,
  sentenceNormText: string,
  searchAfterWordIdx: number,
): number | null {
  const prefix = sentenceNormText.substring(0, Math.min(6, sentenceNormText.length))
  if (!prefix) return null
  let afterCharPos = 0
  for (let i = 0; i < Math.min(searchAfterWordIdx, wordNormTexts.length); i += 1) {
    afterCharPos += wordNormTexts[i].length
  }
  const matchCharPos = wordConcat.indexOf(prefix, afterCharPos)
  if (matchCharPos === -1) return null
  let cum = 0
  for (let i = 0; i < wordNormTexts.length; i += 1) {
    if (cum + wordNormTexts[i].length > matchCharPos) return i
    cum += wordNormTexts[i].length
  }
  return null
}

function charProportionalWordIndex(
  wordNormChars: number[],
  totalWordChars: number,
  sentenceCharCounts: number[],
  sentenceIndex: number,
  totalSentenceChars: number,
): number {
  const charsBefore = sentenceCharCounts
    .slice(0, sentenceIndex)
    .reduce((sum, count) => sum + Math.max(1, count), 0)
  const targetChars = (charsBefore / Math.max(1, totalSentenceChars)) * totalWordChars
  let cum = 0
  for (let index = 0; index < wordNormChars.length; index += 1) {
    if (cum > targetChars) return index
    cum += wordNormChars[index]
  }
  return wordNormChars.length
}

function splitSegment(segment: FixtureSegment, nextId: number): { blocks: BaselineBlock[]; nextId: number } {
  const jaText = normalizeSpaces(segment.ja_text)
  const sentences = splitJaIntoSentences(jaText)
  const blocks: BaselineBlock[] = []
  if (sentences.length === 0) return { blocks, nextId }

  const duration = Math.max(0.1, segment.end - segment.start)
  const segmentWords = Array.isArray(segment.words) ? segment.words.filter(Boolean) : []
  const sentenceCharCounts = sentences.map((sentence) => normalizeTimingText(sentence).length)
  const totalSentenceChars = sentenceCharCounts.reduce((sum, count) => sum + Math.max(1, count), 0)

  if (segmentWords.length === 0) {
    let cursor = segment.start
    sentences.forEach((sentence, index) => {
      const trimmed = normalizeSpaces(sentence)
      if (!trimmed) return
      const ratio = Math.max(1, sentenceCharCounts[index] ?? 0) / Math.max(1, totalSentenceChars)
      const start = index === 0 ? segment.start : cursor
      const end = index === sentences.length - 1 ? segment.end : Math.min(segment.end, start + duration * ratio)
      blocks.push({
        id: nextId,
        start: round(start),
        end: round(Math.max(start + 0.05, end)),
        jaText: trimmed,
        jaChars: trimmed.replace(/\s/g, '').length,
        alignConf: 'proportional',
        words: [],
      })
      nextId += 1
      cursor = end
    })
    return { blocks, nextId }
  }

  const wordNormTexts = segmentWords.map((word) => normalizeTimingText(String(word.word ?? '')))
  const wordConcat = wordNormTexts.join('')
  const wordNormChars = wordNormTexts.map((text) => Math.max(1, text.length))
  const totalWordChars = wordNormChars.reduce((sum, count) => sum + count, 0)
  const sentenceStartWordIdx: number[] = new Array(sentences.length).fill(0)

  for (let index = 1; index < sentences.length; index += 1) {
    const previousStart = sentenceStartWordIdx[index - 1]
    const sentenceNorm = normalizeTimingText(sentences[index])
    const matched = findBoundaryWordIndex(wordNormTexts, wordConcat, sentenceNorm, previousStart)
    if (matched !== null && matched > previousStart) {
      sentenceStartWordIdx[index] = matched
    } else {
      const fallback = charProportionalWordIndex(
        wordNormChars,
        totalWordChars,
        sentenceCharCounts,
        index,
        totalSentenceChars,
      )
      sentenceStartWordIdx[index] = Math.min(Math.max(previousStart + 1, fallback), segmentWords.length - 1)
    }
  }

  sentences.forEach((sentence, index) => {
    const trimmed = normalizeSpaces(sentence)
    if (!trimmed) return
    const wordStartIdx = sentenceStartWordIdx[index]
    const wordEndIdx = index < sentences.length - 1 ? sentenceStartWordIdx[index + 1] : segmentWords.length
    const slicedWords = segmentWords.slice(wordStartIdx, wordEndIdx)
    const charsBefore = sentenceCharCounts.slice(0, index).reduce((sum, count) => sum + Math.max(1, count), 0)
    const charsUpTo = sentenceCharCounts.slice(0, index + 1).reduce((sum, count) => sum + Math.max(1, count), 0)
    const propStart = index === 0
      ? segment.start
      : segment.start + duration * (charsBefore / Math.max(1, totalSentenceChars))
    const propEnd = index === sentences.length - 1
      ? segment.end
      : segment.start + duration * (charsUpTo / Math.max(1, totalSentenceChars))
    const start = slicedWords.length > 0 ? slicedWords[0].start : propStart
    const end = slicedWords.length > 0 ? slicedWords[slicedWords.length - 1].end : propEnd
    blocks.push({
      id: nextId,
      start: round(start),
      end: round(Math.max(start + 0.05, end)),
      jaText: trimmed,
      jaChars: trimmed.replace(/\s/g, '').length,
      alignConf: slicedWords.length > 0 ? 'exact' : 'proportional',
      words: slicedWords,
    })
    nextId += 1
  })

  return { blocks, nextId }
}

function mergePair(left: BaselineBlock, right: BaselineBlock): BaselineBlock {
  return {
    id: left.id,
    start: left.start,
    end: right.end,
    jaText: `${left.jaText} ${right.jaText}`.trim(),
    jaChars: left.jaChars + right.jaChars,
    alignConf: 'merged',
    words: [...(left.words ?? []), ...(right.words ?? [])],
    merged: true,
  }
}

function mergeShort(blocks: BaselineBlock[], shortDurationSec = 1.5): BaselineBlock[] {
  const merged: BaselineBlock[] = []
  for (const block of blocks) {
    const previous = merged.at(-1)
    if (!previous) {
      merged.push(block)
      continue
    }
    const duration = previous.end - previous.start
    if (duration < shortDurationSec) {
      merged[merged.length - 1] = mergePair(previous, block)
      continue
    }
    merged.push(block)
  }
  if (merged.length >= 2) {
    const last = merged.at(-1)
    if (last && last.end - last.start < shortDurationSec) {
      const beforeLast = merged[merged.length - 2]
      merged.splice(merged.length - 2, 2, mergePair(beforeLast, last))
    }
  }
  return merged
}

export function buildProductionBaselinePlan(chunk: FixtureChunk, _constraints: Constraints): { chunk_id: string; status: 'accepted'; cues: CuePlan[]; review_items: string[] } {
  let nextId = 1
  const blocks: BaselineBlock[] = []
  for (const segment of chunk.segments) {
    const result = splitSegment(segment, nextId)
    blocks.push(...result.blocks)
    nextId = result.nextId
  }
  const merged = mergeShort(blocks)
  return {
    chunk_id: chunk.chunk_id,
    status: 'accepted',
    review_items: [],
    cues: merged.map((block, index) => ({
      cue_id: `${chunk.chunk_id}_prod_${String(index + 1).padStart(3, '0')}`,
      start: block.start,
      end: block.end,
      ja_span: block.jaText,
      en: '',
      source_segment_ids: chunk.segments
        .filter((segment) => block.end > segment.start && block.start < segment.end)
        .map((segment) => segment.id),
      strategy: `production_copy:${block.alignConf}${block.merged ? ':merged' : ''}`,
    })),
  }
}
