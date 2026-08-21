import { describe, expect, it } from 'vitest'

import { checkSeamOnlySplit } from './seamOnlySplitCheck'

describe('checkSeamOnlySplit', () => {
  it('継ぎ目だけ書き換えた2分割は split_ok になる', () => {
    const orig = '本日はこの新しいアルゴリズムについてご説明しておりますので、後ほど演習を行います'
    const result = checkSeamOnlySplit(orig, [
      '本日はこの新しいアルゴリズムについてご説明しております。',
      '後ほど演習を行います',
    ])
    expect(result.classification).toBe('split_ok')
  })

  it('本文を言い換えた分割は rewritten_outside_seam になる', () => {
    const orig = '本日はこの新しいアルゴリズムについてご説明しておりますので、後ほど演習を行います'
    const result = checkSeamOnlySplit(orig, [
      '今日は新しい手法についてお話しします。',
      '後ほど演習を行います',
    ])
    expect(result.classification).toBe('rewritten_outside_seam')
  })

  it('原文の末尾が落ちた分割は tail_dropped になる', () => {
    // 最後のユニットは原文の対応区間とちゃんと一致しているが、原文にはその先に
    // 「皆さんよろしくお願いいたします」が残っており、どのユニットにも含まれていない。
    const orig = '本日はこの新しいアルゴリズムについてご説明しておりますので、後ほど演習を行います。皆さんよろしくお願いいたします'
    const result = checkSeamOnlySplit(orig, [
      '本日はこの新しいアルゴリズムについてご説明しております。',
      '後ほど演習を行います',
    ])
    expect(result.classification).toBe('tail_dropped')
  })

  it('3分割で全ユニットが継ぎ目のみの修正なら split_ok になる', () => {
    const orig = 'まず前提を確認しまして、次に手法を説明し、最後に結果をまとめます'
    const result = checkSeamOnlySplit(orig, [
      'まず前提を確認します。',
      '次に手法を説明し。',
      '最後に結果をまとめます',
    ])
    expect(result.classification).toBe('split_ok')
  })

  it('ユニットが1個以下なら refused として扱う', () => {
    expect(checkSeamOnlySplit('本日はよろしくお願いします', []).classification).toBe('refused')
    expect(checkSeamOnlySplit('本日はよろしくお願いします', ['本日はよろしくお願いします']).classification).toBe('refused')
  })
})
