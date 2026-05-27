import { describe, expect, it } from 'vitest'
import type { EnBlock, PipelineThresholds } from './blockTypes'
import { cpsReliefRebalance } from './cpsReliefRebalance'
import { countCpsChars } from '../subtitleMetrics'

const thresholds: PipelineThresholds = {
  shortDurationSec: 1.5,
  longDurationSec: 10,
  mergedLongDurationSec: 7,
  overCompressedRatio: 0.25,
  overCompressedJaChars: 15,
  verboseEnRatio: 1.5,
  verboseCps: 17,
  maxLineLen: 80,
  slowCps: 3,
  maxExpandPerBlock: 3,
  maxCompressPerBlock: 5,
  maxPhase2Retries: 3,
}

interface BlockSeed {
  id: number
  start: number
  end: number
  jaText: string
  enText: string
  contextGroupId?: string
  contextGroupRole?: 'single' | 'lead' | 'middle' | 'tail'
  contextGroupSize?: number
  contextGroupIndex?: number
}

function block(seed: BlockSeed): EnBlock {
  const enChars = countCpsChars(seed.enText)
  const duration = Math.max(0.001, seed.end - seed.start)
  return {
    id: seed.id,
    start: seed.start,
    end: seed.end,
    jaText: seed.jaText,
    jaChars: seed.jaText.replace(/\s/g, '').length,
    alignConf: 'proportional',
    enText: seed.enText,
    enRaw: seed.enText,
    enChars,
    cps: Math.round((enChars / duration) * 10) / 10,
    maxLineLen: Math.max(...seed.enText.split('\n').map(line => line.length)),
    violation: 'proportional_ts',
    expandCount: 0,
    compressCount: 0,
    contextGroupId: seed.contextGroupId ?? `cg-${seed.id}`,
    contextGroupRole: seed.contextGroupRole ?? 'single',
    contextGroupSize: seed.contextGroupSize ?? 1,
    contextGroupIndex: seed.contextGroupIndex ?? 0,
    contextGroupSourceIds: [seed.id],
  }
}

