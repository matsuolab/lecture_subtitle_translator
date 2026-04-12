import { describe, it, expect } from 'vitest'
import { parseNumbered, mergeWithFallback, formatNumberedInput } from '../utils/numberedParse'

describe('parseNumbered', () => {
  it('正常なレスポンスをパースする', () => {
    const input = '[1] こんにちは\n[2] ありがとう\n[3] さようなら'
    const result = parseNumbered(input)
    expect(result).toHaveLength(3)
    expect(result[0]).toEqual({ id: 1, text: 'こんにちは' })
    expect(result[1]).toEqual({ id: 2, text: 'ありがとう' })
    expect(result[2]).toEqual({ id: 3, text: 'さようなら' })
  })

  it('ID が抜けていてもエラーにならない', () => {
    const input = '[1] text1\n[3] text3'
    const result = parseNumbered(input)
    expect(result).toHaveLength(2)
    expect(result.map(e => e.id)).toEqual([1, 3])
  })

  it('同じ ID が重複した場合は最初のものだけ使う', () => {
    const input = '[1] first\n[1] second'
    const result = parseNumbered(input)
    expect(result).toHaveLength(1)
    expect(result[0].text).toBe('first')
  })

  it('余分なテキストや空行を無視する', () => {
    const input = 'Here are the translations:\n[1] Hello\n\n[2] World\n\nDone.'
    const result = parseNumbered(input)
    expect(result).toHaveLength(2)
  })

  it('テキストのトリミングをする', () => {
    const input = '[1]   spaces   '
    const result = parseNumbered(input)
    expect(result[0].text).toBe('spaces')
  })
})

describe('mergeWithFallback', () => {
  it('LLM が返さなかった ID は元テキストで補完する', () => {
    const originals = new Map([[1, 'original1'], [2, 'original2'], [3, 'original3']])
    const response = '[1] translated1\n[3] translated3'
    const result = mergeWithFallback(originals, response)
    expect(result.get(1)).toBe('translated1')
    expect(result.get(2)).toBe('original2')  // フォールバック
    expect(result.get(3)).toBe('translated3')
  })
})

describe('formatNumberedInput', () => {
  it('[id] text 形式に変換する', () => {
    const texts = new Map([[1, 'テキスト1'], [2, 'テキスト2']])
    const result = formatNumberedInput(texts)
    expect(result).toBe('[1] テキスト1\n[2] テキスト2')
  })
})
