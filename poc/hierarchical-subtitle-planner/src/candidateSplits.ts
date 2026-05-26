import type { CandidateCue, CandidateSplit, Constraints, FixtureChunk, WordTimestamp } from './schema.js'
import { normalizeSpaces } from './lineFormat.js'
import { lengthTargets } from './lengthControl.js'

type SplitStrategy = 'word_budget' | 'segment_boundary' | 'short_cues'

interface TimedToken {
  word: string
  start: number
  end: number
  segmentId: number
}

function segmentTextById(chunk: FixtureChunk): Map<number, { text: string; start: number; end: number }> {
  return new Map(chunk.segments.map((segment) => [
    segment.id,
    {
      text: segment.ja_text,
      start: segment.start,
      end: segment.end,
    },
  ]))
}

function sliceSegmentText(text: string, segmentStart: number, segmentEnd: number, cueStart: number, cueEnd: number): string {
  const normalized = normalizeSpaces(text).replace(/\s+/g, '')
  if (!normalized) return ''
  const duration = Math.max(0.001, segmentEnd - segmentStart)
  const startRatio = Math.max(0, Math.min(1, (cueStart - segmentStart) / duration))
  const endRatio = Math.max(startRatio, Math.min(1, (cueEnd - segmentStart) / duration))
  const startIdx = Math.floor(normalized.length * startRatio)
  const endIdx = Math.max(startIdx + 1, Math.ceil(normalized.length * endRatio))
  return normalized.slice(startIdx, endIdx)
}

function correctedJaSpan(chunk: FixtureChunk, tokens: TimedToken[]): string {
  const byId = segmentTextById(chunk)
  const parts: string[] = []
  for (const segmentId of [...new Set(tokens.map((token) => token.segmentId))]) {
    const segment = byId.get(segmentId)
    if (!segment) continue
    const segmentTokens = tokens.filter((token) => token.segmentId === segmentId)
    const cueStart = segmentTokens[0]?.start ?? segment.start
    const cueEnd = segmentTokens[segmentTokens.length - 1]?.end ?? segment.end
    parts.push(sliceSegmentText(segment.text, segment.start, segment.end, cueStart, cueEnd))
  }
  return normalizeSpaces(parts.join(''))
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}

function microCueRisk(duration: number, tokenCount: number, jaChars: number): boolean {
  return duration < 1.5 || tokenCount <= 4 || jaChars < 8
}

function timedWords(chunk: FixtureChunk): TimedToken[] {
  return chunk.segments.flatMap((segment) => {
    const words = segment.words.length > 0
      ? segment.words
      : [{ word: segment.ja_text, start: segment.start, end: segment.end } satisfies WordTimestamp]
    return words
      .filter((word) => Number.isFinite(word.start) && Number.isFinite(word.end) && word.end > word.start)
      .filter((word) => word.end > chunk.start && word.start < chunk.end)
      .map((word) => ({
        word: word.word,
        start: Math.max(word.start, chunk.start),
        end: Math.min(word.end, chunk.end),
        segmentId: segment.id,
      }))
  }).sort((a, b) => a.start - b.start)
}

function cueFromTokens(chunk: FixtureChunk, candidateId: string, index: number, tokens: TimedToken[], constraints: Constraints): CandidateCue {
  const start = tokens[0]?.start ?? 0
  const end = tokens[tokens.length - 1]?.end ?? start
  const duration = Math.max(0.001, end - start)
  const targets = lengthTargets(duration, constraints)
  const jaSpan = correctedJaSpan(chunk, tokens)
  return {
    cue_id: `${chunk.chunk_id}_${candidateId}_c${String(index + 1).padStart(3, '0')}`,
    start: round(start),
    end: round(end),
    ja_span: jaSpan,
    source_segment_ids: [...new Set(tokens.map((token) => token.segmentId))],
    source_token_count: tokens.length,
    ja_chars: jaSpan.length,
    micro_cue_risk: microCueRisk(duration, tokens.length, jaSpan.length),
    max_en_chars_by_cps: Math.max(1, Math.floor(duration * constraints.max_cps)),
    target_en_chars: targets.target_chars,
    min_good_en_chars: targets.min_good_chars,
    target_en_words: targets.target_words,
    duration: round(duration),
  }
}

