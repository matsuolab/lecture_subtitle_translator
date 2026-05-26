import type { Constraints } from './schema.js'
import { visibleLength } from './lineFormat.js'

const SUBTITLE_CHARS_TO_WORDS = 0.203
const WORD_TARGET_ADJUSTMENT = 1.1
const TARGET_UTILIZATION = 0.92
const GOOD_MIN_UTILIZATION = 0.72
const COMFORT_MIN_DURATION = 1.5

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}

export interface LengthControlMetrics {
  capacity_chars: number
  target_chars: number
  min_good_chars: number
  target_words: number
  utilization: number
  utilization_score: number
  duration_comfort_score: number
  line_fill_score: number
  constraint_quality_score: number
}

export function lengthTargets(duration: number, constraints: Constraints): Pick<LengthControlMetrics, 'capacity_chars' | 'target_chars' | 'min_good_chars' | 'target_words'> {
  const safeDuration = Math.max(0.001, duration)
  const capacity = Math.max(1, Math.floor(Math.min(
    constraints.max_segment_chars,
    safeDuration * constraints.max_cps,
  )))
  const targetChars = Math.max(1, Math.floor(capacity * TARGET_UTILIZATION))
  const minGoodChars = Math.max(1, Math.floor(capacity * GOOD_MIN_UTILIZATION))
  return {
    capacity_chars: capacity,
    target_chars: targetChars,
    min_good_chars: minGoodChars,
    target_words: Math.max(1, Math.round(targetChars * SUBTITLE_CHARS_TO_WORDS * WORD_TARGET_ADJUSTMENT)),
  }
}

export function lengthControlMetrics(text: string, duration: number, maxLineLen: number, constraints: Constraints): LengthControlMetrics {
  const targets = lengthTargets(duration, constraints)
  const chars = visibleLength(text)
  const utilization = chars / Math.max(1, targets.capacity_chars)
  const underfilled = utilization < GOOD_MIN_UTILIZATION
    ? utilization / GOOD_MIN_UTILIZATION
    : 1
  const overTarget = utilization > TARGET_UTILIZATION
    ? clamp(1 - ((utilization - TARGET_UTILIZATION) / (1 - TARGET_UTILIZATION)) * 0.35, 0, 1)
    : 1
  const utilizationScore = clamp(Math.min(underfilled, overTarget), 0, 1)
  const durationComfortScore = duration >= COMFORT_MIN_DURATION
    ? 1
    : clamp(duration / COMFORT_MIN_DURATION, 0, 1)
  const lineFillScore = clamp(maxLineLen / constraints.max_chars_per_line, 0, 1)
  const qualityScore = (
    utilizationScore * 0.6
    + durationComfortScore * 0.25
    + lineFillScore * 0.15
  )
  return {
    ...targets,
    utilization: round(utilization),
    utilization_score: round(utilizationScore),
    duration_comfort_score: round(durationComfortScore),
    line_fill_score: round(lineFillScore),
    constraint_quality_score: round(qualityScore),
  }
}
