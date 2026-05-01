import type { CorrectedSegmentLite } from './correct'
import type { JaBlock } from './blockTypes'
import { normalizeSpaces, splitJaIntoSentences } from './textUtils'
import type { WordTimestamp } from './types'

function normalizeTimingText(text: string): string {
  return normalizeSpaces(text).replace(/[。、「」『』（）()［］\[\]！？!?・,，、.\s]/g, '')
}

function sliceWordsByCharWeight(
  words: WordTimestamp[],
  sentenceCharCounts: number[],
  sentenceIndex: number,
): WordTimestamp[] {
  if (words.length === 0) return []
  if (sentenceCharCounts.length === 0) return words

  const totalChars = sentenceCharCounts.reduce((sum, count) => sum + Math.max(1, count), 0)
  const startWeight = sentenceCharCounts
    .slice(0, sentenceIndex)
    .reduce((sum, count) => sum + Math.max(1, count), 0)
  const endWeight = sentenceCharCounts
    .slice(0, sentenceIndex + 1)
    .reduce((sum, count) => sum + Math.max(1, count), 0)

  const start = Math.floor((words.length * startWeight) / Math.max(1, totalChars))
  const end =
    sentenceIndex === sentenceCharCounts.length - 1
      ? words.length
      : Math.floor((words.length * endWeight) / Math.max(1, totalChars))
  return words.slice(start, Math.max(start + 1, end))
}

export function splitJa(segments: CorrectedSegmentLite[]): JaBlock[] {
  const blocks: JaBlock[] = []
  let nextId = 1

  for (const segment of segments) {
    const jaText = normalizeSpaces(segment.correctedText || segment.text || '')
    if (!jaText) continue

    const sentences = splitJaIntoSentences(jaText)
    const duration = Math.max(0.1, segment.end - segment.start)
    const segmentWords = Array.isArray(segment.words) ? segment.words.filter(Boolean) : []
    const sentenceCharCounts = sentences.map((sentence) => normalizeTimingText(sentence).length)
    const totalSentenceChars = sentenceCharCounts.reduce((sum, count) => sum + Math.max(1, count), 0)
    let cursor = segment.start

    sentences.forEach((sentence, index) => {
      const trimmed = normalizeSpaces(sentence)
      if (!trimmed) return

      const ratio = Math.max(1, sentenceCharCounts[index] ?? 0) / Math.max(1, totalSentenceChars)
      const proportionalStart = index === 0 ? segment.start : cursor
      const proportionalEnd =
        index === sentences.length - 1
          ? segment.end
          : Math.min(segment.end, proportionalStart + duration * ratio)

      const words = sliceWordsByCharWeight(segmentWords, sentenceCharCounts, index)
      const start = words.length > 0 ? words[0].start : proportionalStart
      const end = words.length > 0 ? words[words.length - 1].end : proportionalEnd

      blocks.push({
        id: nextId++,
        start,
        end: Math.max(start + 0.05, end),
        jaText: trimmed,
        jaChars: trimmed.replace(/\s/g, '').length,
        alignConf: words.length > 0 ? 'exact' : 'proportional',
        words,
      })

      cursor = proportionalEnd
    })
  }

  return blocks
}
