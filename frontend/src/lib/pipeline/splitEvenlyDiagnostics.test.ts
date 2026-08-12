import { describe, expect, it } from 'vitest'
import type { EnBlock, PipelineThresholds } from './blockTypes'
import { analyzeSplitEvenlyCandidates } from './splitEvenlyDiagnostics'
import { countCpsChars } from '../subtitleMetrics'

const thresholds: PipelineThresholds = {
  shortDurationSec: 1.5,
  longDurationSec: 10,
  mergedLongDurationSec: 7,
  overCompressedRatio: 0.25,
  overCompressedJaChars: 15,
  verboseCps: 17,
  maxLineLen: 80,
  slowCps: 3,
  maxExpandPerBlock: 3,
  maxCompressPerBlock: 5,
}

function block(id: number, start: number, end: number, jaText: string, enText: string): EnBlock {
  const chars = countCpsChars(enText)
  return {
    id,
    start,
    end,
    jaText,
    jaChars: jaText.length,
    alignConf: 'proportional',
    enText,
    enRaw: enText,
    enChars: chars,
    cps: chars / (end - start),
    maxLineLen: enText.length,
    violation: 'proportional_ts',
    expandCount: 0,
    compressCount: 0,
  }
}

describe('analyzeSplitEvenlyCandidates', () => {
  it('reports the former split-evenly candidate without mutating either cue', () => {
    const blocks = [
      block(16, 73.696, 76.18, '関数の入力出力の次元数', 'We need the input and output dimensions of the function,'),
      block(17, 76.26, 84.252, 'というのが必要なので、', 'so'),
    ]
    const before = structuredClone(blocks)

    const result = analyzeSplitEvenlyCandidates(blocks, thresholds)

    expect(blocks).toEqual(before)
    expect(result.candidateCount).toBe(1)
    expect(result.observations[0]).toMatchObject({
      leftId: 16,
      rightId: 17,
      strategy: 'split_evenly',
    })
    expect(result.observations[0].candidateLeftText).not.toBe(blocks[0].enText)
    expect(result).not.toHaveProperty('blocks')
    expect(result).not.toHaveProperty('appliedCount')
  })
})
