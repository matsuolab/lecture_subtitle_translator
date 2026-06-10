import type { AdminSettings } from '@/types/adminSettings'
import type { JaBlock, PipelineThresholds } from './blockTypes'
import type { CorrectedSegmentLite } from './correct'
import type { WordTimestamp } from './types'
import { normalizeSpaces } from './textUtils'
import {
  requireChatModelForProvider,
  resolveAiProvider,
  resolveChatCompletionTokenLimitForProvider,
} from './aiProvider'
import { resolveSplitJaModelId } from './prompts'
import { loadLanguageProfileConfig, type LanguageProfileConfig } from './languageProfileConfig'
import { parseJsonObjectFromLlmContent } from './jsonResponse'
import { mapWithConcurrency, normalizeConcurrency } from '@/lib/concurrency'
import { llmCallWithMeta } from './llmCallWithMeta'

const MAX_SEGMENTS_PER_REQUEST = 4
const LOCAL_MAX_SEGMENTS_PER_REQUEST = 2

interface RawSemanticUnit {
  unitId: string
  sourceSegmentId: number
  jaText: string
  canMergeWithNext: boolean
}

interface AlignedUnit {
  unit: RawSemanticUnit
  start: number
  end: number
  alignConf: 'exact' | 'proportional' | 'no_words'
  words: WordTimestamp[]
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}

function normalizeTimingText(text: string): string {
  return normalizeSpaces(text).replace(/[。、「」『』（）()［］\[\]！？!?・,，、.\s]/g, '')
}

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

function findBoundaryWordIndex(
  wordNormTexts: string[],
  wordConcat: string,
  pieceNormText: string,
  searchAfterWordIdx: number,
): number | null {
  const prefix = pieceNormText.substring(0, Math.min(6, pieceNormText.length))
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
  pieceCharCounts: number[],
  pieceIndex: number,
  totalPieceChars: number,
): number {
  const charsBefore = pieceCharCounts.slice(0, pieceIndex).reduce((sum, count) => sum + Math.max(1, count), 0)
  const targetChars = (charsBefore / Math.max(1, totalPieceChars)) * totalWordChars
  let cum = 0
  for (let index = 0; index < wordNormChars.length; index += 1) {
    if (cum > targetChars) return index
    cum += wordNormChars[index]
  }
  return wordNormChars.length
}

function noBreakRanges(text: string, glossaryTerms: string[]): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = []
  const terms = [...new Set(glossaryTerms.map(term => term.trim()).filter(term => term.length >= 2))]
    .sort((a, b) => b.length - a.length)
  for (const term of terms) {
    let index = text.indexOf(term)
    while (index >= 0) {
      ranges.push({ start: index, end: index + term.length })
      index = text.indexOf(term, index + Math.max(1, term.length))
    }
  }
  return ranges
}

function isKatakana(char: string): boolean {
  return /^[ァ-ヴー]$/.test(char)
}

function isAsciiWord(char: string): boolean {
  return /^[A-Za-z0-9_+-]$/.test(char)
}

function isUnsafeSplit(text: string, index: number, ranges: Array<{ start: number; end: number }>): boolean {
  if (index <= 0 || index >= text.length) return true
  if (ranges.some(range => index > range.start && index < range.end)) return true
  const prev = text[index - 1] ?? ''
  const next = text[index] ?? ''
  return (isKatakana(prev) && isKatakana(next)) || (isAsciiWord(prev) && isAsciiWord(next))
}

function chooseSafeSplitIndex(text: string, preferred: number, glossaryTerms: string[]): number {
  const min = Math.max(1, Math.floor(text.length * 0.25))
  const max = Math.min(text.length - 1, Math.ceil(text.length * 0.75))
  const ranges = noBreakRanges(text, glossaryTerms)
  const punctuation = ['。', '、', '，', '．', '！', '？']
  let best = -1
  let bestDistance = Number.POSITIVE_INFINITY
  for (let index = min; index <= max; index += 1) {
    if (isUnsafeSplit(text, index, ranges)) continue
    const prev = text[index - 1] ?? ''
    const distance = Math.abs(index - preferred) + (punctuation.includes(prev) ? -1000 : 0)
    if (distance < bestDistance) {
      best = index
      bestDistance = distance
    }
  }
  if (best >= 0) return best
  return Math.max(1, Math.min(text.length - 1, preferred))
}

