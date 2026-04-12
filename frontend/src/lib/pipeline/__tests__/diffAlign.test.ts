import { describe, it, expect } from 'vitest'
import { findBestMatchingBlock, findTimeRange, findTimeRangeSequential } from '../utils/diffAlign'

describe('findBestMatchingBlock', () => {
  it('完全一致するサブ列を見つける', () => {
    const wordTokens = ['the', 'quick', 'brown', 'fox', 'jumps', 'over']
    const blockTokens = ['quick', 'brown', 'fox']
    const result = findBestMatchingBlock(wordTokens, blockTokens)
    expect(result).not.toBeNull()
    expect(result!.a).toBe(1)  // "quick" は wordTokens[1]
    expect(result!.size).toBe(3)
  })

  it('一致がなければ null を返す', () => {
    const wordTokens = ['hello', 'world']
    const blockTokens = ['foo', 'bar']
    const result = findBestMatchingBlock(wordTokens, blockTokens)
    expect(result).toBeNull()
  })

  it('複数一致がある場合は最長一致を返す', () => {
    const wordTokens = ['a', 'b', 'c', 'd', 'a', 'b']
    const blockTokens = ['a', 'b', 'c']
    const result = findBestMatchingBlock(wordTokens, blockTokens)
    expect(result!.size).toBe(3)
    expect(result!.a).toBe(0)  // 最長は先頭から
  })

  it('空配列は null を返す', () => {
    expect(findBestMatchingBlock([], ['a'])).toBeNull()
    expect(findBestMatchingBlock(['a'], [])).toBeNull()
  })
})

describe('findTimeRange', () => {
  const allWords = [
    { word: 'the', start: 0.0, end: 0.3 },
    { word: 'quick', start: 0.3, end: 0.7 },
    { word: 'brown', start: 0.7, end: 1.1 },
    { word: 'fox', start: 1.1, end: 1.4 },
    { word: 'jumps', start: 1.4, end: 1.9 },
  ]

  it('ブロックテキストに対応するタイムスタンプを返す', () => {
    const result = findTimeRange('quick brown fox', allWords)
    expect(result).not.toBeNull()
    expect(result!.start).toBeCloseTo(0.3)
    expect(result!.end).toBeCloseTo(1.4)
  })

  it('単語が一致しなければ null を返す', () => {
    const result = findTimeRange('hello world', allWords)
    expect(result).toBeNull()
  })

  it('allWords が空なら null を返す', () => {
    expect(findTimeRange('quick brown', [])).toBeNull()
  })

  it('大文字小文字を無視してマッチする', () => {
    const result = findTimeRange('The Quick', allWords)
    expect(result).not.toBeNull()
    expect(result!.start).toBeCloseTo(0.0)
  })
})

describe('findTimeRangeSequential', () => {
  const jaWords = [
    { word: '松尾', start: 0.0, end: 0.4 },
    { word: '研', start: 0.4, end: 0.6 },
    { word: 'の', start: 0.6, end: 0.7 },
    { word: '講義', start: 0.7, end: 1.1 },
    { word: 'へ', start: 1.1, end: 1.2 },
    { word: 'ようこそ', start: 1.2, end: 1.8 },
    { word: 'ありがとう', start: 2.0, end: 2.6 },
    { word: 'ございます', start: 2.6, end: 3.1 },
  ]

  it('日本語文に対応するタイムスタンプを返す', () => {
    const result = findTimeRangeSequential('松尾研の講義へようこそ', jaWords)
    expect(result).not.toBeNull()
    expect(result!.start).toBeCloseTo(0.0)
    expect(result!.end).toBeCloseTo(1.8)
  })

  it('複数文を順番に処理できる（searchFrom を使う）', () => {
    const r1 = findTimeRangeSequential('松尾研の講義', jaWords, 0)
    expect(r1).not.toBeNull()

    const r2 = findTimeRangeSequential('ありがとうございます', jaWords, r1!.nextSearchFrom)
    expect(r2).not.toBeNull()
    expect(r2!.start).toBeCloseTo(2.0)
    expect(r2!.end).toBeCloseTo(3.1)
  })

  it('マッチしなければ null を返す', () => {
    const result = findTimeRangeSequential('全然関係ない', jaWords)
    expect(result).toBeNull()
  })

  it('空配列は null を返す', () => {
    expect(findTimeRangeSequential('テスト', [])).toBeNull()
  })

  it('nextSearchFrom は最後にマッチした単語の次を指す', () => {
    const result = findTimeRangeSequential('松尾研', jaWords, 0)
    expect(result).not.toBeNull()
    expect(result!.nextSearchFrom).toBeGreaterThan(0)
  })
})
