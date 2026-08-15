import { describe, expect, it, vi } from 'vitest'
import { getDefaultAdminSettings } from '@/api/adminSettings'
import { DEFAULT_PIPELINE_THRESHOLDS, type EnBlock } from './blockTypes'
import { mergeContextFragments } from './contextMergeFragments'

vi.mock('./llmCallWithMeta', () => ({
  llmCallWithMeta: vi.fn(async () => ({
    content: JSON.stringify({
      decision: 'merge_prev',
      subtitle_text: 'This is complete.',
      transcript_text: 'これは完結します。',
      rationale: 'complete the fragment',
    }),
  })),
}))

function block(partial: Pick<EnBlock, 'id' | 'start' | 'end' | 'jaText' | 'enText' | 'sourceRefs'>): EnBlock {
  return {
    ...partial,
    jaChars: partial.jaText.length,
    alignConf: 'exact',
    enChars: partial.enText.length,
    cps: 5,
    maxLineLen: partial.enText.length,
    violation: 'ok',
    expandCount: 0,
    compressCount: 0,
    contextGroupId: 'cg-1',
  }
}

describe('mergeContextFragments source evidence transport', () => {
  it('stable-unions both cue origins when the LLM merge is accepted', async () => {
    const settings = { ...getDefaultAdminSettings(), openaiApiKey: 'test' }
    const result = await mergeContextFragments([
      block({
        id: 1, start: 0, end: 2, jaText: 'これは', enText: 'This begins.',
        sourceRefs: [{ sourceSegmentId: 1, semanticUnitId: 'u1', relation: 'semantic_unit' }],
      }),
      block({
        id: 2, start: 2.1, end: 4, jaText: '完結します', enText: 'and completes',
        sourceRefs: [{ sourceSegmentId: 2, semanticUnitId: 'u2', relation: 'overlong_split' }],
      }),
    ], settings, DEFAULT_PIPELINE_THRESHOLDS)

    expect(result).toHaveLength(1)
    expect(result[0].sourceRefs).toEqual([
      { sourceSegmentId: 1, semanticUnitId: 'u1', relation: 'cue_merge' },
      { sourceSegmentId: 2, semanticUnitId: 'u2', relation: 'cue_merge' },
    ])
  })
})
