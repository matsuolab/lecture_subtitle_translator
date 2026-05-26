import type { CandidateCue, CandidateSplit, Constraints, CueCandidateStats, FixtureChunk, FixtureSegment, WordTimestamp } from './schema.js'
import { normalizeSpaces } from './lineFormat.js'
import { lengthTargets } from './lengthControl.js'
import { scoreCandidateSplit } from './candidateSplits.js'

interface SemanticUnit {
  unit_id: string
  source_segment_id: number
  ja_text: string
  semantic_role: string
  can_merge_with_next: boolean
  start: number
  end: number
  align_conf: 'exact' | 'proportional' | 'no_words'
  align_notes: string[]
}

type RawSemanticUnit = Omit<SemanticUnit, 'start' | 'end' | 'align_conf' | 'align_notes'>

interface AlignedPiece {
  unit: RawSemanticUnit
  start: number
  end: number
  align_conf: 'exact' | 'proportional' | 'no_words'
  align_notes: string[]
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    try {
      return JSON.parse(trimmed) as Record<string, unknown>
    } catch {
      const start = trimmed.indexOf('{')
      const end = trimmed.lastIndexOf('}')
      if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>
    }
  }
  if (value && typeof value === 'object') return value as Record<string, unknown>
  throw new Error('Cue structure output is not a JSON object.')
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function boolValue(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function numberValue(value: unknown, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function microCueRisk(duration: number, unitCount: number, jaChars: number): boolean {
  return duration < 1.5 || unitCount <= 0 || jaChars < 8
}

function normalizeTimingText(text: string): string {
  return normalizeSpaces(text).replace(/[。、「」『』（）()［］\[\]！？!?・,，、.\s]/g, '')
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

export function buildCueStructureInput(chunk: FixtureChunk, constraints: Constraints): string {
  return JSON.stringify({
    task: 'Split corrected Japanese transcript into natural semantic units. Do not translate and do not create timestamps.',
    chunk_id: chunk.chunk_id,
    constraints,
    segmentation_policy: {
      preserve_meaning: 'Keep corrected Japanese semantic chunks intact. Split only at natural Japanese meaning boundaries.',
      avoid: 'single words, partial clauses, token fragments, filler-only units, or units that start/end in the middle of a Japanese phrase',
      prefer: 'complete phrase-level or sentence-level thoughts that can be grouped into subtitle cues up to 7 seconds',
    },
    segments: chunk.segments.map((segment) => ({
      id: segment.id,
      start: segment.start,
      end: segment.end,
      ja_text: segment.ja_text,
    })),
    output_schema: {
      semantic_units: [{
        unit_id: 'u001',
        source_segment_id: 131,
        ja_text: '自然な日本語の意味単位',
        semantic_role: 'topic|reason|consequence|example|contrast|detail|transition|summary',
        can_merge_with_next: true,
      }],
    },
  })
}

function splitJapaneseClauses(text: string): string[] {
  const clauses = text
    .split(/(?<=[。！？、])/)
    .map((part) => part.trim())
    .filter(Boolean)
  return clauses.length > 1 ? clauses : [text]
}

function noBreakRanges(text: string, glossaryTerms: string[]): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = []
  const terms = [...new Set(glossaryTerms.map((term) => term.trim()).filter((term) => term.length >= 2))]
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

function isInsideNoBreakRange(index: number, ranges: Array<{ start: number; end: number }>): boolean {
  return ranges.some((range) => index > range.start && index < range.end)
}

function isUnsafeSplit(text: string, index: number, ranges: Array<{ start: number; end: number }>): boolean {
  if (index <= 0 || index >= text.length) return true
  if (isInsideNoBreakRange(index, ranges)) return true
  const prev = text[index - 1] ?? ''
  const next = text[index] ?? ''
  if (isKatakana(prev) && isKatakana(next)) return true
  if (isAsciiWord(prev) && isAsciiWord(next)) return true
  return false
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
    const punctuationBonus = punctuation.includes(prev) ? -1000 : 0
    const distance = Math.abs(index - preferred) + punctuationBonus
    if (distance < bestDistance) {
      best = index
      bestDistance = distance
    }
  }
  if (best >= 0) return best
  for (let radius = 0; radius < text.length; radius += 1) {
    for (const index of [preferred - radius, preferred + radius]) {
      if (index <= 0 || index >= text.length) continue
      if (!isUnsafeSplit(text, index, ranges)) return index
    }
  }
  return Math.max(1, Math.min(text.length - 1, preferred))
}

function splitOverlongRawUnit(unit: RawSemanticUnit, estimatedDuration: number, constraints: Constraints, glossaryTerms: string[]): RawSemanticUnit[] {
  const duration = estimatedDuration
  if (duration <= constraints.max_duration) return [unit]
  const targetParts = Math.ceil(duration / Math.max(1, constraints.max_duration * 0.88))
  const clauses = splitJapaneseClauses(unit.ja_text)
  const groups: string[] = []
  let current = ''
  const targetChars = Math.ceil(unit.ja_text.length / targetParts)
  for (const clause of clauses) {
    if (current && current.length + clause.length > targetChars && groups.length < targetParts - 1) {
      groups.push(current)
      current = clause
    } else {
      current += clause
    }
  }
  if (current) groups.push(current)
  while (groups.length < targetParts) {
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
    unit_id: `${unit.unit_id}_${index + 1}`,
    ja_text: group,
    can_merge_with_next: index < groups.length - 1 || unit.can_merge_with_next,
  }))
}