function splitOverlongUnit(unit: RawSemanticUnit, duration: number, maxDuration: number, glossaryTerms: string[]): RawSemanticUnit[] {
  if (duration <= maxDuration || unit.jaText.length < 16) return [unit]
  const parts = Math.ceil(duration / Math.max(1, maxDuration * 0.88))
  const groups = [unit.jaText]
  while (groups.length < parts) {
    let longestIndex = -1
    let longestLength = 0
    for (const [index, group] of groups.entries()) {
      if (group.length > longestLength) {
        longestIndex = index
        longestLength = group.length
      }
    }
    if (longestIndex < 0 || longestLength < 16) break
    const group = groups[longestIndex]
    const splitAt = chooseSafeSplitIndex(group, Math.floor(group.length / 2), glossaryTerms)
    groups.splice(longestIndex, 1, group.slice(0, splitAt), group.slice(splitAt))
  }
  if (groups.length <= 1) return [unit]
  return groups.map((group, index) => ({
    ...unit,
    unitId: `${unit.unitId}_${index + 1}`,
    jaText: group,
    canMergeWithNext: index < groups.length - 1 || unit.canMergeWithNext,
  }))
}

function alignUnitsOnce(segment: CorrectedSegmentLite, units: RawSemanticUnit[]): AlignedUnit[] {
  const words = (segment.words ?? [])
    .filter(word => Number.isFinite(word.start) && Number.isFinite(word.end))
    .sort((a, b) => a.start - b.start || a.end - b.end)
  const segmentDuration = Math.max(0.001, segment.end - segment.start)
  const pieceCharCounts = units.map(unit => normalizeTimingText(unit.jaText).length)
  const totalPieceChars = pieceCharCounts.reduce((sum, count) => sum + Math.max(1, count), 0)

  if (words.length === 0) {
    let cursor = segment.start
    return units.map((unit, index) => {
      const isLast = index === units.length - 1
      const end = isLast
        ? segment.end
        : Math.min(segment.end, cursor + segmentDuration * (Math.max(1, pieceCharCounts[index]) / Math.max(1, totalPieceChars)))
      const aligned: AlignedUnit = {
        unit,
        start: round(cursor),
        end: round(Math.max(cursor + 0.05, end)),
        alignConf: 'no_words',
        words: [],
      }
      cursor = end
      return aligned
    })
  }

  const wordNormTexts = words.map(word => normalizeTimingText(String(word.word ?? '')))
  const wordConcat = wordNormTexts.join('')
  const wordNormChars = wordNormTexts.map(text => Math.max(1, text.length))
  const totalWordChars = wordNormChars.reduce((sum, count) => sum + count, 0)
  const startWordIndexes: number[] = new Array(units.length).fill(0)
  const exactBoundary: boolean[] = new Array(units.length).fill(true)

  for (let index = 1; index < units.length; index += 1) {
    const previous = startWordIndexes[index - 1]
    const matched = findBoundaryWordIndex(wordNormTexts, wordConcat, normalizeTimingText(units[index].jaText), previous)
    if (matched !== null && matched > previous) {
      startWordIndexes[index] = matched
      continue
    }
    const fallback = charProportionalWordIndex(wordNormChars, totalWordChars, pieceCharCounts, index, totalPieceChars)
    startWordIndexes[index] = Math.min(Math.max(previous + 1, fallback), words.length - 1)
    exactBoundary[index] = false
  }

  return units.map((unit, index) => {
    const wordStart = startWordIndexes[index]
    const wordEnd = index < units.length - 1 ? startWordIndexes[index + 1] : words.length
    const slicedWords = words.slice(wordStart, wordEnd)
    const charsBefore = pieceCharCounts.slice(0, index).reduce((sum, count) => sum + Math.max(1, count), 0)
    const charsUpTo = pieceCharCounts.slice(0, index + 1).reduce((sum, count) => sum + Math.max(1, count), 0)
    const propStart = index === 0 ? segment.start : segment.start + segmentDuration * (charsBefore / Math.max(1, totalPieceChars))
    const propEnd = index === units.length - 1 ? segment.end : segment.start + segmentDuration * (charsUpTo / Math.max(1, totalPieceChars))
    const hasWordTime = slicedWords.length > 0 && Number.isFinite(slicedWords[0].start) && Number.isFinite(slicedWords[slicedWords.length - 1].end)
    const start = hasWordTime ? slicedWords[0].start : propStart
    const end = hasWordTime ? slicedWords[slicedWords.length - 1].end : propEnd
    const endExact = index === units.length - 1 || exactBoundary[index + 1]
    return {
      unit,
      start: round(start),
      end: round(Math.max(start + 0.05, end)),
      alignConf: hasWordTime && exactBoundary[index] && endExact ? 'exact' : 'proportional',
      words: slicedWords,
    }
  })
}

