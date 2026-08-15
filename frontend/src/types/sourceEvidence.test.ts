import { describe, expect, it } from 'vitest'
import { buildSourceSegmentEvidence, mergeCueSourceRefs } from './sourceEvidence'

describe('mergeCueSourceRefs', () => {
  it('keeps first-seen order, removes duplicate semantic units, and marks the merged relation', () => {
    const merged = mergeCueSourceRefs(
      [
        { sourceSegmentId: 10, semanticUnitId: 'u10', relation: 'semantic_unit' },
        { sourceSegmentId: 11, semanticUnitId: 'u11', relation: 'overlong_split' },
      ],
      [
        { sourceSegmentId: 10, semanticUnitId: 'u10', relation: 'coverage_split' },
        { sourceSegmentId: 12, semanticUnitId: 'u12', relation: 'semantic_unit' },
      ],
      'cue_merge',
    )

    expect(merged).toEqual([
      { sourceSegmentId: 10, semanticUnitId: 'u10', relation: 'cue_merge' },
      { sourceSegmentId: 11, semanticUnitId: 'u11', relation: 'cue_merge' },
      { sourceSegmentId: 12, semanticUnitId: 'u12', relation: 'cue_merge' },
    ])
  })
})

describe('buildSourceSegmentEvidence', () => {
  it('keeps raw and corrected transcript evidence once per source segment', () => {
    const evidence = buildSourceSegmentEvidence([{
      id: 3,
      start: 1,
      end: 2,
      text: 'ASR raw',
      correctedText: 'ASR corrected',
      words: [{ word: 'ASR', start: 1, end: 1.5, score: 0.9 }],
      correctionDistance: 0.2,
      correctionFlagged: true,
    }])

    expect(evidence).toEqual([{
      sourceSegmentId: 3,
      start: 1,
      end: 2,
      rawTranscript: 'ASR raw',
      correctedTranscript: 'ASR corrected',
      words: [{ word: 'ASR', start: 1, end: 1.5, score: 0.9 }],
      correctionDistance: 0.2,
      correctionFlagged: true,
    }])
  })
})
