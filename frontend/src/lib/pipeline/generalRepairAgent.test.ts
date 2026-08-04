import { afterEach, describe, expect, it, vi } from 'vitest'

import { getDefaultAdminSettings } from '@/api/adminSettings'
import type { AdminSettings } from '@/types/adminSettings'
import type { EnBlock, PipelineThresholds } from './blockTypes'
import { hasHardMetricRegression, partitionRewritesBySafety, runGeneralRepairAgent } from './generalRepairAgent'
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

/**
 * runGeneralRepairAgent は coverage（sourceTextLexicalOverlap の重なり率）を一切引数に取らない。
 * 過去はこの重なり率の低さも起動条件に含めていたため、correctJa 等で意図的に書き換えられた
 * 日本語を「欠落」と誤認して不要な repair を走らせてしまっていた（sourceTextLexicalOverlap.ts
 * 冒頭コメント参照）。ここでは「block 単位の violation だけが起動条件である」ことを、
 * LLM 呼出の有無（fetch が呼ばれたかどうか）で検証する。
 */
describe('runGeneralRepairAgent の起動条件（coverage を判断材料にしない）', () => {
  function settings(overrides: Partial<AdminSettings> = {}): AdminSettings {
    return {
      ...getDefaultAdminSettings(),
      translationProvider: 'openai',
      openaiApiKey: 'sk-test',
      generalRepairEnabled: true,
      ...overrides,
    }
  }

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('全 block が制約を満たしていれば（＝重なり率が低いだけの状態相当）LLM を一切呼ばない', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const blocks = [
      block({ id: 1, jaText: '短くなった原文の断片', enText: 'A short line.', cps: 5, violation: 'ok' }),
      block({ id: 2, jaText: '別の断片', enText: 'Another short line.', cps: 6, violation: 'ok' }),
    ]

    const result = await runGeneralRepairAgent(blocks, settings(), thresholds)

    expect(fetchMock).not.toHaveBeenCalled()
    expect(result.enabled).toBe(true)
    expect(result.initialViolatingBlocks).toBe(0)
    expect(result.finalViolatingBlocks).toBe(0)
    expect(result.entries).toHaveLength(0)
    expect(result.blocks).toBe(blocks)
  })

  it('block 単位の violation があれば従来どおり LLM を呼び出す', async () => {
    const rewriteResponse = new Response(
      JSON.stringify({
        choices: [{
          finish_reason: 'stop',
          message: {
            content: JSON.stringify({
              rationale: 'shortened to fit cps',
              rewrites: [{ block_id: 9, en: 'Shorter line.' }],
            }),
            refusal: null,
          },
        }],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
    const fetchMock = vi.fn(async () => rewriteResponse)
    vi.stubGlobal('fetch', fetchMock)

    const blocks = [
      block({
        id: 9,
        jaText: '関数として使うことはできないと、',
        enText: "BatchNorm has learnable parameters, so it can't be used functionally as a plain stateless transformation.",
        cps: 19.0,
        violation: 'verbose_en',
      }),
    ]

    const result = await runGeneralRepairAgent(blocks, settings(), thresholds, ['low'])

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0].blocksTargetedIds).toEqual([9])
  })
})