function segmentWordsInRange(segment: FixtureSegment, chunk: FixtureChunk): WordTimestamp[] {
  const start = Math.max(segment.start, chunk.start)
  const end = Math.min(segment.end, chunk.end)
  return (segment.words ?? [])
    .filter((word) => Number.isFinite(word.start) && Number.isFinite(word.end))
    .filter((word) => word.end > start && word.start < end)
    .sort((a, b) => a.start - b.start || a.end - b.end)
}

function proportionalPiecesWithoutWords(segment: FixtureSegment, chunk: FixtureChunk, units: RawSemanticUnit[]): AlignedPiece[] {
  const segmentStart = Math.max(segment.start, chunk.start)
  const segmentEnd = Math.min(segment.end, chunk.end)
  const segmentDuration = Math.max(0.001, segmentEnd - segmentStart)
  const charCounts = units.map((unit) => Math.max(1, normalizeTimingText(unit.ja_text).length))
  const totalChars = charCounts.reduce((sum, count) => sum + count, 0)
  let cursor = segmentStart
  return units.map((unit, index) => {
    const isLast = index === units.length - 1
    const end = isLast ? segmentEnd : Math.min(segmentEnd, cursor + segmentDuration * (charCounts[index] / Math.max(1, totalChars)))
    const piece: AlignedPiece = {
      unit,
      start: round(cursor),
      end: round(Math.max(cursor + 0.05, end)),
      align_conf: 'no_words',
      align_notes: ['no_word_timestamps: used segment character-proportional timing'],
    }
    cursor = end
    return piece
  })
}

