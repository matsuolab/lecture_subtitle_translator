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

  const isLast = sentenceIndex === sentenceCharCounts.length - 1

  const totalSentenceChars = sentenceCharCounts.reduce((sum, count) => sum + Math.max(1, count), 0)
  const charsBefore = sentenceCharCounts
    .slice(0, sentenceIndex)
    .reduce((sum, count) => sum + Math.max(1, count), 0)
  const charsUpTo = sentenceCharCounts
    .slice(0, sentenceIndex + 1)
    .reduce((sum, count) => sum + Math.max(1, count), 0)

  // 各単語オブジェクトの実際の文字数を使って累積カウントを構築する。
  // 旧実装は words.length を文字数比率で割っていたが、日本語では1単語オブジェクトが
  // 複数文字を含む場合があり、均等割りだとタイムスタンプが前後のブロックにずれる。
  const wordNormChars = words.map((w) => Math.max(1, normalizeTimingText(String(w.word ?? '')).length))
  const totalWordChars = wordNormChars.reduce((sum, c) => sum + c, 0)

  const targetStart = (charsBefore / totalSentenceChars) * totalWordChars
  const targetEnd = (charsUpTo / totalSentenceChars) * totalWordChars

  let cum = 0
  const cumChars = wordNormChars.map((c) => { cum += c; return cum })

  const startIdx = sentenceIndex === 0
    ? 0
    : Math.max(0, cumChars.findIndex((c) => c > targetStart))

  if (isLast) {
    return words.slice(startIdx)
  }

  const endIdxRaw = cumChars.findIndex((c) => c >= targetEnd)
  const endIdx = endIdxRaw < 0 ? words.length : endIdxRaw + 1

  return words.slice(startIdx, Math.max(startIdx + 1, endIdx))
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
