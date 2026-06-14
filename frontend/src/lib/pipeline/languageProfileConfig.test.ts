import { describe, expect, it } from 'vitest'
import type { AdminSettings } from '@/types/adminSettings'
import {
  DEFAULT_LANGUAGE_PROFILE_CONFIG,
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