function alignUnits(segment: CorrectedSegmentLite, rawUnits: RawSemanticUnit[], thresholds: PipelineThresholds, glossaryTerms: string[]): AlignedUnit[] {
  let units = rawUnits
  let aligned = alignUnitsOnce(segment, units)
  for (let loop = 0; loop < 8; loop += 1) {
    const overlongIndex = aligned.findIndex(unit => unit.end - unit.start > thresholds.mergedLongDurationSec)
    if (overlongIndex < 0) break
    const overlong = aligned[overlongIndex]
    const split = splitOverlongUnit(overlong.unit, overlong.end - overlong.start, thresholds.mergedLongDurationSec, glossaryTerms)
    if (split.length <= 1) break
    units = [...units.slice(0, overlongIndex), ...split, ...units.slice(overlongIndex + 1)]
    aligned = alignUnitsOnce(segment, units)
  }
  return aligned
}

function parseUnits(payload: Record<string, unknown>): RawSemanticUnit[] {
  const raw = Array.isArray(payload.semantic_units) ? payload.semantic_units : []
  return raw.flatMap((item, index) => {
    if (!item || typeof item !== 'object') return []
    const row = item as Record<string, unknown>
    const sourceSegmentId = Number(row.source_segment_id)
    const jaText = typeof row.ja_text === 'string' ? normalizeSpaces(row.ja_text) : ''
    if (!Number.isFinite(sourceSegmentId) || !jaText) return []
    return [{
      unitId: typeof row.unit_id === 'string' && row.unit_id ? row.unit_id.replace(/[^a-zA-Z0-9_-]/g, '_') : `u${index + 1}`,
      sourceSegmentId,
      jaText,
      canMergeWithNext: row.can_merge_with_next === true,
    }]
  })
}

/**
 * 各セグメントの LLM 分割カバレッジを計算。0.9 未満のセグメント ID を返す（呼出元が原文 fallback）。
 */
function findUndercoveredSegments(segments: CorrectedSegmentLite[], units: RawSemanticUnit[]): Set<number> {
  const unitsBySegment = new Map<number, RawSemanticUnit[]>()
  for (const unit of units) {
    const list = unitsBySegment.get(unit.sourceSegmentId) ?? []
    list.push(unit)
    unitsBySegment.set(unit.sourceSegmentId, list)
  }
  const undercovered = new Set<number>()
  for (const segment of segments) {
    const source = normalizeTimingText(segment.correctedText || segment.text)
    if (source.length < 20) continue
    const planned = normalizeTimingText((unitsBySegment.get(segment.id) ?? []).map(unit => unit.jaText).join(''))
    const ratio = lcsLength(source, planned) / Math.max(1, source.length)
    if (ratio < 0.9) undercovered.add(segment.id)
  }
  return undercovered
}

// transcript（元言語）が日本語スクリプトのときだけ、カタカナ保持ルールと日本語の例示を含める。
// 既定構成（transcript=Japanese）では従来のハードコード文字列とバイト一致する。
function buildSemanticSplitPrompt(segments: CorrectedSegmentLite[], languages: LanguageProfileConfig): string {
  const transcriptLabel = languages.transcript.label
  const transcriptIsJapanese = languages.transcript.script === 'japanese'
  const rules = [
    'Output JSON only.',
    'Preserve all source meaning and wording. Do not summarize, omit, add, or translate.',
    `Each unit should be a natural ${transcriptLabel} phrase/sentence suitable for grouping into subtitle cues.`,
    `Avoid single-word units, filler-only units, and fragments that start/end in the middle of a ${transcriptLabel} phrase.`,
    ...(transcriptIsJapanese ? ['Keep technical terms and katakana words intact.'] : ['Keep technical terms intact.']),
  ]
  return JSON.stringify({
    task: `Split corrected ${transcriptLabel} lecture transcript into subtitle-ready semantic units. Do not translate. Do not create timestamps.`,
    rules,
    segments: segments.map(segment => ({
      id: segment.id,
      start: segment.start,
      end: segment.end,
      ja_text: segment.correctedText || segment.text,
    })),
    output_schema: {
      semantic_units: [{
        unit_id: 'u001',
        source_segment_id: 1,
        ja_text: transcriptIsJapanese ? '自然な日本語の意味単位' : `a natural ${transcriptLabel} semantic unit`,
        semantic_role: 'topic|reason|consequence|example|contrast|detail|transition|summary',
        can_merge_with_next: true,
      }],
    },
  })
}

interface SemanticSplitBatchResult {
  units: RawSemanticUnit[]
  /** カバレッジ < 0.9 のセグメント ID（原文 fallback 対象）。失敗 batch では全 segment.id が入る。*/
  undercoveredSegmentIds: Set<number>
  errorMessage?: string
}