function alignPiecesOnce(segment: FixtureSegment, chunk: FixtureChunk, units: RawSemanticUnit[]): AlignedPiece[] {
  if (units.length === 0) return []
  const segmentStart = Math.max(segment.start, chunk.start)
  const segmentEnd = Math.min(segment.end, chunk.end)
  const segmentDuration = Math.max(0.001, segmentEnd - segmentStart)
  const words = segmentWordsInRange(segment, chunk)
  const pieceCharCounts = units.map((unit) => normalizeTimingText(unit.ja_text).length)
  const totalPieceChars = pieceCharCounts.reduce((sum, count) => sum + Math.max(1, count), 0)

  if (words.length === 0) return proportionalPiecesWithoutWords(segment, chunk, units)

  const wordNormTexts = words.map((word) => normalizeTimingText(String(word.word ?? '')))
  const wordConcat = wordNormTexts.join('')
  const wordNormChars = wordNormTexts.map((text) => Math.max(1, text.length))
  const totalWordChars = wordNormChars.reduce((sum, count) => sum + count, 0)
  const startWordIndexes: number[] = new Array(units.length).fill(0)
  const startBoundaryExact: boolean[] = new Array(units.length).fill(true)

  for (let index = 1; index < units.length; index += 1) {
    const previousStart = startWordIndexes[index - 1]
    const pieceNorm = normalizeTimingText(units[index].ja_text)
    const matched = findBoundaryWordIndex(wordNormTexts, wordConcat, pieceNorm, previousStart)
    if (matched !== null && matched > previousStart) {
      startWordIndexes[index] = matched
      startBoundaryExact[index] = true
      continue
    }
    const fallback = charProportionalWordIndex(wordNormChars, totalWordChars, pieceCharCounts, index, totalPieceChars)
    startWordIndexes[index] = Math.min(Math.max(previousStart + 1, fallback), words.length - 1)
    startBoundaryExact[index] = false
  }

  return units.map((unit, index) => {
    const wordStartIndex = startWordIndexes[index]
    const wordEndIndex = index < units.length - 1 ? startWordIndexes[index + 1] : words.length
    const slicedWords = words.slice(wordStartIndex, wordEndIndex)
    const charsBefore = pieceCharCounts.slice(0, index).reduce((sum, count) => sum + Math.max(1, count), 0)
    const charsUpTo = pieceCharCounts.slice(0, index + 1).reduce((sum, count) => sum + Math.max(1, count), 0)
    const propStart = index === 0 ? segmentStart : segmentStart + segmentDuration * (charsBefore / Math.max(1, totalPieceChars))
    const propEnd = index === units.length - 1 ? segmentEnd : segmentStart + segmentDuration * (charsUpTo / Math.max(1, totalPieceChars))
    const hasWordTime = slicedWords.length > 0 && Number.isFinite(slicedWords[0].start) && Number.isFinite(slicedWords[slicedWords.length - 1].end)
    const start = hasWordTime ? slicedWords[0].start : propStart
    const end = hasWordTime ? slicedWords[slicedWords.length - 1].end : propEnd
    const endBoundaryExact = index === units.length - 1 || startBoundaryExact[index + 1]
    const alignConf = hasWordTime && startBoundaryExact[index] && endBoundaryExact ? 'exact' : 'proportional'
    const notes: string[] = []
    if (alignConf === 'exact') notes.push('word_boundary_exact: used WhisperX word timestamps')
    if (alignConf === 'proportional') {
      if (!startBoundaryExact[index] || !endBoundaryExact) notes.push('word_boundary_fallback: used character-proportional word boundary')
      if (!hasWordTime) notes.push('empty_word_slice: used segment character-proportional timing')
    }
    return {
      unit,
      start: round(start),
      end: round(Math.max(start + 0.05, end)),
      align_conf: alignConf,
      align_notes: notes,
    }
  })
}

function alignRawUnitsToSegment(
  segment: FixtureSegment,
  chunk: FixtureChunk,
  rawUnits: RawSemanticUnit[],
  constraints: Constraints,
  glossaryTerms: string[],
): SemanticUnit[] {
  let units = rawUnits
  let aligned = alignPiecesOnce(segment, chunk, units)
  for (let loop = 0; loop < 8; loop += 1) {
    const overlongIndex = aligned.findIndex((piece) => piece.end - piece.start > constraints.max_duration)
    if (overlongIndex < 0) break
    const overlong = aligned[overlongIndex]
    const split = splitOverlongRawUnit(overlong.unit, overlong.end - overlong.start, constraints, glossaryTerms)
    if (split.length <= 1) break
    units = [...units.slice(0, overlongIndex), ...split, ...units.slice(overlongIndex + 1)]
    aligned = alignPiecesOnce(segment, chunk, units)
  }

  return aligned.map((piece) => ({
    ...piece.unit,
    start: piece.start,
    end: piece.end,
    align_conf: piece.align_conf,
    align_notes: piece.align_notes,
  }))
}

