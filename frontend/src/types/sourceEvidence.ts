import type { WordTimestamp } from '@/lib/pipeline/types'
import type { CorrectedSegmentLite } from '@/lib/pipeline/correct'

export type CueSourceRelation =
  | 'semantic_unit'
  | 'coverage_split'
  | 'overlong_split'
  | 'correction_split'
  | 'collapsed_merge'
  | 'cue_merge'

/**
 * A lightweight pointer from one displayed cue to the transcript material it
 * came from. The heavyweight transcript and word evidence lives once per run
 * in SourceSegmentEvidence.
 */
export interface CueSourceRef {
  sourceSegmentId: number
  semanticUnitId?: string
  relation: CueSourceRelation
}

export interface SourceSegmentEvidence {
  sourceSegmentId: number
  start: number
  end: number
  rawTranscript: string
  correctedTranscript: string
  words?: WordTimestamp[]
  correctionDistance?: number
  correctionFlagged?: boolean
}

export function cloneCueSourceRefs(sourceRefs: readonly CueSourceRef[] | undefined): CueSourceRef[] | undefined {
  return sourceRefs?.map(ref => ({ ...ref }))
}

export function withCueSourceRelation(
  sourceRefs: readonly CueSourceRef[] | undefined,
  relation: CueSourceRelation,
): CueSourceRef[] | undefined {
  return sourceRefs?.map(ref => ({ ...ref, relation }))
}

/** Stable union by source segment and semantic unit. First-seen order wins. */
export function mergeCueSourceRefs(
  left: readonly CueSourceRef[] | undefined,
  right: readonly CueSourceRef[] | undefined,
  relation: CueSourceRelation = 'cue_merge',
): CueSourceRef[] | undefined {
  const refs = [...(left ?? []), ...(right ?? [])]
  if (refs.length === 0) return undefined

  const seen = new Set<string>()
  const merged: CueSourceRef[] = []
  for (const ref of refs) {
    const key = `${ref.sourceSegmentId}\u0000${ref.semanticUnitId ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    merged.push({ ...ref, relation })
  }
  return merged
}

export function buildSourceSegmentEvidence(
  segments: readonly CorrectedSegmentLite[],
): SourceSegmentEvidence[] {
  return segments.map(segment => ({
    sourceSegmentId: segment.id,
    start: segment.start,
    end: segment.end,
    rawTranscript: segment.text,
    correctedTranscript: segment.correctedText,
    words: segment.words?.map(word => ({ ...word })),
    correctionDistance: segment.correctionDistance,
    correctionFlagged: segment.correctionFlagged,
  }))
}
