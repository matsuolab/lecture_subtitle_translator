import { describe, expect, it } from 'vitest'
import type { EnBlock } from './blockTypes'
import { checkTerminology } from './terminologyCheck'
import { countCpsChars } from '../subtitleMetrics'

function block(jaText: string, enText: string): EnBlock {
  return {
    id: 1,
    start: 0,
    end: 2,
    jaText,
    jaChars: jaText.length,
    alignConf: 'exact',
    enText,
    enChars: countCpsChars(enText),
    cps: countCpsChars(enText) / 2,
    maxLineLen: enText.length,
    violation: 'ok',
    expandCount: 0,
    compressCount: 0,
  }
}

describe('checkTerminology', () => {
  it('only reports glossary pairs whose source term appears in the transcript', () => {
    const result = checkTerminology(
      [
        block(
          'ニューラルネットワークの最適化について説明します。',
          'This explains neural network optimization.',
        ),
      ],
      [
        'ニューラルネットワーク => Neural Network Model',
        '教師あり学習 => Supervised Learning',
      ],
    )

    expect(result.ok).toBe(false)
    expect(result.misses).toEqual(['ニューラルネットワーク => Neural Network Model'])
  })

  it('does not treat unused dictionary entries as missing terms', () => {
    const result = checkTerminology(
      [block('最適化について説明します。', 'This explains optimization.')],
      ['教師あり学習 => Supervised Learning'],
    )

    expect(result.ok).toBe(true)
    expect(result.misses).toEqual([])
  })
})
