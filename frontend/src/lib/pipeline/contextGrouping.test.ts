import { describe, expect, it } from 'vitest'
import type { JaBlock } from './blockTypes'
import { assignContextGroupsFromFlags, reindexContextGroups } from './contextGrouping'

const groupingSettings = {
  pipelineMergeContinuationMaxGapSec: 0.5,
  pipelineMergeContinuationMaxDurationSec: 7,
  pipelineMergeContinuationMaxTranscriptChars: 80,
}

function block(id: number, start: number, end: number, jaText: string): JaBlock {
  return {
    id,
    start,
    end,
    jaText,
    jaChars: jaText.length,
    alignConf: 'exact',
  }
}

describe('contextGrouping', () => {
  it('groups an incomplete cue with the next cue without merging display timings', () => {
    const blocks = [
      block(1, 0, 2, '今回の目的としては、'),
      block(2, 2.1, 5, '最適化を理解することです。'),
      block(3, 6, 8, '次に進みます。'),
    ]

    const grouped = assignContextGroupsFromFlags(blocks, [true, false, false], groupingSettings)

    expect(grouped).toHaveLength(3)
    expect(grouped[0].start).toBe(0)
    expect(grouped[0].end).toBe(2)
    expect(grouped[1].start).toBe(2.1)
    expect(grouped[1].end).toBe(5)
    expect(grouped[0].contextGroupId).toBe('cg-1-2')
    expect(grouped[1].contextGroupId).toBe('cg-1-2')
    expect(grouped[0].contextGroupRole).toBe('lead')
    expect(grouped[1].contextGroupRole).toBe('tail')
    expect(grouped[0].contextGroupText).toBe('今回の目的としては、 最適化を理解することです。')
    expect(grouped[2].contextGroupId).toBe('cg-3')
  })

  it('keeps singleton groups when grouping would exceed duration constraints', () => {
    const blocks = [
      block(1, 0, 6, '今回の目的としては、'),
      block(2, 6.1, 10, '最適化を理解することです。'),
    ]

    const grouped = assignContextGroupsFromFlags(blocks, [true, false], groupingSettings)

    expect(grouped[0].contextGroupId).toBe('cg-1')
    expect(grouped[1].contextGroupId).toBe('cg-2')
    expect(grouped[0].contextGroupRole).toBe('single')
  })

  it('reindexes context group roles after display-cue resplitting or short merges', () => {
    const grouped = assignContextGroupsFromFlags(
      [
        block(1, 0, 2, 'A'),
        block(2, 2, 4, 'B'),
        block(3, 4, 6, 'C'),
      ],
      [true, true, false],
      groupingSettings,
    )

    const reindexed = reindexContextGroups(grouped)

    expect(reindexed.map(b => b.contextGroupRole)).toEqual(['lead', 'middle', 'tail'])
    expect(reindexed.every(b => b.contextGroupSize === 3)).toBe(true)
  })
})
