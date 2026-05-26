import type { ChunkPlan, Constraints, CuePlan, CueValidation, FixtureChunk, ValidationIssue } from './schema.js'
import { formatSubtitleLines, visibleLength } from './lineFormat.js'
import { lengthControlMetrics } from './lengthControl.js'

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length
}

function isStandaloneShortCue(cue: CuePlan): boolean {
  const normalized = cue.en.trim().toLowerCase().replace(/[.!?,]/g, '')
  return [
    'yes',
    'no',
    'thank you',
    'thank you very much',
  ].includes(normalized)
}

function normalizeCoverageText(text: string): string {
  return text.replace(/[。、「」『』（）()［］\[\]！？!?・,，、.\s]/g, '')
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

function coveredDuration(intervals: Array<{ start: number; end: number }>): number {
  const sorted = intervals
    .filter((interval) => interval.end > interval.start)
    .sort((a, b) => a.start - b.start)
  let total = 0
  let currentStart: number | null = null
  let currentEnd: number | null = null
  for (const interval of sorted) {
    if (currentStart === null || currentEnd === null) {
      currentStart = interval.start
      currentEnd = interval.end
    } else if (interval.start <= currentEnd) {
      currentEnd = Math.max(currentEnd, interval.end)
    } else {
      total += currentEnd - currentStart
      currentStart = interval.start
      currentEnd = interval.end
    }
  }
  if (currentStart !== null && currentEnd !== null) total += currentEnd - currentStart
  return total
}

export function validateCue(cue: CuePlan, constraints: Constraints): CueValidation {
  const issues: ValidationIssue[] = []
  const duration = Math.max(0, cue.end - cue.start)
  const formatted = formatSubtitleLines(cue.en, constraints.max_chars_per_line, constraints.max_lines)
  const lines = formatted ? formatted.split('\n') : []
  const maxLineLen = lines.reduce((max, line) => Math.max(max, line.length), 0)
  const enChars = visibleLength(cue.en)
  const cps = enChars / Math.max(0.001, duration)
  const lengthMetrics = lengthControlMetrics(cue.en, duration, maxLineLen, constraints)

  if (duration < constraints.min_duration) {
    issues.push({ code: 'duration_too_short', severity: 'error', message: 'Cue duration is below minimum.', cue_id: cue.cue_id, metrics: { duration } })
  }
  if (duration > constraints.max_duration) {
    issues.push({ code: 'duration_too_long', severity: 'error', message: 'Cue duration is above maximum.', cue_id: cue.cue_id, metrics: { duration } })
  }
  if (cps > constraints.max_cps) {
    const allowedChars = Math.floor(duration * constraints.max_cps)
    const charsToRemove = Math.max(0, enChars - allowedChars)
    issues.push({
      code: 'cps_over',
      severity: 'error',
      message: `Cue CPS exceeds limit. Current ${enChars} visible chars in ${round(duration)}s -> ${round(cps)} cps (max ${constraints.max_cps}). Remove about ${charsToRemove} chars to fit (target <= ${allowedChars} chars).`,
      cue_id: cue.cue_id,
      metrics: {
        cps: round(cps),
        max_cps: constraints.max_cps,
        current_chars: enChars,
        allowed_chars: allowedChars,
        chars_to_remove: charsToRemove,
      },
    })
  }
  if (maxLineLen > constraints.max_chars_per_line) {
    issues.push({ code: 'line_too_long', severity: 'error', message: 'Cue line length exceeds limit.', cue_id: cue.cue_id, metrics: { maxLineLen, max_chars_per_line: constraints.max_chars_per_line } })
  }
  if (lines.length > constraints.max_lines) {
    issues.push({ code: 'too_many_lines', severity: 'error', message: 'Cue has too many lines.', cue_id: cue.cue_id, metrics: { lineCount: lines.length, max_lines: constraints.max_lines } })
  }
  if (enChars > constraints.max_segment_chars) {
    issues.push({ code: 'segment_too_long', severity: 'error', message: 'Cue text exceeds max segment characters.', cue_id: cue.cue_id, metrics: { enChars, max_segment_chars: constraints.max_segment_chars } })
  }
  if (!cue.en.trim()) {
    issues.push({ code: 'empty_translation', severity: 'error', message: 'Cue has empty English text.', cue_id: cue.cue_id })
  }
  const jaChars = visibleLength(cue.ja_span)
  const enWords = wordCount(cue.en)
  if (!isStandaloneShortCue(cue) && (duration < 1.0 || enWords <= 2 || jaChars < 8)) {
    issues.push({ code: 'micro_cue', severity: 'error', message: 'Cue is too small and should usually be merged with an adjacent cue.', cue_id: cue.cue_id, metrics: { duration: round(duration), en_words: enWords, ja_chars: jaChars } })
  } else if (!isStandaloneShortCue(cue) && (duration < 1.5 || enWords <= 4 || jaChars < 12)) {
    issues.push({ code: 'micro_cue_risk', severity: 'warning', message: 'Cue is short enough to risk fragment-like subtitles.', cue_id: cue.cue_id, metrics: { duration: round(duration), en_words: enWords, ja_chars: jaChars } })
  }

  return {
    cue_id: cue.cue_id,
    ok: issues.every((issue) => issue.severity !== 'error'),
    issues,
    metrics: {
      duration: round(duration),
      enChars,
      cps: round(cps),
      lineCount: lines.length,
      maxLineLen,
      capacityChars: lengthMetrics.capacity_chars,
      targetChars: lengthMetrics.target_chars,
      minGoodChars: lengthMetrics.min_good_chars,
      targetWords: lengthMetrics.target_words,
      utilization: lengthMetrics.utilization,
      utilizationScore: lengthMetrics.utilization_score,
      durationComfortScore: lengthMetrics.duration_comfort_score,
      lineFillScore: lengthMetrics.line_fill_score,
      constraintQualityScore: lengthMetrics.constraint_quality_score,
    },
  }
}

export function validateTimeline(plan: ChunkPlan, chunk: FixtureChunk, constraints: Constraints): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const sorted = [...plan.cues].sort((a, b) => a.start - b.start)
  const expectedSegmentIds = new Set(chunk.segments.map((segment) => segment.id))
  const coveredSegmentIds = new Set<number>()
  for (const cue of plan.cues) {
    for (const segmentId of cue.source_segment_ids) {
      coveredSegmentIds.add(segmentId)
      if (!expectedSegmentIds.has(segmentId)) {
        issues.push({ code: 'source_segment_out_of_chunk', severity: 'error', message: 'Cue references a source segment outside this chunk.', cue_id: cue.cue_id, metrics: { source_segment_id: segmentId } })
      }
    }
  }
  for (const segment of chunk.segments) {
    if (!coveredSegmentIds.has(segment.id)) {
      const segmentExcerpt = segment.ja_text.slice(0, 200)
      issues.push({
        code: 'source_segment_missing',
        severity: 'error',
        message: `Source segment ${segment.id} (${round(segment.start)}-${round(segment.end)}s) is not referenced by any cue. Segment JA text: "${segmentExcerpt}". Add a cue (or expand an adjacent cue's ja_span/source_segment_ids) to cover this segment.`,
        metrics: {
          source_segment_id: segment.id,
          segment_start: segment.start,
          segment_end: segment.end,
          segment_ja_text: segmentExcerpt,
        },
      })
      continue
    }
    const segmentStart = Math.max(segment.start, chunk.start)
    const segmentEnd = Math.min(segment.end, chunk.end)
    const segmentDuration = Math.max(0, segmentEnd - segmentStart)
    if (segmentDuration > 0.001) {
      const cueIntervals = plan.cues
        .filter((cue) => cue.source_segment_ids.includes(segment.id))
        .map((cue) => ({
          start: Math.max(cue.start, segmentStart),
          end: Math.min(cue.end, segmentEnd),
        }))
      const ratio = coveredDuration(cueIntervals) / segmentDuration
      if (ratio < 0.8) {
        issues.push({ code: 'source_segment_undercovered', severity: 'error', message: 'A source segment is not sufficiently covered by cue timing.', metrics: { source_segment_id: segment.id, coverage_ratio: round(ratio), segment_start: round(segmentStart), segment_end: round(segmentEnd) } })
      }
    }
    const sourceText = normalizeCoverageText(segment.ja_text)
    if (sourceText.length >= 20) {
      const plannedText = normalizeCoverageText(
        sorted
          .filter((cue) => cue.source_segment_ids.includes(segment.id))
          .map((cue) => cue.ja_span)
          .join(''),
      )
      const coverageRatio = lcsLength(sourceText, plannedText) / Math.max(1, sourceText.length)
      if (coverageRatio < 0.9) {
        const sourceExcerpt = segment.ja_text.slice(0, 250)
        const plannedExcerpt = plannedText.slice(0, 250)
        issues.push({
          code: 'source_text_undercovered',
          severity: 'error',
          message: `Source segment ${segment.id} is only ${Math.round(coverageRatio * 100)}% covered by cue ja_spans (need >= 90%). Source JA text: "${sourceExcerpt}". Currently covered by cue ja_spans (joined): "${plannedExcerpt}". Rewrite or expand existing cues so the missing Japanese content is captured in ja_span and the en text reflects the missing meaning. Do not drop content. Do not create empty or micro cues.`,
          metrics: {
            source_segment_id: segment.id,
            coverage_ratio: round(coverageRatio),
            source_chars: sourceText.length,
            planned_chars: plannedText.length,
            source_ja_text: sourceExcerpt,
            planned_ja_text: plannedExcerpt,
          },
        })
      }
    }
  }
  for (let i = 0; i < sorted.length; i += 1) {
    const cue = sorted[i]
    if (cue.start < chunk.start - 0.001 || cue.end > chunk.end + 0.001) {
      issues.push({ code: 'cue_out_of_chunk', severity: 'error', message: 'Cue is outside chunk range.', cue_id: cue.cue_id, metrics: { cue_start: cue.start, cue_end: cue.end, chunk_start: chunk.start, chunk_end: chunk.end } })
    }
    if (cue.end <= cue.start) {
      issues.push({ code: 'invalid_time_range', severity: 'error', message: 'Cue end must be greater than start.', cue_id: cue.cue_id })
    }
    const next = sorted[i + 1]
    if (next) {
      const gap = next.start - cue.end
      if (gap < -0.001) {
        issues.push({ code: 'cue_overlap', severity: 'error', message: 'Cue overlaps with next cue.', cue_id: cue.cue_id, metrics: { next_cue_id: next.cue_id, gap: round(gap) } })
      } else if (gap > 0 && gap < constraints.min_gap) {
        issues.push({ code: 'gap_too_short', severity: 'warning', message: 'Cue gap is below preferred minimum.', cue_id: cue.cue_id, metrics: { next_cue_id: next.cue_id, gap: round(gap) } })
      }
    }
  }
  return issues
}

export function validatePlan(plan: ChunkPlan, chunk: FixtureChunk, constraints: Constraints): { cueValidations: CueValidation[]; issues: ValidationIssue[]; ok: boolean } {
  const cueValidations = plan.cues.map((cue) => validateCue(cue, constraints))
  const issues = [...validateTimeline(plan, chunk, constraints), ...cueValidations.flatMap((item) => item.issues)]
  return {
    cueValidations,
    issues,
    ok: issues.every((issue) => issue.severity !== 'error'),
  }
}
