import { alignCuesToAsr, buildAsrCharStream } from '../../asrAlignment'
import type { EnBlock } from '../../blockTypes'
import type { LanguageScript } from '../../languageProfileConfig'
import { countCpsChars } from '@/lib/subtitleMetrics'
import type { WordTimestamp } from '../../types'
import type { SplitTimingDecision } from '../types'
import { compareSplitTimingPolicies } from '../../splitTimingDiagnostics'

export interface SplitTimingUnitInput {
  jaText: string
  enText: string
}

export interface SplitTimingUnitAllocation {
  start: number
  end: number
  words?: WordTimestamp[]
  alignConf: EnBlock['alignConf']
  alignMatchRate?: number
}

export interface SplitTimingAllocation {
  units: SplitTimingUnitAllocation[]
  decision: SplitTimingDecision
}

export interface SplitTimingAllocationInput {
  parent: Pick<EnBlock, 'id' | 'start' | 'end' | 'jaText' | 'words'>
  units: readonly SplitTimingUnitInput[]
  script: LanguageScript
  gapMs: number
  maxClosableGapSec: number
  subtitleMinDurationSec: number
  shortDurationSec: number
  verboseCps: number
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000
}

function allocateDurationsMs(
  weights: readonly number[],
  availableMs: number,
  minDurationMs: number,
): number[] | null {
  if (weights.length === 0) return []
  if (availableMs < minDurationMs * weights.length) return null

  const remainingMs = availableMs - minDurationMs * weights.length
  const totalWeight = weights.reduce((sum, weight) => sum + Math.max(1, weight), 0)
  const durations = weights.map((weight) =>
    minDurationMs + Math.floor(remainingMs * Math.max(1, weight) / totalWeight),
  )
  let remainder = availableMs - durations.reduce((sum, duration) => sum + duration, 0)
  let index = 0
  while (remainder > 0) {
    durations[index % durations.length] += 1
    index += 1
    remainder -= 1
  }
  return durations
}

function buildWeightedFallback(
  input: SplitTimingAllocationInput,
): SplitTimingUnitAllocation[] | null {
  const gapSec = input.gapMs / 1000
  const totalDurationMs = Math.round((input.parent.end - input.parent.start) * 1000)
  const availableMs = totalDurationMs - input.gapMs * (input.units.length - 1)
  const minDurationMs = Math.round(input.subtitleMinDurationSec * 1000)
  const durationsMs = allocateDurationsMs(
    input.units.map(unit => countCpsChars(unit.enText)),
    availableMs,
    minDurationMs,
  )
  if (!durationsMs) return null

  let cursor = input.parent.start
  return input.units.map((_, index) => {
    const start = cursor
    const end = index === input.units.length - 1
      ? input.parent.end
      : start + durationsMs[index] / 1000
    cursor = end + gapSec
    return {
      start: index === 0 ? input.parent.start : round3(start),
      end: index === input.units.length - 1 ? input.parent.end : round3(end),
      alignConf: 'proportional',
    }
  })
}

function fallback(
  units: SplitTimingUnitAllocation[],
  reason: SplitTimingDecision['fallbackReason'],
  evidence: Pick<SplitTimingDecision, 'matchRates' | 'spokenRanges'> = {},
): SplitTimingAllocation {
  const alignConf: SplitTimingUnitAllocation['alignConf'] = reason === 'no_words'
    ? 'no_words'
    : 'proportional'
  const normalizedUnits: SplitTimingUnitAllocation[] = units.map(unit => ({ ...unit, alignConf }))
  return {
    units: normalizedUnits,
    decision: {
      basis: 'english_weighted_fallback',
      fallbackReason: reason,
      ...evidence,
      displayRanges: normalizedUnits.map(unit => ({ start: unit.start, end: unit.end })),
    },
  }
}

