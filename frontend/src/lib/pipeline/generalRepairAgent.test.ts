import { describe, expect, it } from 'vitest'

import type { EnBlock, PipelineThresholds } from './blockTypes'
import { hasHardMetricRegression, partitionRewritesBySafety } from './generalRepairAgent'
import { countCpsChars } from '../subtitleMetrics'

const thresholds: PipelineThresholds = {
  shortDurationSec: 1.5,
  longDurationSec: 10,
  mergedLongDurationSec: 7,
  overCompressedRatio: 0.25,
  overCompressedJaChars: 15,
  verboseEnRatio: 1.5,
  verboseCps: 16.9,
  maxLineLen: 80,
  slowCps: 3,
  maxExpandPerBlock: 3,
  maxCompressPerBlock: 5,
  maxPhase2Retries: 3,
}

function block(partial: Partial<EnBlock> & Pick<EnBlock, 'id' | 'jaText' | 'enText' | 'cps'>): EnBlock {
  const { id, jaText, enText, cps, ...rest } = partial
  return {
    id,
    start: 0,
    end: 4,
    jaText,
    jaChars: jaText.length,
    enText,
    enRaw: enText,
    enChars: countCpsChars(enText),
    cps,
    maxLineLen: Math.max(...enText.split('\n').map(line => line.length)),
    violation: 'verbose_en',
    alignConf: 'exact',
    merged: false,
    expandCount: 0,
    compressCount: 0,
    ...rest,
  }
}

describe('hasHardMetricRegression', () => {
  it('rejects a rewrite that turns a within-CPS block into a CPS violation', () => {
    const before = [
      block({
        id: 9,
        jaText: '関数として使うことはできないと、',
        enText: "so it can't be used as a plain function.",
        cps: 11.1,
      }),
    ]
    const after = [
      block({
        id: 9,
        jaText: '関数として使うことはできないと、',
        enText: "BatchNorm has learnable parameters, so it can't be used functionally.",
        cps: 19.0,
      }),
    ]

    expect(hasHardMetricRegression(before, after, [9], thresholds)).toBe(true)
  })

  it('allows a rewrite that remains within hard CPS and total character constraints', () => {
    const before = [
      block({
        id: 9,
        jaText: '関数として使うことはできないと、',
        enText: "so you can't use them as plain functions.",
        cps: 11.1,
      }),
    ]
    const after = [
      block({
        id: 9,
        jaText: '関数として使うことはできないと、',
        enText: "so it can't be used as a function.",
        cps: 9.4,
      }),
    ]

    expect(hasHardMetricRegression(before, after, [9], thresholds)).toBe(false)
  })

  it('allows line-length regression that final formatting can wrap within total character budget', () => {
    const before = [
      block({
        id: 100,
        jaText: 'くるモデルの出力というのを一番確',
        enText: 'The model output that comes out as a probability distribution is',
        cps: 15.0,
        enChars: 60,
        maxLineLen: 69,
      }),
    ]
    const after = [
      block({
        id: 100,
        jaText: 'くるモデルの出力というのを一番確',
        enText: 'The output distribution is taken as the class with the highest predicted probability.',
        cps: 14.0,
        enChars: 73,
        maxLineLen: 85,
      }),
    ]

    expect(hasHardMetricRegression(before, after, [100], thresholds)).toBe(false)
  })
})

describe('partitionRewritesBySafety', () => {
  it('keeps rewrites that improve or stay within hard constraints, drops only the regressing ones', () => {
    const before = [
      block({ id: 1, jaText: 'ja1', enText: 'safe block one', cps: 5 }),
      block({ id: 2, jaText: 'ja2', enText: 'safe block two', cps: 6 }),
      block({ id: 3, jaText: 'ja3', enText: 'safe block three', cps: 7 }),
    ]
    const after = [
      // id 1: improved (CPS 5 -> 4) - keep
      block({ id: 1, jaText: 'ja1', enText: 'better one', cps: 4 }),
      // id 2: hard regression (CPS 6 -> 18, was within, now over) - drop
      block({ id: 2, jaText: 'ja2', enText: 'verbose dense overflowing text that breaches CPS limit hard', cps: 18.0 }),
      // id 3: still OK (CPS 7 -> 9) - keep
      block({ id: 3, jaText: 'ja3', enText: 'slightly longer text', cps: 9 }),
    ]
    const rewrites = [
      { blockId: 1, jaSpan: 'ja1', en: 'better one' },
      { blockId: 2, jaSpan: 'ja2', en: 'verbose dense overflowing text that breaches CPS limit hard' },
      { blockId: 3, jaSpan: 'ja3', en: 'slightly longer text' },
    ]

    const { safe, dropped } = partitionRewritesBySafety(before, after, rewrites, thresholds)
    expect(safe.map(r => r.blockId)).toEqual([1, 3])
    expect(dropped.map(d => d.blockId)).toEqual([2])
    expect(dropped[0].reason).toMatch(/cps/i)
  })

  it('drops rewrites that exceed the per-segment character budget when before was within', () => {
    const before = [block({ id: 5, jaText: 'ja', enText: 'short', cps: 4, enChars: 5 })]
    // maxLineLen = 80, so maxSegmentChars = 160. Make after exceed 160.
    const longText = 'x'.repeat(170)
    const after = [block({ id: 5, jaText: 'ja', enText: longText, cps: 4, enChars: 170 })]
    const rewrites = [{ blockId: 5, jaSpan: 'ja', en: longText }]

    const { safe, dropped } = partitionRewritesBySafety(before, after, rewrites, thresholds)
    expect(safe).toHaveLength(0)
    expect(dropped).toHaveLength(1)
    expect(dropped[0].reason).toMatch(/chars/i)
  })

  it('keeps everything when no block has hard regression', () => {
    const before = [
      block({ id: 1, jaText: 'ja', enText: 'a', cps: 4 }),
      block({ id: 2, jaText: 'ja', enText: 'b', cps: 5 }),
    ]
    const after = [
      block({ id: 1, jaText: 'ja', enText: 'a2', cps: 4 }),
      block({ id: 2, jaText: 'ja', enText: 'b2', cps: 5 }),
    ]
    const rewrites = [
      { blockId: 1, jaSpan: 'ja', en: 'a2' },
      { blockId: 2, jaSpan: 'ja', en: 'b2' },
    ]
    const { safe, dropped } = partitionRewritesBySafety(before, after, rewrites, thresholds)
    expect(safe).toHaveLength(2)
    expect(dropped).toHaveLength(0)
  })
})
