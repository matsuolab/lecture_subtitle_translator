import { describe, it, expect, vi } from 'vitest'
import { splitJaNode } from '../nodes/splitJa'
import type { NodeContext } from '../nodeContract'
import type { CorrectedSegment } from '../types'

function makeCtx(): NodeContext {
  return {
    config: {} as NodeContext['config'],
    glossary: [],
    onProgress: vi.fn(),
    reportUsage: vi.fn(),
  }
}

function makeSeg(
  id: number,
  text: string,
  start: number,
  end: number,
  words: { word: string; start: number; end: number }[] = [],
): CorrectedSegment {
  return {
    correctedText: text,
    correctionDistance: 0,
    correctionFlagged: false,
    original: {
      id,
      start,
      end,
      text,
      words: words.map(w => ({ ...w, confidence: 1.0 })),
    },
  }
}

describe('splitJaNode', () => {
  it('句読点で文を分割する', async () => {
    const seg = makeSeg(1, 'こんにちは。ありがとう。', 0, 4)
    const result = await splitJaNode.run(
      { correctedSegments: [seg], splitHints: [], attempt: 1 },
      makeCtx(),
    )
    expect(result).toHaveLength(2)
    expect(result[0].jaText).toBe('こんにちは。')
    expect(result[1].jaText).toBe('ありがとう。')
  })

  it('単語タイムスタンプがある場合は exact でアライメントする', async () => {
    const seg = makeSeg(1, '松尾研の講義。', 0, 2, [
      { word: '松尾', start: 0.1, end: 0.5 },
      { word: '研', start: 0.5, end: 0.7 },
      { word: 'の', start: 0.7, end: 0.8 },
      { word: '講義', start: 0.8, end: 1.5 },
    ])
    const result = await splitJaNode.run(
      { correctedSegments: [seg], splitHints: [], attempt: 1 },
      makeCtx(),
    )
    expect(result[0].alignConfidence).toBe('exact')
    expect(result[0].start).toBeCloseTo(0.1)
  })

  it('単語タイムスタンプがない場合は proportional フォールバック', async () => {
    const seg = makeSeg(1, 'こんにちは。ありがとう。', 0, 4)
    const result = await splitJaNode.run(
      { correctedSegments: [seg], splitHints: [], attempt: 1 },
      makeCtx(),
    )
    expect(result[0].alignConfidence).toBe('proportional')
    expect(result[0].start).toBeCloseTo(0)
    expect(result[1].start).toBeCloseTo(2)
  })

  it('複数セグメントを結合して分割する', async () => {
    const segs = [
      makeSeg(1, 'こんにちは。', 0, 2),
      makeSeg(2, 'ありがとう。', 2, 4),
    ]
    const result = await splitJaNode.run(
      { correctedSegments: segs, splitHints: [], attempt: 1 },
      makeCtx(),
    )
    expect(result).toHaveLength(2)
  })

  it('SplitHint がある場合は該当範囲の文を句読点で細分化する', async () => {
    const seg = makeSeg(
      1,
      '松尾研の、すごい講義へ。ありがとう。',
      0,
      4,
      [
        { word: '松尾', start: 0.1, end: 0.4 },
        { word: '研', start: 0.4, end: 0.6 },
        { word: 'の', start: 0.6, end: 0.7 },
        { word: 'すごい', start: 0.7, end: 1.0 },
        { word: '講義', start: 1.0, end: 1.4 },
        { word: 'へ', start: 1.4, end: 1.5 },
        { word: 'ありがとう', start: 2.0, end: 2.8 },
      ],
    )
    // 最初の文（0〜1.5s）に CPS 違反があったと仮定
    const result = await splitJaNode.run(
      {
        correctedSegments: [seg],
        splitHints: [{ start: 0.0, end: 1.5, reason: 'cps_violation' }],
        attempt: 2,
      },
      makeCtx(),
    )
    // 「松尾研の、すごい講義へ。」が句読点で分割されるはず
    expect(result.length).toBeGreaterThan(2)
  })

  it('空テキストは空配列を返す', async () => {
    const seg = makeSeg(1, '', 0, 1)
    const result = await splitJaNode.run(
      { correctedSegments: [seg], splitHints: [], attempt: 1 },
      makeCtx(),
    )
    expect(result).toHaveLength(0)
  })
})
