import { describe, it, expect } from 'vitest'
import { isEnglishLabel } from './dictionaryRegistry'

// 実際の辞書ロードは Vite アセット fetch でブラウザ実機検証する。
// ここではラベル→英語判定のルーティングのみを純粋に検証する。
describe('isEnglishLabel', () => {
  it('matches English labels', () => {
    expect(isEnglishLabel('English')).toBe(true)
    expect(isEnglishLabel('en')).toBe(true)
    expect(isEnglishLabel('en-US')).toBe(true)
    expect(isEnglishLabel('English (US)')).toBe(true)
  })

  it('does not match non-English / empty labels', () => {
    expect(isEnglishLabel('Japanese')).toBe(false)
    expect(isEnglishLabel('German')).toBe(false)
    expect(isEnglishLabel('')).toBe(false)
  })
})
