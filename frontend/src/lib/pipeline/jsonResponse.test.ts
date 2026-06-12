import { describe, expect, it } from 'vitest'
import { parseJsonObjectFromLlmContent } from './jsonResponse'

describe('parseJsonObjectFromLlmContent', () => {
  it('正常なJSONオブジェクトをそのまま返す', () => {
    expect(parseJsonObjectFromLlmContent('{"translations":["a","b"]}', 'test')).toEqual({
      translations: ['a', 'b'],
    })
  })

  it('コードフェンス付きJSONを剥がして返す', () => {
    const content = '```json\n{"translations":["a"]}\n```'
    expect(parseJsonObjectFromLlmContent(content, 'test')).toEqual({ translations: ['a'] })
  })

  it('閉じ括弧が欠けたJSONを補完して返す', () => {
    expect(parseJsonObjectFromLlmContent('{"translations":["a","b"', 'test')).toEqual({
      translations: ['a', 'b'],
    })
  })

  it('配列の ] を書かず } で閉じたJSONを修復して返す（Gemma E2Bの実出力パターン）', () => {
    // T7計測ランで観測: {"translations":["...,"} と ] を飛ばして } だけで閉じる
    const content = '{"translations":["The main goal is to build on the fundamentals,"}'
    expect(parseJsonObjectFromLlmContent(content, 'test')).toEqual({
      translations: ['The main goal is to build on the fundamentals,'],
    })
  })

  it('ネストした閉じ括弧の不一致も修復して返す', () => {
    const content = '{"groups":[{"id":"g1","translations":["a","b"}]}'
    expect(parseJsonObjectFromLlmContent(content, 'test')).toEqual({
      groups: [{ id: 'g1', translations: ['a', 'b'] }],
    })
  })

  it('配列要素間のカンマ欠落を修復して返す（Gemma E2Bの実出力パターン）', () => {
    // T7計測ランで観測: {"translations":["a" "b"]} とカンマを落とす
    const content = '{"translations":["Regarding what\'s good about this pooling now," "Pooling improves computational efficiency."]}'
    expect(parseJsonObjectFromLlmContent(content, 'test')).toEqual({
      translations: [
        "Regarding what's good about this pooling now,",
        'Pooling improves computational efficiency.',
      ],
    })
  })

  it('カンマ欠落と閉じ括弧欠落が同時でも修復して返す', () => {
    expect(parseJsonObjectFromLlmContent('{"translations":["a" "b"', 'test')).toEqual({
      translations: ['a', 'b'],
    })
  })

  it('エスケープされていない入れ子クオートを修復して返す（Gemma E2Bの実出力パターン）', () => {
    // T7計測ランで観測: 訳文中の引用符をエスケープせずに出力する
    const content = '{"translations":["I\'m giving an example of learning: "Spring is beautiful with cherry blossoms.""]}'
    expect(parseJsonObjectFromLlmContent(content, 'test')).toEqual({
      translations: ['I\'m giving an example of learning: "Spring is beautiful with cherry blossoms."'],
    })
  })

  it('入れ子クオート修復はカンマ欠落修復より優先されない（2要素のまま）', () => {
    expect(parseJsonObjectFromLlmContent('{"translations":["a" "b"]}', 'test')).toEqual({
      translations: ['a', 'b'],
    })
  })

  it('JSONを含まないテキストはエラーを投げる', () => {
    expect(() => parseJsonObjectFromLlmContent('plain text only', 'test')).toThrow(
      'test response was not valid JSON',
    )
  })

  it('文字列中の括弧は修復対象にしない', () => {
    expect(parseJsonObjectFromLlmContent('{"text":"a } b ] c"}', 'test')).toEqual({
      text: 'a } b ] c',
    })
  })
})
