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
})