describe('cpsReliefRebalance', () => {
  it('applies approach A (retime only) when adjacent pair has unbalanced timing but reasonable text', () => {
    // id 26+27 type: two separate sentences, A's redistribution gives both within limits
    const blocks = [
      block({
        id: 26,
        start: 118.139,
        end: 120.177, // duration 2.038s, 35 chars, CPS 17.2 (over)
        jaText: 'モデル自体の出力次元数ですね。',
        enText: 'the output dimension of the model itself.',
        contextGroupId: 'cg-26',
      }),
      block({
        id: 27,
        start: 120.257,
        end: 121.885, // duration 1.628s, 21 chars, CPS 12.9
        jaText: '最後ソフトマックスが出ます。',
        enText: 'Softmax comes at the end.',
        contextGroupId: 'cg-27',
      }),
    ]

    const result = cpsReliefRebalance(blocks, thresholds)

    expect(result.entries).toHaveLength(1)
    expect(result.entries[0]).toMatchObject({
      strategy: 'retime_only',
      leftId: 26,
      rightId: 27,
      status: 'applied',
    })
    // left should now have enough duration for CPS to be within limit
    const left = result.blocks.find(b => b.id === 26)!
    const right = result.blocks.find(b => b.id === 27)!
    expect(left.cps).toBeLessThanOrEqual(thresholds.verboseCps)
    expect(right.cps).toBeLessThanOrEqual(thresholds.verboseCps)
    // text unchanged
    expect(left.enText).toBe('the output dimension of the model itself.')
    expect(right.enText).toBe('Softmax comes at the end.')
    // boundary moved (left.end ≈ left.start + minDuration)
    expect(left.end).toBeGreaterThan(120.177) // original left.end
    expect(right.start).toBeGreaterThan(120.257) // original right.start
    // alignConf upgraded so subsequent classify treats it by actual CPS
    expect(left.alignConf).toBe('merged')
    expect(right.alignConf).toBe('merged')
  })

  it('falls back to approach C (split evenly) when approach A would create awkward short-text display', () => {
    // id 16+17 type: left has dense text (47 chars), right has tiny text ("so") with 7.99s
    // A would leave "so" displayed for 7.7s — awkward
    // C splits combined text at a natural boundary
    const blocks = [
      block({
        id: 16,
        start: 73.696,
        end: 76.18, // duration 2.484s, 47 chars, CPS 18.9
        jaText: '関数の入力出力の次元数',
        enText: 'We need the input and output dimensions of the function,',
        contextGroupId: 'cg-16',
      }),
      block({
        id: 17,
        start: 76.26,
        end: 84.252, // duration 7.992s, 2 chars, CPS 0.3
        jaText: 'というのが必要なので、',
        enText: 'so',
        contextGroupId: 'cg-17-18',
        contextGroupRole: 'lead',
        contextGroupSize: 2,
      }),
    ]

    const result = cpsReliefRebalance(blocks, thresholds)

    expect(result.entries).toHaveLength(1)
    expect(result.entries[0].strategy).toBe('split_evenly')
    expect(result.entries[0].status).toBe('applied')

    const left = result.blocks.find(b => b.id === 16)!
    const right = result.blocks.find(b => b.id === 17)!
    // both should now have OK CPS
    expect(left.cps).toBeLessThanOrEqual(thresholds.verboseCps)
    expect(right.cps).toBeLessThanOrEqual(thresholds.verboseCps)
    // text should be redistributed (left text should grow, right text should grow)
    expect(left.enText.length).toBeGreaterThan(10)
    expect(right.enText.length).toBeGreaterThan(5)
    // total content preserved (no character loss)
    const combinedBefore = 'We need the input and output dimensions of the function, so'
    const combinedAfter = `${left.enText} ${right.enText}`.replace(/\s+/g, ' ').trim()
    expect(combinedAfter).toBe(combinedBefore)
    // alignConf upgraded
    expect(left.alignConf).toBe('merged')
    expect(right.alignConf).toBe('merged')
  })

  it('skips pairs where the combined CPS would still exceed the threshold', () => {
    // Both cues with dense text — merging can't help
    const blocks = [
      block({
        id: 1,
        start: 0,
        end: 2.0, // 60 chars, CPS 30 (way over)
        jaText: 'これは非常に密度の高い字幕です。',
        enText: 'This is an extremely dense subtitle line that overflows badly',
        contextGroupId: 'cg-1',
      }),
      block({
        id: 2,
        start: 2.1,
        end: 4.0, // 55 chars, CPS 29
        jaText: 'これも密度が高い字幕です。',
        enText: 'And this neighbor is also packed with extra wordy content',
        contextGroupId: 'cg-2',
      }),
    ]

    const result = cpsReliefRebalance(blocks, thresholds)
    // No rebalance applied (combined CPS still over)
    expect(result.entries.filter(e => e.status === 'applied')).toHaveLength(0)
  })

  it('skips pairs separated by a large gap (likely scene change or pause)', () => {
    const blocks = [
      block({
        id: 1,
        start: 0,
        end: 2.0,
        jaText: '前の発話。',
        enText: 'Previous utterance with too much content packed here',
        contextGroupId: 'cg-1',
      }),
      block({
        id: 2,
        start: 6.0, // 4 second gap
        end: 8.0,
        jaText: '次の発話。',
        enText: 'Next utterance after pause.',
        contextGroupId: 'cg-2',
      }),
    ]

    const result = cpsReliefRebalance(blocks, thresholds)
    expect(result.entries.filter(e => e.status === 'applied')).toHaveLength(0)
  })

  it('does not apply rebalance when neither cue has a CPS issue', () => {
    const blocks = [
      block({
        id: 1,
        start: 0,
        end: 3.0,
        jaText: '普通の字幕。',
        enText: 'Normal subtitle.',
        contextGroupId: 'cg-1',
      }),
      block({
        id: 2,
        start: 3.1,
        end: 6.0,
        jaText: 'もう一つ。',
        enText: 'Another normal one.',
        contextGroupId: 'cg-2',
      }),
    ]

    const result = cpsReliefRebalance(blocks, thresholds)
    expect(result.entries).toHaveLength(0)
    expect(result.blocks[0].end).toBe(3.0)
    expect(result.blocks[1].start).toBe(3.1)
  })
})
