import { describe, expect, it } from 'vitest'
import type { AdminSettings } from '@/types/adminSettings'
import {
  DEFAULT_LANGUAGE_PROFILE_CONFIG,
  DEFAULT_LANGUAGE_PROFILE_CONFIG_JSON,
  hasContinuationEnd,
  hasFragmentStart,
  hasSentenceEnd,
  loadLanguageProfileConfig,
  resolveTargetCharMatcher,
} from './languageProfileConfig'

function makeSettings(overrides: Partial<AdminSettings> = {}): AdminSettings {
  return {
    subtitleLanguageLabel: 'English',
    transcriptLanguageLabel: 'Japanese',
    languageProfileConfigJson: '',
    ...overrides,
  } as AdminSettings
}

describe('loadLanguageProfileConfig — 既定（日本語→英語）', () => {
  it('JSON 空欄・既定ラベルでは DEFAULT 構成と一致する', () => {
    const config = loadLanguageProfileConfig(makeSettings())
    expect(config).toEqual(DEFAULT_LANGUAGE_PROFILE_CONFIG)
  })
})

describe('loadLanguageProfileConfig — ラベルから script と作法を導出（バグ①の本丸）', () => {
  it('英語→日本語: JSON 空欄でも字幕=japanese / 書きおこし=latin になる', () => {
    const config = loadLanguageProfileConfig(
      makeSettings({ subtitleLanguageLabel: 'Japanese', transcriptLanguageLabel: 'English' }),
    )
    expect(config.subtitle.script).toBe('japanese')
    expect(config.subtitle.sentenceEndPattern).toBe('[。！？!?]$')
    expect(config.transcript.script).toBe('latin')
    expect(config.transcript.sentenceEndPattern).toBe('[.!?]$')
  })

  it('日本語ラベルの別表記（日本語）でも japanese と判定する', () => {
    const config = loadLanguageProfileConfig(makeSettings({ subtitleLanguageLabel: '日本語' }))
    expect(config.subtitle.script).toBe('japanese')
  })

  it('未知ラベルは generic にフォールバックする', () => {
    const config = loadLanguageProfileConfig(makeSettings({ subtitleLanguageLabel: 'Klingon' }))
    expect(config.subtitle.script).toBe('generic')
  })
})

describe('loadLanguageProfileConfig — JSON の明示指定が最優先（中国語などの作法注入）', () => {
  it('JSON で script と translatedCharPattern を明示するとラベル導出より優先される', () => {
    const profileJson = JSON.stringify({
      subtitle: {
        label: '中文',
        script: 'generic',
        translatedCharPattern: '[\\u4e00-\\u9fff]',
        sentenceEndPattern: '[。！？]$',
      },
      transcript: { label: 'English', script: 'latin' },
    })
    const config = loadLanguageProfileConfig(
      makeSettings({ subtitleLanguageLabel: '中文', transcriptLanguageLabel: 'English', languageProfileConfigJson: profileJson }),
    )
    expect(config.subtitle.script).toBe('generic')
    expect(config.subtitle.translatedCharPattern).toBe('[\\u4e00-\\u9fff]')
    expect(config.subtitle.sentenceEndPattern).toBe('[。！？]$')
  })
})

describe('loadLanguageProfileConfig — 既知ラベルは古い JSON の矛盾 script を上書きする（保存済みプロジェクト救済）', () => {
  it('ラベル=Japanese なら、JSON に subtitle.script=latin が残っていても japanese になる', () => {
    // ラベル切替前に保存された旧プロジェクト（簡易UIは日本語字幕だが JSON は英日のまま）を再現
    const staleJson = JSON.stringify({
      subtitle: { label: 'English', script: 'latin', sentenceEndPattern: '[.!?]$' },
      transcript: { label: 'Japanese', script: 'japanese', sentenceEndPattern: '[。！？!?]$' },
    })
    const config = loadLanguageProfileConfig(
      makeSettings({ subtitleLanguageLabel: 'Japanese', transcriptLanguageLabel: 'English', languageProfileConfigJson: staleJson }),
    )
    expect(config.subtitle.script).toBe('japanese')
    expect(config.transcript.script).toBe('latin')
  })

  // script だけでなく作法パターンもラベルへ追従しなければならない。
  // 本番既定は languageProfileConfigJson に英日構成が「事前充填」されているため、
  // ラベルだけ入れ替えた利用者は必ずこのケースを踏む（#en-ja Phase0）。
  it('ラベルを英→日へ入れ替えたら作法パターンもラベル側へ追従する', () => {
    const config = loadLanguageProfileConfig(
      makeSettings({
        subtitleLanguageLabel: 'Japanese',
        transcriptLanguageLabel: 'English',
        languageProfileConfigJson: DEFAULT_LANGUAGE_PROFILE_CONFIG_JSON,
      }),
    )
    // 字幕=日本語: 句点で文末判定できないと contextMergeFragments が正常字幕を断片扱いする
    expect(config.subtitle.script).toBe('japanese')
    expect(config.subtitle.sentenceEndPattern).toBe('[。！？!?]$')
    expect(config.subtitle.continuationEndPattern).toBe('[、,]$')
    // 英語専用の断片開始パターン（^[a-z] / This・That…）を日本語字幕へ持ち込まない
    expect(config.subtitle.fragmentStartPattern).toBeUndefined()
    // 書きおこし=英語
    expect(config.transcript.script).toBe('latin')
    expect(config.transcript.sentenceEndPattern).toBe('[.!?]$')
    expect(config.transcript.continuationEndPattern).toBe('[,;:]$')
  })

  it('JSON の label と有効ラベルが一致する場合は JSON の明示パターンを尊重する', () => {
    // 「日本語字幕向けに作法を自分で調整した」ケース。stale ではないので捨ててはいけない。
    const customJson = JSON.stringify({
      subtitle: { label: 'Japanese', script: 'japanese', sentenceEndPattern: '[。]$' },
      transcript: { label: 'English', script: 'latin' },
    })
    const config = loadLanguageProfileConfig(
      makeSettings({
        subtitleLanguageLabel: 'Japanese',
        transcriptLanguageLabel: 'English',
        languageProfileConfigJson: customJson,
      }),
    )
    expect(config.subtitle.sentenceEndPattern).toBe('[。]$')
  })

  it('JSON に label が無い場合は明示指定として扱う（ラベル未記載の手書きJSON救済）', () => {
    const noLabelJson = JSON.stringify({
      subtitle: { sentenceEndPattern: '[。]$' },
    })
    const config = loadLanguageProfileConfig(
      makeSettings({ subtitleLanguageLabel: 'Japanese', languageProfileConfigJson: noLabelJson }),
    )
    expect(config.subtitle.sentenceEndPattern).toBe('[。]$')
  })
})

