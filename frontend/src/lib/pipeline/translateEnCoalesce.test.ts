import { describe, expect, it } from 'vitest'
import { __testing } from './translateEn'

describe('coalesceTranslations', () => {
  it('入力数と一致する翻訳はそのまま返す', () => {
    expect(__testing.coalesceTranslations(['a', 'b'], 2)).toEqual(['a', 'b'])
  })

  it('1入力に複数翻訳が返ったら結合して1件にする（T7で観測したGemma E2Bの実挙動）', () => {
    // "translation API returned 2 segments for 1 inputs" でラン全体が落ちるのを防ぐ
    expect(__testing.coalesceTranslations(['This corresponds to', 'a technique called Decay.'], 1)).toEqual([
      'This corresponds to a technique called Decay.',
    ])
  })

  it('複数入力で数が合わない場合はnull（バッチ半割リトライに委ねる）', () => {
    expect(__testing.coalesceTranslations(['a', 'b', 'c'], 2)).toBeNull()
    expect(__testing.coalesceTranslations(['a'], 2)).toBeNull()
  })

  it('1入力に空配列はnull', () => {
    expect(__testing.coalesceTranslations([], 1)).toBeNull()
  })
})
