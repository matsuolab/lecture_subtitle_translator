import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultAdminSettings } from '@/api/adminSettings'
import type { JaBlock } from './blockTypes'
import type { DetectionResult } from './detectIncompleteEnds'

const detectIncompleteEndsMock = vi.hoisted(() => vi.fn())
vi.mock('./detectIncompleteEnds', () => ({
  detectIncompleteEnds: detectIncompleteEndsMock,
}))

// vi.mock はホイストされるため、モック対象を import する側は必ずこの後に置く。
const { assignContextGroupsFromFlags, reindexContextGroups, contextGroupCueBlocks } = await import('./contextGrouping')

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

afterEach(() => {
  vi.resetAllMocks()
})

describe('contextGroupCueBlocks warning message', () => {
  it('describes a partial detection failure as an LLM-detection fallback with a per-kind breakdown, not "singleton context groups"', async () => {
    // 背景（本番事故）: 従来の文言は「N of M blocks fell back to singleton context groups」だったが、
    // LLM 判定が失敗しても決定的フォールバック（正規表現ベースの endsIncomplete 判定）を通るだけで、
    // 判定結果次第では複数キューのグループに入ることもあるため「singleton になる」は誤り。
    // また失敗の内訳（abortable/retryable/truncated/config_error）が集計1行にしか残らず、
    // 後から原因を追えなかった問題も合わせて検証する。
    const blocks = [
      block(1, 0, 2, '今回の目的としては、'),
      block(2, 2.1, 5, '最適化を理解することです。'),
    ]
    const detection: DetectionResult = {
      flags: [false, false],
      success: 0,
      failed: 2,
      deterministicFallbackCount: 2,
      failureKindCounts: { abortable: 0, retryable: 1, truncated: 1, config_error: 0 },
    }
    detectIncompleteEndsMock.mockResolvedValueOnce(detection)

    const warnings: string[] = []
    const settings = { ...getDefaultAdminSettings(), pipelineMergeContinuationEnabled: true }

    await contextGroupCueBlocks(blocks, settings, (_nodeId, message) => {
      warnings.push(message)
    })

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).not.toContain('singleton context groups')
    expect(warnings[0]).toContain('detection partial failure: 2 of 2')
    expect(warnings[0]).toContain('fell back to the deterministic sentence-end check')
    expect(warnings[0]).toContain('abortable=0')
    expect(warnings[0]).toContain('retryable=1')
    expect(warnings[0]).toContain('truncated=1')
    expect(warnings[0]).toContain('config_error=0')
  })

  it('includes the per-kind breakdown when detection aborts early', async () => {
    const blocks = [block(1, 0, 2, '今回の目的としては、')]
    const detection: DetectionResult = {
      flags: [false],
      success: 0,
      failed: 1,
      deterministicFallbackCount: 1,
      failureKindCounts: { abortable: 0, retryable: 0, truncated: 0, config_error: 1 },
      abortReason: 'HTTP 404: model not found',
    }
    detectIncompleteEndsMock.mockResolvedValueOnce(detection)

    const warnings: string[] = []
    const settings = { ...getDefaultAdminSettings(), pipelineMergeContinuationEnabled: true }

    await contextGroupCueBlocks(blocks, settings, (_nodeId, message) => {
      warnings.push(message)
    })

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('detection aborted: HTTP 404: model not found')
    expect(warnings[0]).toContain('config_error=1')
  })
})

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
