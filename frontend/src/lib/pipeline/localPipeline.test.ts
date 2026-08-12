import { describe, expect, it } from 'vitest'

import { normalizeSnapshotItems } from './localPipeline'

describe('normalizeSnapshotItems', () => {
  it('preserves agent summaries and entries before block snapshots', () => {
    const items = normalizeSnapshotItems({
      enabled: true,
      initialViolatingBlocks: 12,
      finalViolatingBlocks: 9,
      attemptedEfforts: ['low'],
      blocks: [
        {
          id: 1,
          start: 1,
          end: 3,
          jaText: 'テスト',
          enText: 'Test',
          violation: 'ok',
        },
      ],
      entries: [
        {
          attempt: 1,
          effort: 'low',
          status: 'llm_error',
          errorMessage: 'general_repair fetch failed: Load failed',
          promptTokens: 100,
          completionTokens: 0,
        },
      ],
    })

    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({
      _kind: 'summary',
      enabled: true,
      initialViolatingBlocks: 12,
      finalViolatingBlocks: 9,
      attemptedEfforts: ['low'],
    })
    expect(items[0]).not.toHaveProperty('blocks')
    expect(items[0]).not.toHaveProperty('entries')
    expect(items[1]).toMatchObject({
      _kind: 'entry',
      attempt: 1,
      effort: 'low',
      status: 'llm_error',
      errorMessage: 'general_repair fetch failed: Load failed',
      promptTokens: 100,
      completionTokens: 0,
    })
  })

  it('preserves cue source references in block snapshots', () => {
    const [item] = normalizeSnapshotItems([{
      id: 1,
      jaText: '入力',
      sourceRefs: [{ sourceSegmentId: 9, semanticUnitId: 'u9', relation: 'semantic_unit' }],
    }])

    expect(item.sourceRefs).toEqual([
      { sourceSegmentId: 9, semanticUnitId: 'u9', relation: 'semantic_unit' },
    ])
  })

  it('preserves split timing evidence in correction attempt snapshots', () => {
    const [item] = normalizeSnapshotItems([{
      id: 2,
      jaText: '分割後の入力',
      correctionAttempts: [{
        strategy: 'split_block',
        changed: true,
        beforeChars: 80,
        afterChars: 75,
        beforeViolation: 'long_segment',
        afterViolation: 'ok',
        splitTiming: {
          basis: 'asr_constrained',
          matchRates: [0.95, 0.9],
          boundaryDeltasSec: [0.08],
        },
      }],
    }])

    expect(item.correctionAttempts).toEqual([
      expect.objectContaining({
        strategy: 'split_block',
        splitTiming: {
          basis: 'asr_constrained',
          matchRates: [0.95, 0.9],
          boundaryDeltasSec: [0.08],
        },
      }),
    ])
  })
})
