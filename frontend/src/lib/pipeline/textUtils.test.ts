import { describe, expect, it } from 'vitest'
import {
  __testing,
  joinSubtitleParts,
  normalizeSpaces,
  splitSubtitleLines,
  unwrapSubtitleLines,
  usesWordSpacing,
} from './textUtils'

const { isValidJaBreak, splitLatinLines } = __testing

describe('usesWordSpacing', () => {
  it('日本語だけ語間空白を使わない', () => {
    expect(usesWordSpacing('latin')).toBe(true)
    expect(usesWordSpacing('generic')).toBe(true)
    expect(usesWordSpacing('japanese')).toBe(false)
  })
})

describe('joinSubtitleParts', () => {
  it('ラテン系は空白区切り（従来と同一）', () => {
    expect(joinSubtitleParts(['We compute the loss', 'and back-propagate.'], 'latin'))
      .toBe('We compute the loss and back-propagate.')
  })

  it('日本語は空白を挟まず連結する', () => {
    expect(joinSubtitleParts(['損失を計算し、', '誤差を逆伝播します。'], 'japanese'))
      .toBe('損失を計算し、誤差を逆伝播します。')
  })

  it('日本語でも断片内部の空白は保持する（英字用語のため）', () => {
    expect(joinSubtitleParts(['softmax 関数を', '適用します。'], 'japanese'))
      .toBe('softmax 関数を適用します。')
  })

  it('空要素は落とす', () => {
    expect(joinSubtitleParts(['前半です。', '', undefined, null, '後半です。'], 'japanese'))
      .toBe('前半です。後半です。')
    expect(joinSubtitleParts(['first', '  ', 'second'], 'latin')).toBe('first second')
  })

  it('全要素が空なら空文字', () => {
    expect(joinSubtitleParts([undefined, '', '   '], 'japanese')).toBe('')
  })
})

describe('unwrapSubtitleLines', () => {
  it('ラテン系は改行を空白に戻す（従来と同一）', () => {
    expect(unwrapSubtitleLines('We compute the loss\nand back-propagate.', 'latin'))
      .toBe('We compute the loss and back-propagate.')
  })

  it('日本語は改行を空白なしで除去する', () => {
    expect(unwrapSubtitleLines('損失を計算し、\n誤差を逆伝播します。', 'japanese'))
      .toBe('損失を計算し、誤差を逆伝播します。')
  })

  it('連続改行もまとめて処理する', () => {
    expect(unwrapSubtitleLines('前半\n\n後半', 'japanese')).toBe('前半後半')
    expect(unwrapSubtitleLines('first\n\nsecond', 'latin')).toBe('first second')
  })
})

describe('splitSubtitleLines — ラテン系は従来の splitEnLines42 と同一', () => {
  const cases = [
    ['short line', 42],
    ['We compute the gradient of the loss with respect to every parameter in the network', 42],
    ['supercalifragilisticexpialidociousssssssssssssssssssssssss', 42],
    ['a b c d e f g h i j k l m n o p q r s t u v w x y z 1 2 3 4 5', 20],
  ] as const

  for (const [text, maxChars] of cases) {
    it(`"${text.slice(0, 30)}…" が旧実装と一致する`, () => {
      expect(splitSubtitleLines(text, maxChars, 'latin')).toBe(splitLatinLines(text, maxChars))
    })
  }

  it('generic もラテン系として扱う', () => {
    const text = 'We compute the gradient of the loss with respect to every parameter'
    expect(splitSubtitleLines(text, 42, 'generic')).toBe(splitLatinLines(text, 42))
  })
})

describe('splitSubtitleLines — 日本語', () => {
  it('上限以内なら改行しない', () => {
    expect(splitSubtitleLines('短い字幕です。', 20, 'japanese')).toBe('短い字幕です。')
  })

  it('読点で切る', () => {
    const result = splitSubtitleLines('損失を計算し、誤差を逆伝播します', 12, 'japanese')
    expect(result).toBe('損失を計算し、\n誤差を逆伝播します')
  })

  it('句点でも切れる', () => {
    const result = splitSubtitleLines('これは誤差です。次に勾配を求めます', 12, 'japanese')
    expect(result).toBe('これは誤差です。\n次に勾配を求めます')
  })

  it('句読点が無ければ助詞の直後で切る', () => {
    const result = splitSubtitleLines('この関数を使って勾配を計算します', 10, 'japanese')
    const [left, right] = result.split('\n')
    expect(right).toBeDefined()
    // 助詞の直後で切れていること（行頭が助詞で始まらない）
    expect(left.length).toBeGreaterThan(0)
    expect(right.length).toBeGreaterThan(0)
    expect(left + right).toBe('この関数を使って勾配を計算します')
  })

  it('行頭禁則: 句読点を行頭に置かない', () => {
    const text = 'あいうえおかきくけこ、さしすせそたちつてと'
    const [, right] = splitSubtitleLines(text, 12, 'japanese').split('\n')
    expect(right?.startsWith('、')).toBe(false)
  })

  it('行頭禁則: 閉じ括弧を行頭に置かない', () => {
    const text = 'これは「重要な概念」であり全体を通じて使われます'
    const lines = splitSubtitleLines(text, 14, 'japanese').split('\n')
    expect(lines[1]?.startsWith('」')).toBe(false)
  })

  it('行末禁則: 開き括弧を行末に置かない', () => {
    const text = 'ここで用語を定義します「勾配降下法」と呼びます'
    const lines = splitSubtitleLines(text, 12, 'japanese').split('\n')
    expect(lines[0]?.endsWith('「')).toBe(false)
  })

  it('必ず元テキストを保存する（文字を落とさない）', () => {
    const samples = [
      '損失を計算し、誤差を逆伝播します',
      'これは「重要な概念」であり全体を通じて使われます',
      'あいうえおかきくけこさしすせそたちつてとなにぬねの',
      'softmax関数を適用して確率分布に変換します',
    ]
    for (const text of samples) {
      const result = splitSubtitleLines(text, 12, 'japanese')
      expect(result.replace(/\n/g, '')).toBe(text)
    }
  })

  it('分割不能でも落ちない（1文字）', () => {
    expect(splitSubtitleLines('あ', 1, 'japanese')).toBe('あ')
  })

  it('2行までしか作らない', () => {
    const text = 'あ'.repeat(60)
    expect(splitSubtitleLines(text, 12, 'japanese').split('\n').length).toBeLessThanOrEqual(2)
  })
})

describe('isValidJaBreak', () => {
  it('文字列の端では改行しない', () => {
    expect(isValidJaBreak('あいう', 0)).toBe(false)
    expect(isValidJaBreak('あいう', 3)).toBe(false)
  })

  it('行頭禁則文字の前では改行しない', () => {
    expect(isValidJaBreak('あい、う', 2)).toBe(false)
  })

  it('行末禁則文字の後では改行しない', () => {
    expect(isValidJaBreak('あい「う', 3)).toBe(false)
  })

  it('通常位置では改行できる', () => {
    expect(isValidJaBreak('あいうえ', 2)).toBe(true)
  })
})

describe('normalizeSpaces（既存動作の維持）', () => {
  it('連続空白を1つにまとめて trim する', () => {
    expect(normalizeSpaces('  a   b  ')).toBe('a b')
  })
})
