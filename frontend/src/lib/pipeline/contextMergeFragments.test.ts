import { describe, expect, it } from 'vitest'
import type { EnBlock } from './blockTypes'
import { DEFAULT_LANGUAGE_PROFILE_CONFIG, type LanguageProfileConfig } from './languageProfileConfig'
import { __testing } from './contextMergeFragments'

const { fragmentMaxChars, isContextDependentSubtitle, isContextMergeCandidate } = __testing

// 英→日構成。ラベル導出後のプロファイル（languageProfileConfig が返す形）を直接組む。
const EN_TO_JA_PROFILE: LanguageProfileConfig = {
  subtitle: {
    label: 'Japanese',
    script: 'japanese',
    sentenceEndPattern: '[。！？!?]$',
    continuationEndPattern: '[、,]$',
  },
  transcript: {
    label: 'English',
    script: 'latin',
    sentenceEndPattern: '[.!?]$',
    continuationEndPattern: '[,;:]$',
    fragmentStartPattern: '^[a-z]|^(This|That|It|These|Then|Also|Conversely|Especially|Using|In that case)\\b',
  },
}

function makeBlock(overrides: Partial<EnBlock> = {}): EnBlock {
  return {
    id: 1,
    start: 0,
    end: 3,
    jaText: '',
    jaChars: 0,
    alignConf: 'exact',
    enText: '',
    enRaw: '',
    enChars: 0,
    cps: 0,
    maxLineLen: 0,
    violation: 'ok',
    ...overrides,
  } as EnBlock
}

describe('fragmentMaxChars', () => {
  it('ラテン字幕は従来の 55 文字を維持する', () => {
    expect(fragmentMaxChars(DEFAULT_LANGUAGE_PROFILE_CONFIG.subtitle)).toBe(55)
  })

  it('日本語字幕は表意文字の情報密度に合わせて短い上限を使う', () => {
    expect(fragmentMaxChars(EN_TO_JA_PROFILE.subtitle)).toBe(24)
  })

  it('generic はラテン扱いにフォールバックする', () => {
    expect(fragmentMaxChars({ label: '中文', script: 'generic' })).toBe(55)
  })
})

describe('isContextDependentSubtitle — 英→日構成', () => {
  it('句点で終わる通常の日本語字幕は断片扱いしない', () => {
    // Phase0 修正前は subtitle.sentenceEndPattern に英語の [.!?]$ が残るため
    // この字幕が「文末なし＝断片」と誤判定され、過剰マージの原因になっていた。
    expect(isContextDependentSubtitle('これは誤差逆伝播法の説明です。', EN_TO_JA_PROFILE)).toBe(false)
  })

  it('「！」「？」で終わる日本語字幕も文末として扱う', () => {
    expect(isContextDependentSubtitle('これは本当に重要です！', EN_TO_JA_PROFILE)).toBe(false)
    expect(isContextDependentSubtitle('なぜでしょうか？', EN_TO_JA_PROFILE)).toBe(false)
  })

  it('文末記号が無く短い日本語字幕は断片として扱う', () => {
    expect(isContextDependentSubtitle('この関数を使って', EN_TO_JA_PROFILE)).toBe(true)
  })

  it('文末記号が無くても上限を超える長さなら断片扱いしない', () => {
    const long = 'あ'.repeat(25)
    expect(long.length).toBeGreaterThan(fragmentMaxChars(EN_TO_JA_PROFILE.subtitle))
    expect(isContextDependentSubtitle(long, EN_TO_JA_PROFILE)).toBe(false)
  })

  it('英語専用の断片開始パターンを日本語字幕へ適用しない', () => {
    // 書きおこし側（英語）の fragmentStartPattern が字幕側へ漏れていないことの確認。
    // 漏れていると "^[a-z]" が latin 混じりの日本語字幕を誤って断片にする。
    expect(EN_TO_JA_PROFILE.subtitle.fragmentStartPattern).toBeUndefined()
    expect(isContextDependentSubtitle('softmax関数を適用します。', EN_TO_JA_PROFILE)).toBe(false)
  })
})

describe('isContextDependentSubtitle — 既定（日→英）構成のリグレッション', () => {
  it('小文字始まりは断片として扱う', () => {
    expect(isContextDependentSubtitle('and then we apply softmax.', DEFAULT_LANGUAGE_PROFILE_CONFIG)).toBe(true)
  })

  it('This 始まりは断片として扱う', () => {
    expect(isContextDependentSubtitle('This is the same as before.', DEFAULT_LANGUAGE_PROFILE_CONFIG)).toBe(true)
  })

  it('ピリオドで終わる十分な長さの英語字幕は断片扱いしない', () => {
    expect(
      isContextDependentSubtitle(
        'We compute the gradient of the loss with respect to every parameter.',
        DEFAULT_LANGUAGE_PROFILE_CONFIG,
      ),
    ).toBe(false)
  })
})

describe('isContextMergeCandidate — 上限が字幕言語に追従する', () => {
  it('日本語字幕では 24 文字超の block をマージ候補から外す', () => {
    const block = makeBlock({ enText: 'あ'.repeat(30), jaText: 'some english source' })
    expect(isContextMergeCandidate(block, EN_TO_JA_PROFILE)).toBe(false)
  })

  it('日本語字幕で短く文末が無ければマージ候補になる', () => {
    const block = makeBlock({ enText: 'この関数を使って', jaText: 'using this function' })
    expect(isContextMergeCandidate(block, EN_TO_JA_PROFILE)).toBe(true)
  })

  it('書きおこし（英語）が読点系で終わる場合もマージ候補になる', () => {
    // transcript.continuationEndPattern = [,;:]$ が効くこと
    const block = makeBlock({ enText: '誤差を計算します。', jaText: 'we compute the error,' })
    expect(isContextMergeCandidate(block, EN_TO_JA_PROFILE)).toBe(true)
  })
})
