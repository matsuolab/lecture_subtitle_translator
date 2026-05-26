import type { ChunkPlan, Constraints, CueValidation, FixtureChunk, MergeCandidate, MergeRewriteStats, StyleExample } from './schema.js'
import { visibleLength } from './lineFormat.js'
import { lengthControlMetrics } from './lengthControl.js'
import { validatePlan } from './validators.js'
import { compactStyleExamples } from './styleExamples.js'

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}

function avg(values: number[]): number {
  if (values.length === 0) return 0
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function uniqSorted(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b)
}

function validationAverages(validations: CueValidation[]): { utilization: number; quality: number } {
  return {
    utilization: round(avg(validations.map((item) => item.metrics.utilization))),
    quality: round(avg(validations.map((item) => item.metrics.constraintQualityScore))),
  }
}

export function buildMergeCandidates(plan: ChunkPlan, constraints: Constraints): MergeCandidate[] {
  const sorted = [...plan.cues].sort((a, b) => a.start - b.start)
  const candidates: MergeCandidate[] = []

  for (let startIndex = 0; startIndex < sorted.length; startIndex += 1) {
    for (const size of [2, 3]) {
      const group = sorted.slice(startIndex, startIndex + size)
      if (group.length !== size) continue
      const start = group[0].start
      const end = group[group.length - 1].end
      const duration = end - start
      if (duration > constraints.max_duration || duration < constraints.min_duration) continue
      const gaps = group.slice(1).map((cue, index) => cue.start - group[index].end)
      if (gaps.some((gap) => gap < -0.001 || gap > 1.2)) continue

      const currentEn = group.map((cue) => cue.en.trim()).filter(Boolean).join(' ')
      const currentChars = visibleLength(currentEn)
      if (currentChars > constraints.max_segment_chars * 1.25) continue
      const metrics = lengthControlMetrics(currentEn, duration, Math.min(constraints.max_chars_per_line, currentChars), constraints)
      const hasLowUtilCue = group.some((cue) => {
        const cueDuration = cue.end - cue.start
        const cueMetrics = lengthControlMetrics(cue.en, cueDuration, visibleLength(cue.en), constraints)
        return cueMetrics.utilization < 0.7 || cueDuration < 3
      })
      if (!hasLowUtilCue) continue

      candidates.push({
        candidate_id: `merge_${startIndex + 1}_${size}`,
        cue_ids: group.map((cue) => cue.cue_id),
        start,
        end,
        duration: round(duration),
        gap_seconds: round(gaps.reduce((sum, gap) => sum + Math.max(0, gap), 0)),
        ja_span: group.map((cue) => cue.ja_span.trim()).filter(Boolean).join(''),
        current_en: currentEn,
        source_segment_ids: uniqSorted(group.flatMap((cue) => cue.source_segment_ids)),
        current_chars: currentChars,
        capacity_chars: metrics.capacity_chars,
        target_chars: metrics.target_chars,
        min_good_chars: metrics.min_good_chars,
        target_words: metrics.target_words,
        reason: size === 3 ? 'Merge three adjacent short/low-utilization cues.' : 'Merge two adjacent short/low-utilization cues.',
      })
    }
  }

  return candidates
    .sort((a, b) => {
      const aScore = Math.abs(a.duration - 6.2) + Math.abs(a.current_chars / Math.max(1, a.capacity_chars) - 0.75)
      const bScore = Math.abs(b.duration - 6.2) + Math.abs(b.current_chars / Math.max(1, b.capacity_chars) - 0.75)
      return aScore - bScore
    })
    .slice(0, 10)
}

export function buildMergeRewriteInput(chunk: FixtureChunk, constraints: Constraints, plan: ChunkPlan, candidates: MergeCandidate[], styleExamples: StyleExample[]): string {
  return JSON.stringify({
    chunk_id: chunk.chunk_id,
    constraints,
    instruction: 'Choose useful adjacent merge candidates and rewrite the merged Japanese span as natural English subtitles. Return a full cue plan, not only changed cues.',
    style_examples: compactStyleExamples(styleExamples),
    current_plan: plan,
    merge_candidates: candidates,
    context: {
      before: chunk.context_before,
      after: chunk.context_after,
    },
  })
}

export function assessMergeRewrite(
  before: ChunkPlan,
  after: ChunkPlan,
  chunk: FixtureChunk,
  constraints: Constraints,
  candidateCount: number,
): { stats: MergeRewriteStats; accepted: boolean } {
  const beforeValidation = validatePlan(before, chunk, constraints)
  const afterValidation = validatePlan(after, chunk, constraints)
  const beforeAvg = validationAverages(beforeValidation.cueValidations)
  const afterAvg = validationAverages(afterValidation.cueValidations)
  const baseStats = {
    candidates: candidateCount,
    attempted: candidateCount > 0,
    before_cues: before.cues.length,
    after_cues: after.cues.length,
    before_avg_capacity_utilization: beforeAvg.utilization,
    after_avg_capacity_utilization: afterAvg.utilization,
    before_avg_constraint_quality_score: beforeAvg.quality,
    after_avg_constraint_quality_score: afterAvg.quality,
  }

  if (!afterValidation.ok) {
    return {
      accepted: false,
      stats: {
        ...baseStats,
        accepted: false,
        rejection_reason: `rewrite_failed_validation:${afterValidation.issues.filter((issue) => issue.severity === 'error').map((issue) => issue.code).join(',')}`,
      },
    }
  }
  if (after.cues.length >= before.cues.length) {
    return {
      accepted: false,
      stats: {
        ...baseStats,
        accepted: false,
        rejection_reason: 'rewrite_did_not_reduce_cue_count',
      },
    }
  }
  if (afterAvg.quality + 0.001 < beforeAvg.quality && afterAvg.utilization + 0.001 < beforeAvg.utilization) {
    return {
      accepted: false,
      stats: {
        ...baseStats,
        accepted: false,
        rejection_reason: 'rewrite_did_not_improve_quality_or_utilization',
      },
    }
  }

  return {
    accepted: true,
    stats: {
      ...baseStats,
      accepted: true,
    },
  }
}