async function callSemanticSplitApi(
  segments: CorrectedSegmentLite[],
  settings: AdminSettings,
): Promise<SemanticSplitBatchResult> {
  const model = requireChatModelForProvider(settings, resolveSplitJaModelId(settings), 'semantic subtitle splitting')
  const languages = loadLanguageProfileConfig(settings)
  const tokenLimit = resolveChatCompletionTokenLimitForProvider(settings, 6000) as Record<string, unknown>
  // tokenLimit は { max_tokens: N } | { max_completion_tokens: N } 等を返すので両方を確認
  const maxTokens = typeof tokenLimit.max_tokens === 'number'
    ? tokenLimit.max_tokens
    : typeof tokenLimit.max_completion_tokens === 'number'
      ? tokenLimit.max_completion_tokens
      : undefined

  const callResult = await llmCallWithMeta(
    {
      model,
      systemPrompt: `You split ${languages.transcript.label} academic lecture transcripts into subtitle-ready semantic units. Return JSON only.`,
      userContent: buildSemanticSplitPrompt(segments, languages),
      temperature: 0.1,
      maxTokens,
      nodeName: 'semantic_split_ja',
    },
    settings,
  )

  if (callResult.errorMessage) {
    return {
      units: [],
      undercoveredSegmentIds: new Set(segments.map(s => s.id)),
      errorMessage: callResult.errorMessage,
    }
  }

  let parsed: Record<string, unknown>
  try {
    parsed = parseJsonObjectFromLlmContent(callResult.content, 'semantic split')
  } catch (error) {
    return {
      units: [],
      undercoveredSegmentIds: new Set(segments.map(s => s.id)),
      errorMessage: `parse_failed: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  const units = parseUnits(parsed)
  return {
    units,
    undercoveredSegmentIds: findUndercoveredSegments(segments, units),
  }
}

export async function semanticSplitJa(
  segments: CorrectedSegmentLite[],
  settings: AdminSettings,
  thresholds: PipelineThresholds,
  glossaryTerms: string[] = [],
): Promise<JaBlock[]> {
  const maxSegmentsPerRequest = resolveAiProvider(settings) === 'local_openai'
    ? LOCAL_MAX_SEGMENTS_PER_REQUEST
    : MAX_SEGMENTS_PER_REQUEST
  const batches: CorrectedSegmentLite[][] = []
  for (let index = 0; index < segments.length; index += maxSegmentsPerRequest) {
    batches.push(segments.slice(index, index + maxSegmentsPerRequest))
  }
  const requestConcurrency = normalizeConcurrency(settings.apiRequestConcurrency, 1)
  const batchResults = await mapWithConcurrency(
    batches.length,
    requestConcurrency,
    index => callSemanticSplitApi(batches[index], settings),
  )
  const allUnits = batchResults.flatMap(r => r.units)
  const undercovered = new Set<number>()
  for (const r of batchResults) {
    for (const id of r.undercoveredSegmentIds) undercovered.add(id)
  }
  const unitsBySegment = new Map<number, RawSemanticUnit[]>()
  for (const unit of allUnits) {
    const list = unitsBySegment.get(unit.sourceSegmentId) ?? []
    list.push(unit)
    unitsBySegment.set(unit.sourceSegmentId, list)
  }

  const blocks: JaBlock[] = []
  let nextId = 1
  for (const segment of segments) {
    let segmentUnits = unitsBySegment.get(segment.id) ?? []
    // LLM 失敗 or カバレッジ不足 → 原文をそのまま 1 ユニットとして fallback
    if (segmentUnits.length === 0 || undercovered.has(segment.id)) {
      const fallbackText = normalizeSpaces(segment.correctedText || segment.text)
      if (!fallbackText) continue
      segmentUnits = [{
        unitId: `u_fallback_${segment.id}`,
        sourceSegmentId: segment.id,
        jaText: fallbackText,
        canMergeWithNext: false,
      }]
    }
    for (const aligned of alignUnits(segment, segmentUnits, thresholds, glossaryTerms)) {
      const jaText = normalizeSpaces(aligned.unit.jaText)
      if (!jaText) continue
      blocks.push({
        id: nextId,
        start: aligned.start,
        end: aligned.end,
        jaText,
        jaChars: jaText.replace(/\s/g, '').length,
        alignConf: aligned.alignConf,
        words: aligned.words,
      })
      nextId += 1
    }
  }
  return blocks
}

export const __testing = {
  buildSemanticSplitPrompt,
}
