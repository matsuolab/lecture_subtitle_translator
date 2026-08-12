import { describe, expect, it } from 'vitest'
import type { CueSourceRef } from '@/types/sourceEvidence'
import type { EnBlock } from './blockTypes'
import { toSubtitleBlocks } from './toSubtitleBlocks'

function enBlock(sourceRefs: CueSourceRef[]): EnBlock & { sourceRefs: CueSourceRef[] } {
  return {
    id: 1,
    start: 2,
    end: 4,
    jaText: '入力です。',
    jaChars: 5,
    alignConf: 'exact',
    enText: 'This is input.',
    enRaw: 'This is input.',
    enChars: 12,
    cps: 6,
    maxLineLen: 12,
    violation: 'ok',
    expandCount: 0,
    compressCount: 0,
    sourceRefs,
  }
}

describe('toSubtitleBlocks source evidence transport', () => {
  it('keeps a cloned sourceRefs projection without changing subtitle content or timing', () => {
    const sourceRefs: CueSourceRef[] = [
      { sourceSegmentId: 7, semanticUnitId: 'u7', relation: 'semantic_unit' },
    ]

    const [result] = toSubtitleBlocks([enBlock(sourceRefs)])

    expect(result).toMatchObject({
      startTime: 2,
      endTime: 4,
      transcript: '入力です。',
      subtitle: 'This is input.',
      cps: 6,
      sourceRefs,
    })
    expect((result as { sourceRefs?: CueSourceRef[] }).sourceRefs).not.toBe(sourceRefs)
  })
})
