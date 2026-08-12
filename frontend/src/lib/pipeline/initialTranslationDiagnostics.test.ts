import { describe, expect, it } from 'vitest'
import type { EnBlock } from './blockTypes'
import { analyzeInitialTranslations } from './initialTranslationDiagnostics'

function block(id: number, jaText: string, enText: string): EnBlock {
  return {
    id,
    start: id,
    end: id + 2,
    jaText,
    jaChars: jaText.length,
    alignConf: 'exact',
    enText,
    enRaw: enText,
    enChars: enText.length,
    cps: enText.length / 2,
    maxLineLen: enText.length,
    violation: 'ok',
    expandCount: 0,
    compressCount: 0,
  }
}

describe('analyzeInitialTranslations', () => {
  it('summarizes observations without mutating the translated blocks', () => {
    const blocks = [
      block(1, '3回まで再試行します。', 'Retries are allowed.'),
      block(2, '通常の説明です。', 'This is a normal explanation.'),
    ]
    const before = structuredClone(blocks)

    const result = analyzeInitialTranslations(blocks, [])

    expect(blocks).toEqual(before)
    expect(result).toMatchObject({
      totalBlocks: 2,
      observedBlockCount: 1,
      riskBandCounts: { none: 1, low: 0, medium: 0, high: 1 },
    })
    expect(result.observations[0]).toMatchObject({ blockId: 1, riskBand: 'high' })
    expect(result).not.toHaveProperty('ok')
  })

  it('does not inflate review counts with identity glossary entries or English ordinals', () => {
    const blocks = [
      block(1, '学習を行います。', 'We train the model.'),
      block(2, '第7章です。', 'This is the seventh chapter.'),
    ]

    const result = analyzeInitialTranslations(blocks, ['学習 => 学習'])

    expect(result).toMatchObject({
      totalBlocks: 2,
      observedBlockCount: 0,
      riskBandCounts: { none: 2, low: 0, medium: 0, high: 0 },
    })
  })
})
