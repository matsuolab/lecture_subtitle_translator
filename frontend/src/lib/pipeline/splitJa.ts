import type { CorrectedSegmentLite } from './correct'
import type { JaBlock } from './blockTypes'
import { normalizeSpaces, splitJaIntoSentences } from './textUtils'

function normalizeTimingText(text: string): string {
  return normalizeSpaces(text).replace(/[。、「」『』（）()［］\[\]！？!?・,，、.\s]/g, '')
}

/**
 * sentence の正規化テキスト先頭 N 文字が、wordConcat の searchAfterWordIdx 番目以降の
 * 単語から始まる位置を探し、その単語インデックスを返す。見つからなければ null。
 *
 * 優先1のロジック: whisperX の word タイムスタンプを直接使うための境界探索。
 * 短いプレフィックスほど誤マッチしやすい。6 文字程度が実用的な上限。
 */
function findBoundaryWordIndex(
  wordNormTexts: string[],
  wordConcat: string,
  sentenceNormText: string,
  searchAfterWordIdx: number,
): number | null {
  const prefix = sentenceNormText.substring(0, Math.min(6, sentenceNormText.length))
  if (!prefix) return null

  // searchAfterWordIdx 番目の単語が始まる文字位置を求める
  let afterCharPos = 0
  for (let i = 0; i < Math.min(searchAfterWordIdx, wordNormTexts.length); i++) {
    afterCharPos += wordNormTexts[i].length
  }

  const matchCharPos = wordConcat.indexOf(prefix, afterCharPos)
  if (matchCharPos === -1) return null

  // matchCharPos を含む単語インデックスを返す
  let cum = 0
  for (let i = 0; i < wordNormTexts.length; i++) {
    if (cum + wordNormTexts[i].length > matchCharPos) return i
    cum += wordNormTexts[i].length
  }
  return null
}

/**
 * 優先2のフォールバック: 文字数累積比率で境界単語インデックスを推定する。
 * whisperX の分かち書きと分割文章の文字数が一致しない場合の近似。
 */
function charProportionalWordIndex(
  wordNormChars: number[],
  totalWordChars: number,
  sentenceCharCounts: number[],
  sentenceIndex: number,
  totalSentenceChars: number,
): number {
  const charsBefore = sentenceCharCounts
    .slice(0, sentenceIndex)
    .reduce((s, c) => s + Math.max(1, c), 0)
  const targetChars = (charsBefore / Math.max(1, totalSentenceChars)) * totalWordChars

  let cum = 0
  for (let j = 0; j < wordNormChars.length; j++) {
    if (cum > targetChars) return j
    cum += wordNormChars[j]
  }
  return wordNormChars.length
}

export function splitJa(segments: CorrectedSegmentLite[]): JaBlock[] {
  const blocks: JaBlock[] = []
  let nextId = 1

  for (const segment of segments) {
    const jaText = normalizeSpaces(segment.correctedText || segment.text || '')
    if (!jaText) continue

    const sentences = splitJaIntoSentences(jaText)
    if (sentences.length === 0) continue

    const duration = Math.max(0.1, segment.end - segment.start)
    const segmentWords = Array.isArray(segment.words) ? segment.words.filter(Boolean) : []
    const sentenceCharCounts = sentences.map((s) => normalizeTimingText(s).length)
    const totalSentenceChars = sentenceCharCounts.reduce((s, c) => s + Math.max(1, c), 0)

    // words がない場合: 優先3（文字数比例による時間推定のみ）
    if (segmentWords.length === 0) {
      let cursor = segment.start
      sentences.forEach((sentence, index) => {
        const trimmed = normalizeSpaces(sentence)
        if (!trimmed) return
        const ratio = Math.max(1, sentenceCharCounts[index] ?? 0) / Math.max(1, totalSentenceChars)
        const start = index === 0 ? segment.start : cursor
        const end = index === sentences.length - 1
          ? segment.end
          : Math.min(segment.end, start + duration * ratio)
        blocks.push({
          id: nextId++,
          start,
          end: Math.max(start + 0.05, end),
          jaText: trimmed,
          jaChars: trimmed.replace(/\s/g, '').length,
          alignConf: 'proportional',
          words: [],
        })
        cursor = end
      })
      continue
    }

    // words がある場合: 各文の先頭単語インデックスを確定する
    const wordNormTexts = segmentWords.map((w) => normalizeTimingText(String(w.word ?? '')))
    const wordConcat = wordNormTexts.join('')
    const wordNormChars = wordNormTexts.map((t) => Math.max(1, t.length))
    const totalWordChars = wordNormChars.reduce((s, c) => s + c, 0)

    // sentence[i] の先頭単語インデックス
    const sentenceStartWordIdx: number[] = new Array(sentences.length).fill(0)

    for (let i = 1; i < sentences.length; i++) {
      const prevStartIdx = sentenceStartWordIdx[i - 1]
      const s2Norm = normalizeTimingText(sentences[i])

      // 優先1: テキストマッチングで sentence[i] の先頭を word 配列内で探す
      const matched = findBoundaryWordIndex(wordNormTexts, wordConcat, s2Norm, prevStartIdx)

      if (matched !== null && matched > prevStartIdx) {
        sentenceStartWordIdx[i] = matched
      } else {
        // 優先2: 文字数累積比例でフォールバック
        const fallback = charProportionalWordIndex(
          wordNormChars, totalWordChars, sentenceCharCounts, i, totalSentenceChars,
        )
        sentenceStartWordIdx[i] = Math.min(
          Math.max(prevStartIdx + 1, fallback),
          segmentWords.length - 1,
        )
      }
    }

    // 各文を JaBlock に変換
    sentences.forEach((sentence, index) => {
      const trimmed = normalizeSpaces(sentence)
      if (!trimmed) return

      const wordStartIdx = sentenceStartWordIdx[index]
      const wordEndIdx = index < sentences.length - 1
        ? sentenceStartWordIdx[index + 1]
        : segmentWords.length

      const slicedWords = segmentWords.slice(wordStartIdx, wordEndIdx)

      // 比例タイムスタンプ（slicedWords が空のときのフォールバック用）
      const charsBefore = sentenceCharCounts
        .slice(0, index)
        .reduce((s, c) => s + Math.max(1, c), 0)
      const charsUpTo = sentenceCharCounts
        .slice(0, index + 1)
        .reduce((s, c) => s + Math.max(1, c), 0)
      const propStart = index === 0
        ? segment.start
        : segment.start + duration * (charsBefore / Math.max(1, totalSentenceChars))
      const propEnd = index === sentences.length - 1
        ? segment.end
        : segment.start + duration * (charsUpTo / Math.max(1, totalSentenceChars))

      const start = slicedWords.length > 0 ? slicedWords[0].start : propStart
      const end = slicedWords.length > 0 ? slicedWords[slicedWords.length - 1].end : propEnd

      blocks.push({
        id: nextId++,
        start,
        end: Math.max(start + 0.05, end),
        jaText: trimmed,
        jaChars: trimmed.replace(/\s/g, '').length,
        alignConf: slicedWords.length > 0 ? 'exact' : 'proportional',
        words: slicedWords,
      })
    })
  }

  return blocks
}