function parsedSemanticUnits(output: unknown, chunk: FixtureChunk, constraints: Constraints, glossaryTerms: string[]): SemanticUnit[] {
  const record = asRecord(output)
  const rawUnits = Array.isArray(record.semantic_units) ? record.semantic_units : []
  const segmentById = new Map(chunk.segments.map((segment) => [segment.id, segment]))
  const unitsBySegment = new Map<number, RawSemanticUnit[]>()

  rawUnits.forEach((rawUnit, index) => {
    const unitRecord = asRecord(rawUnit)
    const sourceSegmentId = numberValue(unitRecord.source_segment_id, -1)
    const segment = segmentById.get(sourceSegmentId)
    if (!segment) return
    const jaText = normalizeSpaces(stringValue(unitRecord.ja_text)).trim()
    if (!jaText) return
    const unit: RawSemanticUnit = {
      unit_id: normalizeSpaces(stringValue(unitRecord.unit_id, `u${String(index + 1).padStart(3, '0')}`)).replace(/[^a-zA-Z0-9_-]/g, '_') || `u${String(index + 1).padStart(3, '0')}`,
      source_segment_id: sourceSegmentId,
      ja_text: jaText,
      semantic_role: stringValue(unitRecord.semantic_role, 'semantic_unit'),
      can_merge_with_next: boolValue(unitRecord.can_merge_with_next, false),
    }
    const list = unitsBySegment.get(sourceSegmentId) ?? []
    list.push(unit)
    unitsBySegment.set(sourceSegmentId, list)
  })

  const units: SemanticUnit[] = []
  for (const segment of chunk.segments) {
    const segmentUnits = unitsBySegment.get(segment.id)
    if (!segmentUnits || segmentUnits.length === 0) {
      const fallbackUnit: RawSemanticUnit = {
        unit_id: `seg_${segment.id}`,
        source_segment_id: segment.id,
        ja_text: normalizeSpaces(segment.ja_text),
        semantic_role: 'segment_fallback',
        can_merge_with_next: false,
      }
      units.push(...alignRawUnitsToSegment(segment, chunk, [fallbackUnit], constraints, glossaryTerms))
      continue
    }
    units.push(...alignRawUnitsToSegment(segment, chunk, segmentUnits, constraints, glossaryTerms))
  }

  return units
    .filter((unit) => unit.end > chunk.start && unit.start < chunk.end)
    .sort((a, b) => a.start - b.start || a.end - b.end)
}

function cueFromUnits(chunk: FixtureChunk, constraints: Constraints, candidateId: string, index: number, units: SemanticUnit[]): CandidateCue {
  const start = Math.max(chunk.start, units[0]?.start ?? chunk.start)
  const end = Math.min(chunk.end, units[units.length - 1]?.end ?? start)
  const duration = Math.max(0.001, end - start)
  const jaSpan = normalizeSpaces(units.map((unit) => unit.ja_text).join(''))
  const targets = lengthTargets(duration, constraints)
  const alignConf = units.some((unit) => unit.align_conf === 'no_words')
    ? 'no_words'
    : units.every((unit) => unit.align_conf === 'exact')
      ? 'exact'
      : 'proportional'
  const alignNotes = [...new Set(units.flatMap((unit) => unit.align_notes))]
  return {
    cue_id: `${chunk.chunk_id}_${candidateId}_c${String(index + 1).padStart(3, '0')}`,
    start: round(start),
    end: round(end),
    ja_span: jaSpan,
    source_segment_ids: [...new Set(units.map((unit) => unit.source_segment_id))],
    source_token_count: units.length,
    ja_chars: jaSpan.length,
    micro_cue_risk: microCueRisk(duration, units.length, jaSpan.length),
    max_en_chars_by_cps: Math.max(1, Math.floor(duration * constraints.max_cps)),
    target_en_chars: targets.target_chars,
    min_good_en_chars: targets.min_good_chars,
    target_en_words: targets.target_words,
    duration: round(duration),
    align_conf: alignConf,
    align_notes: alignNotes,
  }
}

