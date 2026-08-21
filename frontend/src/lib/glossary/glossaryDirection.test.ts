import { describe, expect, it } from 'vitest'

import { getDefaultAdminSettings } from '@/api/adminSettings'
import type { AdminSettings } from '@/types/adminSettings'

import { resolveGlossaryPromptDirection } from './glossaryDirection'

/**
 * 簡易UI 相当の言語ラベル設定を作る。
 * loadLanguageProfileConfig は subtitleLanguageLabel / transcriptLanguageLabel を
 * JSON より優先するため、利用者が実際に触る経路と同じものをテストする。
 */
function settingsWithLanguages(subtitleLabel: string, transcriptLabel: string): AdminSettings {
  return {
    ...getDefaultAdminSettings(),
    subtitleLanguageLabel: subtitleLabel,
    transcriptLanguageLabel: transcriptLabel,
  }
}

describe('resolveGlossaryPromptDirection', () => {
  it('既定設定では日本語書きおこし → 英語字幕として解決する', () => {
    const direction = resolveGlossaryPromptDirection(getDefaultAdminSettings())

    expect(direction.roles).toEqual({ subtitle: 'en', transcript: 'ja' })
    expect(direction.transcriptLanguage).toBe('日本語')
    expect(direction.subtitleLanguage).toBe('英語')
    expect(direction.isDefaultDirection).toBe(true)
  })

  it('既定構成では ja に書きおこし言語、en に字幕言語が割り当たる', () => {
    const direction = resolveGlossaryPromptDirection(getDefaultAdminSettings())

    expect(direction.jaLanguage).toBe('日本語')
    expect(direction.enLanguage).toBe('英語')
  })

  it('英→日構成では ja/en の役割が入れ替わる', () => {
    const direction = resolveGlossaryPromptDirection(settingsWithLanguages('Japanese', 'English'))

    expect(direction.roles).toEqual({ subtitle: 'ja', transcript: 'en' })
    expect(direction.transcriptLanguage).toBe('英語')
    expect(direction.subtitleLanguage).toBe('日本語')
    expect(direction.isDefaultDirection).toBe(false)
  })

  it('英→日構成では ja が字幕言語、en が書きおこし言語を保持する', () => {
    const direction = resolveGlossaryPromptDirection(settingsWithLanguages('Japanese', 'English'))

    // フィールド名は内部互換のため据え置き、格納される言語だけが入れ替わる。
    expect(direction.jaLanguage).toBe('日本語')
    expect(direction.enLanguage).toBe('英語')
  })

  it('未知言語ラベルは正規化せず利用者の指定をそのまま使う', () => {
    const direction = resolveGlossaryPromptDirection(settingsWithLanguages('Français', 'English'))

    // subtitle.script が japanese ではないため役割は既定のまま。
    expect(direction.roles).toEqual({ subtitle: 'en', transcript: 'ja' })
    expect(direction.subtitleLanguage).toBe('Français')
    expect(direction.transcriptLanguage).toBe('英語')
  })

  it('壊れた言語プロファイル JSON では既定方向へフォールバックする', () => {
    const direction = resolveGlossaryPromptDirection({
      ...getDefaultAdminSettings(),
      languageProfileConfigJson: '{ not valid json',
    })

    expect(direction.roles).toEqual({ subtitle: 'en', transcript: 'ja' })
    expect(direction.isDefaultDirection).toBe(true)
  })
})
