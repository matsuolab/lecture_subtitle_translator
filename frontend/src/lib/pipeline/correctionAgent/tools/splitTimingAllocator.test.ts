import { describe, expect, it } from 'vitest'

import { allocateSplitTiming } from './splitTimingAllocator'

describe('allocateSplitTiming', () => {
  it('空unitや不正な親時間・gap・CPSでは時刻を捏造せずnullを返す', () => {
    const base = {
      parent: { id: 0, start: 0, end: 10, jaText: '親字幕' },
      units: [
        { jaText: '前半字幕', enText: 'First subtitle' },
        { jaText: '後半字幕', enText: 'Second subtitle' },
      ],
      script: 'japanese' as const,
      gapMs: 80,
      maxClosableGapSec: 0.5,
      subtitleMinDurationSec: 0.833,
      shortDurationSec: 1.5,
      verboseCps: 17,
    }

    expect(allocateSplitTiming({ ...base, units: [] })).toBeNull()
    expect(allocateSplitTiming({ ...base, parent: { ...base.parent, start: 10, end: 10 } })).toBeNull()
    expect(allocateSplitTiming({ ...base, gapMs: -1 })).toBeNull()
    expect(allocateSplitTiming({ ...base, verboseCps: 0 })).toBeNull()
  })

  it('wordsがない旧データは従来の英語文字数比を維持する', () => {
    const result = allocateSplitTiming({
      parent: {
        id: 1,
        start: 10,
        end: 20,
        jaText: '前半の説明です。後半の説明です。',
      },
      units: [
        { jaText: '前半の説明です。', enText: 'A'.repeat(60) },
        { jaText: '後半の説明です。', enText: 'B'.repeat(20) },
      ],
      script: 'japanese',
      gapMs: 80,
      maxClosableGapSec: 0.5,
      subtitleMinDurationSec: 0.833,
      shortDurationSec: 1.5,
      verboseCps: 17,
    })

    expect(result?.decision).toEqual({
      basis: 'english_weighted_fallback',
      fallbackReason: 'no_words',
      displayRanges: [
        { start: 10, end: 17.024 },
        { start: 17.104, end: 20 },
      ],
    })
    expect(result?.units).toEqual([
      { start: 10, end: 17.024, alignConf: 'no_words' },
      { start: 17.104, end: 20, alignConf: 'no_words' },
    ])
  })

  it('ASR一致がpartialなら時刻と親wordsを従来方式のまま維持する', () => {
    const parentWords = Array.from('全く異なる元音声です').map((word, index) => ({
      word,
      start: index * 0.5,
      end: (index + 1) * 0.5,
      score: 1,
    }))
    const result = allocateSplitTiming({
      parent: {
        id: 2,
        start: 0,
        end: 10,
        jaText: '全く異なる元音声です',
        words: parentWords,
      },
      units: [
        { jaText: '対応しない前半文章です。', enText: 'A'.repeat(60) },
        { jaText: '対応しない後半文章です。', enText: 'B'.repeat(20) },
      ],
      script: 'japanese',
      gapMs: 80,
      maxClosableGapSec: 0.5,
      subtitleMinDurationSec: 0.833,
      shortDurationSec: 1.5,
      verboseCps: 17,
    })

    expect(result?.decision).toEqual(expect.objectContaining({
      basis: 'english_weighted_fallback',
      fallbackReason: 'asr_not_exact',
      matchRates: [0.273, 0],
    }))
    expect(result?.units.every(unit => unit.words === undefined)).toBe(true)
    expect(result?.units.every(unit => unit.alignConf === 'proportional')).toBe(true)
  })

  it('ASR境界ではCPSを守れない場合、表示制約を満たす最寄り境界へ投影する', () => {
    const leftJa = '前半の説明文章です'
    const rightJa = '後半の説明文章です'
    const jaText = `${leftJa}${rightJa}`
    const words = Array.from(jaText).map((word, index) => ({
      word,
      start: index * 0.25,
      end: (index + 1) * 0.25,
      score: 1,
    }))
    const result = allocateSplitTiming({
      parent: { id: 3, start: 0, end: 8, jaText, words },
      units: [
        { jaText: leftJa, enText: 'A'.repeat(51) },
        { jaText: rightJa, enText: 'B'.repeat(34) },
      ],
      script: 'japanese',
      gapMs: 80,
      maxClosableGapSec: 0.5,
      subtitleMinDurationSec: 0.833,
      shortDurationSec: 1.5,
      verboseCps: 17,
    })

    expect(result?.decision.basis).toBe('asr_constrained')
    expect(result?.units[0].end).toBe(3)
    expect(result?.units[1].start).toBe(3.08)
    expect(51 / ((result?.units[0].end ?? 0) - (result?.units[0].start ?? 0))).toBeLessThanOrEqual(17)
    expect(result?.units.every(unit => unit.alignConf === 'exact')).toBe(true)
  })

  it('必要表示時間が小数ミリ秒でSRT上は成立しない場合、ASR採用成功と誤判定しない', () => {
    const texts = ['前半説明です', '後半説明です']
    const words = Array.from(texts.join('')).map((word, index) => ({
      word,
      start: index * 0.1,
      end: (index + 1) * 0.1,
      score: 1,
    }))
    const parentEnd = 2 * (27 / 17) + 0.08
    const result = allocateSplitTiming({
      parent: { id: 31, start: 0, end: parentEnd, jaText: texts.join(''), words },
      units: texts.map(jaText => ({ jaText, enText: 'A'.repeat(27) })),
      script: 'japanese',
      gapMs: 80,
      maxClosableGapSec: 0.5,
      subtitleMinDurationSec: 0.833,
      shortDurationSec: 1.5,
      verboseCps: 17,
    })

    expect(result?.decision).toEqual(expect.objectContaining({
      basis: 'english_weighted_fallback',
      fallbackReason: 'constraints_infeasible',
    }))
  })

  it('ASR境界を制約内へ置けない場合、splitを失敗させず従来方式へ戻す', () => {
    const jaText = '前半の説明文章です後半の説明文章です'
    const words = Array.from(jaText).map((word, index) => ({
      word,
      start: index * 0.1,
      end: (index + 1) * 0.1,
      score: 1,
    }))
    const result = allocateSplitTiming({
      parent: { id: 4, start: 0, end: 2.5, jaText, words },
      units: [
        { jaText: '前半の説明文章です', enText: 'A'.repeat(30) },
        { jaText: '後半の説明文章です', enText: 'B'.repeat(30) },
      ],
      script: 'japanese',
      gapMs: 80,
      maxClosableGapSec: 0.5,
      subtitleMinDurationSec: 0.833,
      shortDurationSec: 1.5,
      verboseCps: 17,
    })

    expect(result?.decision).toEqual(expect.objectContaining({
      basis: 'english_weighted_fallback',
      fallbackReason: 'constraints_infeasible',
      matchRates: [1, 1],
    }))
    expect(result?.units).toHaveLength(2)
    expect(result?.units.every(unit => unit.words === undefined)).toBe(true)
  })

  it('3分割でも長いASR無音と親外周を守り、wordsを互いに重ならない範囲へ分ける', () => {
    const texts = ['前半説明です', '中央説明です', '後半説明です']
    const timedWords = [
      ...Array.from(texts[0]).map((word, index) => ({ word, start: index * 0.2, end: (index + 1) * 0.2, score: 1 })),
      ...Array.from(texts[1]).map((word, index) => ({ word, start: 2 + index * 0.2, end: 2 + (index + 1) * 0.2, score: 1 })),
      ...Array.from(texts[2]).map((word, index) => ({ word, start: 3.2 + index * 0.2, end: 3.2 + (index + 1) * 0.2, score: 1 })),
    ]
    const result = allocateSplitTiming({
      parent: { id: 5, start: 0, end: 8, jaText: texts.join(''), words: timedWords },
      units: texts.map((jaText, index) => ({ jaText, enText: String.fromCharCode(65 + index).repeat(20) })),
      script: 'japanese',
      gapMs: 80,
      maxClosableGapSec: 0.5,
      subtitleMinDurationSec: 0.833,
      shortDurationSec: 1.5,
      verboseCps: 17,
    })

    expect(result?.decision.basis).toBe('asr_constrained')
    expect(result?.units).toHaveLength(3)
    expect(result?.units[0].start).toBe(0)
    expect(result?.units[2].end).toBe(8)
    expect((result?.units[1].start ?? 0) - (result?.units[0].end ?? 0)).toBeGreaterThan(0.5)
    expect((result?.units[2].start ?? 0) - (result?.units[1].end ?? 0)).toBeCloseTo(0.08, 3)
    expect(result?.units.every(unit => unit.words && unit.words.length > 0)).toBe(true)
    expect(result?.units[0].words?.at(-1)?.end).toBeLessThanOrEqual(result?.units[1].words?.[0]?.start ?? 0)
    expect(result?.units[1].words?.at(-1)?.end).toBeLessThanOrEqual(result?.units[2].words?.[0]?.start ?? 0)
  })
})