function buildCandidateFromUnits(
  chunk: FixtureChunk,
  constraints: Constraints,
  units: SemanticUnit[],
  candidateId: string,
  strategy: string,
  maxCueSeconds: number,
  preferMerge: boolean,
): CandidateSplit {
  const cues: CandidateCue[] = []
  let current: SemanticUnit[] = []

  const flush = () => {
    if (current.length === 0) return
    cues.push(cueFromUnits(chunk, constraints, candidateId, cues.length, current))
    current = []
  }

  for (const unit of units) {
    if (current.length === 0) {
      current.push(unit)
      continue
    }
    const previous = current[current.length - 1]
    const projectedDuration = unit.end - current[0].start
    const crossesSegment = unit.source_segment_id !== previous.source_segment_id
    const shouldMerge = preferMerge || previous.can_merge_with_next
    if (projectedDuration > maxCueSeconds || (crossesSegment && !shouldMerge)) {
      flush()
    }
    current.push(unit)
  }
  flush()

  const durations = cues.map((cue) => cue.duration)
  const covered = cues.reduce((sum, cue) => sum + cue.duration, 0)
  return scoreCandidateSplit({
    candidate_id: candidateId,
    strategy,
    cues,
    metrics: {
      cue_count: cues.length,
      min_duration: round(durations.length ? Math.min(...durations) : 0),
      max_duration: round(durations.length ? Math.max(...durations) : 0),
      avg_duration: round(durations.length ? covered / durations.length : 0),
      uncovered_seconds: round(Math.max(0, chunk.duration - covered)),
      avg_utilization_target: 0,
      micro_cue_count: 0,
      micro_cue_rate: 0,
      score: 0,
      hard_reject: false,
      score_reasons: [],
    },
  }, chunk, constraints)
}

export function parseCueStructureCandidates(output: unknown, chunk: FixtureChunk, constraints: Constraints, glossaryTerms: string[] = []): CandidateSplit[] {
  const units = parsedSemanticUnits(output, chunk, constraints, glossaryTerms)
  if (units.length === 0) return []
  const candidates = [
    buildCandidateFromUnits(chunk, constraints, units, 'semantic_balanced', 'semantic_balanced', Math.min(6.4, constraints.max_duration), false),
    buildCandidateFromUnits(chunk, constraints, units, 'semantic_dense', 'semantic_dense', Math.min(7.0, constraints.max_duration), true),
    buildCandidateFromUnits(chunk, constraints, units, 'semantic_conservative', 'semantic_conservative', Math.min(5.2, constraints.max_duration), false),
  ]
  return candidates.sort((a, b) => b.metrics.score - a.metrics.score)
}

export function cueCandidateStats(candidates: CandidateSplit[], selected: CandidateSplit[]): CueCandidateStats {
  const valid = candidates.filter((candidate) => !candidate.metrics.hard_reject)
  const strategies: Record<string, number> = {}
  const selectedCues = selected.flatMap((candidate) => candidate.cues)
  for (const candidate of candidates) {
    strategies[candidate.strategy] = (strategies[candidate.strategy] ?? 0) + 1
  }
  return {
    generated: candidates.length,
    valid: valid.length,
    selected: selected.length,
    best_score: valid[0]?.metrics.score ?? 0,
    strategies,
    alignment: {
      total_cues: selectedCues.length,
      exact: selectedCues.filter((cue) => cue.align_conf === 'exact').length,
      proportional: selectedCues.filter((cue) => cue.align_conf === 'proportional').length,
      no_words: selectedCues.filter((cue) => cue.align_conf === 'no_words').length,
    },
  }
}