describe('作法パターンは大文字小文字を区別する', () => {
  const subtitle = DEFAULT_LANGUAGE_PROFILE_CONFIG.subtitle

  // 'i' フラグを固定で付けていた時期は `^[a-z]` が大文字にもマッチし、英字で始まる
  // 英語字幕が事実上すべて断片判定されていた（過剰な文脈マージの原因）。
  it('小文字始まりだけを断片開始として扱う', () => {
    expect(hasFragmentStart('and then we apply softmax.', subtitle)).toBe(true)
    expect(hasFragmentStart('We compute the gradient.', subtitle)).toBe(false)
    expect(hasFragmentStart('Gradients flow backward.', subtitle)).toBe(false)
  })

  it('先頭が既知の文脈依存語なら大文字始まりでも断片開始として扱う', () => {
    expect(hasFragmentStart('This is the same as before.', subtitle)).toBe(true)
    expect(hasFragmentStart('These are the weights.', subtitle)).toBe(true)
    expect(hasFragmentStart('Using this rule, we get...', subtitle)).toBe(true)
  })

  it('文末・継続パターンは記号のみなのでフラグ変更の影響を受けない', () => {
    expect(hasSentenceEnd('We compute the gradient.', subtitle)).toBe(true)
    expect(hasSentenceEnd('We compute the gradient', subtitle)).toBe(false)
    expect(hasContinuationEnd('first we compute the loss,', subtitle)).toBe(true)
  })

  it('日本語字幕の文末判定も従来どおり動く', () => {
    const jaSubtitle = { label: 'Japanese', script: 'japanese' as const, sentenceEndPattern: '[。！？!?]$' }
    expect(hasSentenceEnd('これは誤差逆伝播法です。', jaSubtitle)).toBe(true)
    expect(hasSentenceEnd('これは誤差逆伝播法です', jaSubtitle)).toBe(false)
  })
})

describe('resolveTargetCharMatcher', () => {
  function ratio(text: string, matcher: RegExp | null): number {
    if (!matcher) return 0
    const nonSpace = [...text].filter((c) => c.trim())
    return (text.match(matcher) ?? []).length / nonSpace.length
  }

  it('latin: 英字を拾う', () => {
    const m = resolveTargetCharMatcher({ label: 'English', script: 'latin' })
    expect(ratio('Hello', m)).toBeGreaterThan(0.9)
    expect(ratio('これは', m)).toBe(0)
  })

  it('japanese: かな・漢字を拾う', () => {
    const m = resolveTargetCharMatcher({ label: 'Japanese', script: 'japanese' })
    expect(ratio('これは東京', m)).toBeGreaterThan(0.9)
    expect(ratio('Hello', m)).toBe(0)
  })

  it('translatedCharPattern を明示するとそれを使う（中国語の漢字レンジ）', () => {
    const m = resolveTargetCharMatcher({ label: '中文', script: 'generic', translatedCharPattern: '[\\u4e00-\\u9fff]' })
    expect(ratio('我们使用', m)).toBeGreaterThan(0.9)
    expect(ratio('Hello', m)).toBe(0)
  })

  it('generic でパターン無しは null（検知不可）', () => {
    expect(resolveTargetCharMatcher({ label: 'Klingon', script: 'generic' })).toBeNull()
  })
})