function buildCandidate(
  chunk: FixtureChunk,
  constraints: Constraints,
  strategy: SplitStrategy,
  maxWordsPerCue: number,
  maxCueSeconds: number,
): CandidateSplit {
  const tokens = timedWords(chunk)
  const candidateId = strategy
  const cues: CandidateCue[] = []
  let current: TimedToken[] = []

  const flush = () => {
    if (current.length === 0) return
    cues.push(cueFromTokens(chunk, candidateId, cues.length, current, constraints))
    current = []
  }

  for (const token of tokens) {
    if (current.length === 0) {
      current.push(token)
      continue
    }
    const first = current[0]
    const previous = current[current.length - 1]
    const projectedDuration = token.end - first.start
    const crossesSegment = strategy === 'segment_boundary' && token.segmentId !== previous.segmentId
    const exceedsWordBudget = current.length >= maxWordsPerCue
    const exceedsDuration = projectedDuration > maxCueSeconds
    if (crossesSegment || exceedsWordBudget || exceedsDuration) {
      flush()
    }
    current.push(token)
  }
  flush()

  const durations = cues.map((cue) => cue.duration)
  const covered = cues.reduce((sum, cue) => sum + cue.duration, 0)
  const candidate: CandidateSplit = {
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
  }
  return scoreCandidateSplit(candidate, chunk, constraints)
}

export function scoreCandidateSplit(candidate: CandidateSplit, chunk: FixtureChunk, constraints: Constraints): CandidateSplit {
  const reasons: string[] = []
  const expectedSegmentIds = new Set(chunk.segments.map((segment) => segment.id))
  const coveredSegmentIds = new Set(candidate.cues.flatMap((cue) => cue.source_segment_ids))
  const missingSegments = [...expectedSegmentIds].filter((id) => !coveredSegmentIds.has(id))
  const microCueCount = candidate.cues.filter((cue) => cue.micro_cue_risk).length
  const durationViolations = candidate.cues.filter((cue) => cue.duration < constraints.min_duration || cue.duration > constraints.max_duration).length
  const microCueRate = candidate.cues.length === 0 ? 1 : microCueCount / candidate.cues.length
  const avgUtilizationTarget = candidate.cues.length === 0
    ? 0
    : candidate.cues.reduce((sum, cue) => sum + (cue.min_good_en_chars / Math.max(1, cue.max_en_chars_by_cps)), 0) / candidate.cues.length
  let hardReject = candidate.cues.length === 0 || missingSegments.length > 0
  if (missingSegments.length > 0) reasons.push(`missing_segments:${missingSegments.join(';')}`)
  if (durationViolations > 0) {
    hardReject = true
    reasons.push(`duration_out_of_range:${durationViolations}`)
  }
  if (microCueRate > 0.3) {
    hardReject = true
    reasons.push('micro_cue_rate_over_0.30')
  } else if (microCueRate > 0.15) {
    reasons.push('micro_cue_rate_over_0.15')
  }
  const durationComfort = candidate.cues.length === 0
    ? 0
    : candidate.cues.reduce((sum, cue) => {
      if (cue.duration < constraints.min_duration || cue.duration > constraints.max_duration) return sum
      if (cue.duration >= 2.5 && cue.duration <= 6.5) return sum + 1
      return sum + 0.65
    }, 0) / candidate.cues.length
  const coverageScore = missingSegments.length === 0 ? 1 : Math.max(0, 1 - missingSegments.length / Math.max(1, expectedSegmentIds.size))
  const microScore = Math.max(0, 1 - microCueRate * 3)
  const cueCountTarget = Math.max(1, Math.round(chunk.duration / 4.5))
  const cueCountScore = Math.max(0, 1 - Math.abs(candidate.cues.length - cueCountTarget) / Math.max(cueCountTarget, candidate.cues.length, 1))
  const score = hardReject
    ? 0
    : round((
      coverageScore * 0.3
      + avgUtilizationTarget * 0.25
      + durationComfort * 0.2
      + microScore * 0.15
      + cueCountScore * 0.1
    ) * 100)
  return {
    ...candidate,
    metrics: {
      ...candidate.metrics,
      avg_utilization_target: round(avgUtilizationTarget),
      micro_cue_count: microCueCount,
      micro_cue_rate: round(microCueRate),
      score,
      hard_reject: hardReject,
      score_reasons: reasons,
    },
  }
}

export function generateCandidateSplits(chunk: FixtureChunk, constraints: Constraints, extraCandidates: CandidateSplit[] = []): CandidateSplit[] {
  const deterministic = [
    buildCandidate(chunk, constraints, 'word_budget', 18, Math.min(5.8, constraints.max_duration)),
    buildCandidate(chunk, constraints, 'segment_boundary', 28, Math.min(6.5, constraints.max_duration)),
    buildCandidate(chunk, constraints, 'short_cues', 12, Math.min(4.2, constraints.max_duration)),
  ]
  return [...deterministic, ...extraCandidates]
    .map((candidate) => scoreCandidateSplit(candidate, chunk, constraints))
    .sort((a, b) => b.metrics.score - a.metrics.score)
}
