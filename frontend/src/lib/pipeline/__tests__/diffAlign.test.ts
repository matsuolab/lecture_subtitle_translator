import { describe, it, expect } from 'vitest'
import { findBestMatchingBlock, findTimeRange, findTimeRangeSequential, getOpcodes, buildCharTS, alignTimestamps } from '../utils/diffAlign'

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

describe('getOpcodes', () => {
  it('同一文字列は equal のみ', () => {
    const ops = getOpcodes('abc', 'abc')
    expect(ops).toEqual([['equal', 0, 3, 0, 3]])
  })

  it('delete: 文字削除', () => {
    const ops = getOpcodes('abc', 'ac')
    // 'b' が削除される
    const tags = ops.map(o => o[0])
    expect(tags).toContain('delete')
  })

  it('insert: 文字挿入', () => {
    const ops = getOpcodes('ac', 'abc')
    const tags = ops.map(o => o[0])
    expect(tags).toContain('insert')
  })

  it('replace: 誤字修正（ラーディング→ラーニング）', () => {
    const a = 'ディープラーディング'
    const b = 'ディープラーニング'
    const ops = getOpcodes(a, b)
    // equal部分とreplace/deleteが混在
    const tags = ops.map(o => o[0])
    expect(tags).toContain('equal') // 'ディープラー' は共通
    // 変更がある
    expect(tags.some(t => t !== 'equal')).toBe(true)
  })
})

describe('buildCharTS', () => {
  it('各単語の時間を文字数で均等分配する', () => {
    const words = [
      { word: 'ディープ', start: 0.0, end: 0.4 },
      { word: 'ラーニング', start: 0.4, end: 1.0 },
    ]
    const chars = buildCharTS(words)
    expect(chars.length).toBe(9) // 4 + 5
    expect(chars[0].char).toBe('デ')
    expect(chars[0].start).toBeCloseTo(0.0)
    expect(chars[4].char).toBe('ラ')
    expect(chars[4].start).toBeCloseTo(0.4)
  })
})

describe('alignTimestamps', () => {
  it('equal: TSをそのまま引き継ぐ', () => {
    const original = [
      { char: 'あ', start: 0.0, end: 0.1 },
      { char: 'い', start: 0.1, end: 0.2 },
    ]
    const aligned = alignTimestamps(original, 'あい')
    expect(aligned.length).toBe(2)
    expect(aligned[0].start).toBeCloseTo(0.0)
    expect(aligned[1].start).toBeCloseTo(0.1)
  })

  it('replace: 誤字修正後にTSが引き継がれる（ラーディング→ラーニング）', () => {
    // ASR生: "ディープラーディング" → 各文字に均等TS
    const words = [
      { word: 'ディープラーディング', start: 1.0, end: 2.0 },
    ]
    const rawChars = buildCharTS(words)
    // 補正後: "ディープラーニング"
    const aligned = alignTimestamps(rawChars, 'ディープラーニング')

    // 補正後テキストと同じ長さになる
    expect(aligned.length).toBe('ディープラーニング'.length)
    // 最初の文字 'デ' のTSは元の start に近い
    expect(aligned[0].start).toBeCloseTo(1.0, 1)
    // 最後の文字 'グ' のTSは元の end に近い
    const last = aligned[aligned.length - 1]
    expect(last.end).toBeGreaterThan(1.0)
    expect(last.end).toBeLessThanOrEqual(2.0 + 0.01)
  })

  it('insert: 句読点追加は直前のTSを使う', () => {
    const original = [
      { char: 'あ', start: 0.0, end: 0.5 },
    ]
    const aligned = alignTimestamps(original, 'あ。')
    expect(aligned.length).toBe(2)
    expect(aligned[1].char).toBe('。')
    // 句読点は直前文字のendを使う（duration=0）
    expect(aligned[1].start).toBeCloseTo(0.5)
    expect(aligned[1].end).toBeCloseTo(0.5)
  })
})