function spanWords(
  firstCharIndex: number,
  lastCharIndex: number,
  asr: ReturnType<typeof buildAsrCharStream>,
): WordTimestamp[] {
  return asr.slice(firstCharIndex, lastCharIndex + 1).map(char => ({
    word: char.char,
    start: round3(char.start),
    end: round3(char.end),
    score: char.score,
  }))
}

/**
 * split本文・翻訳・cue数を変えず、子cueの時刻だけをASR根拠へ近づける。
 * ASR根拠または表示制約が不足する場合は、従来の英語文字数比をそのまま返す。
 */
export function allocateSplitTiming(input: SplitTimingAllocationInput): SplitTimingAllocation | null {
  if (
    input.units.length < 2
    || input.parent.end <= input.parent.start
    || input.gapMs < 0
    || input.subtitleMinDurationSec < 0
    || input.shortDurationSec < 0
    || input.verboseCps <= 0
  ) return null

  const weighted = buildWeightedFallback(input)
  if (!weighted) return null
  if (!input.parent.words?.length) return fallback(weighted, 'no_words')

  const asr = buildAsrCharStream([{
    id: input.parent.id,
    start: input.parent.start,
    end: input.parent.end,
    text: input.parent.jaText,
    words: input.parent.words,
  }], { script: input.script })
  const spans = alignCuesToAsr(input.units.map(unit => unit.jaText), asr, { script: input.script })
  const highConfidence = spans.every(span =>
    span.confidence === 'exact'
    && span.matchRate >= 0.8
    && span.firstCharIndex !== null
    && span.lastCharIndex !== null,
  )
  if (!highConfidence) {
    return fallback(weighted, 'asr_not_exact', {
      matchRates: spans.map(span => round3(span.matchRate)),
    })
  }

  const spokenEdges = spans.slice(0, -1).map((left, index) => ({
    leftEndSec: left.endSec,
    rightStartSec: spans[index + 1].startSec,
  }))
  const comparison = compareSplitTimingPolicies({
    cues: weighted.map((unit, index) => ({
      id: index,
      start: unit.start,
      end: unit.end,
      enChars: countCpsChars(input.units[index].enText),
    })),
    spokenBoundarySec: spokenEdges.map(edge => (edge.leftEndSec + edge.rightStartSec) / 2),
    spokenBoundaryEdges: spokenEdges,
    gapSec: input.gapMs / 1000,
    maxClosableGapSec: input.maxClosableGapSec,
    minDurationSec: Math.max(input.subtitleMinDurationSec, input.shortDurationSec),
    maxCps: input.verboseCps,
  })
  if (!comparison.feasible) {
    return fallback(weighted, 'constraints_infeasible', {
      matchRates: spans.map(span => round3(span.matchRate)),
      spokenRanges: spans.map(span => ({ start: round3(span.startSec), end: round3(span.endSec) })),
    })
  }

  const allocatedUnits = comparison.constrained.cues.map((cue, index) => ({
    start: index === 0 ? input.parent.start : cue.start,
    end: index === comparison.constrained.cues.length - 1 ? input.parent.end : cue.end,
    words: spanWords(
      spans[index].firstCharIndex as number,
      spans[index].lastCharIndex as number,
      asr,
    ),
    alignConf: 'exact' as const,
    alignMatchRate: round3(spans[index].matchRate),
  }))

  return {
    units: allocatedUnits,
    decision: {
      basis: 'asr_constrained',
      matchRates: spans.map(span => round3(span.matchRate)),
      boundaryDeltasSec: spokenEdges.map((edge, index) => round3(Math.max(
        Math.abs(comparison.constrained.cues[index].end - edge.leftEndSec),
        Math.abs(comparison.constrained.cues[index + 1].start - edge.rightStartSec),
      ))),
      spokenRanges: spans.map(span => ({ start: round3(span.startSec), end: round3(span.endSec) })),
      displayRanges: allocatedUnits.map(unit => ({ start: unit.start, end: unit.end })),
    },
  }
}
