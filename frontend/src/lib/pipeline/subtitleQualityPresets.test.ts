import { describe, expect, it } from 'vitest'
import type { AdminSettings } from '@/types/adminSettings'
import { getDefaultAdminSettings } from '@/api/adminSettings'
import { DEFAULT_LANGUAGE_PROFILE_CONFIG, type LanguageProfileConfig } from './languageProfileConfig'
import {
  SUBTITLE_QUALITY_PRESET_KEYS,
  diffSubtitleQualityPreset,
  resolveSubtitleQualityPreset,
  type SubtitleQualityPreset,
} from './subtitleQualityPresets'

const EN_TO_JA_LANGUAGES: LanguageProfileConfig = {
  subtitle: { label: 'Japanese', script: 'japanese' },
  transcript: { label: 'English', script: 'latin' },
}

function presetFor(languages: LanguageProfileConfig): SubtitleQualityPreset {
  const info = resolveSubtitleQualityPreset(languages)
  if (!info) throw new Error('preset not found')
  return info.preset
}

describe('resolveSubtitleQualityPreset', () => {
  it('日→英 構成を認識する', () => {
    const info = resolveSubtitleQualityPreset(DEFAULT_LANGUAGE_PROFILE_CONFIG)
    expect(info?.id).toBe('ja_to_en')
  })

  it('英→日 構成を認識する', () => {
    const info = resolveSubtitleQualityPreset(EN_TO_JA_LANGUAGES)
    expect(info?.id).toBe('en_to_ja')
  })

  it('推奨値を出せない組み合わせでは null を返す', () => {
    // 当てずっぽうの数値を提示しないための意図的な制限。
    expect(resolveSubtitleQualityPreset({
      subtitle: { label: '中文', script: 'generic' },
      transcript: { label: 'English', script: 'latin' },
    })).toBeNull()
    expect(resolveSubtitleQualityPreset({
      subtitle: { label: 'French', script: 'latin' },
      transcript: { label: 'English', script: 'latin' },
    })).toBeNull()
  })
})

describe('日→英 プレセットは現行の出荷既定値と一致する', () => {
  // ここが崩れると既存プロジェクトの品質判定が黙って変わるため、既定値と結びつけて固定する。
  it('getDefaultAdminSettings と全項目一致する', () => {
    const defaults = getDefaultAdminSettings()
    const preset = presetFor(DEFAULT_LANGUAGE_PROFILE_CONFIG)
    for (const key of SUBTITLE_QUALITY_PRESET_KEYS) {
      expect(preset[key], `${key} が既定値と一致しない`).toBe(defaults[key])
    }
  })

  it('既定設定に対する差分は空（適用済み扱い）', () => {
    const defaults = getDefaultAdminSettings()
    expect(diffSubtitleQualityPreset(defaults, presetFor(DEFAULT_LANGUAGE_PROFILE_CONFIG))).toEqual([])
  })
})

describe('英→日 プリセットの整合性', () => {
  const preset = presetFor(EN_TO_JA_LANGUAGES)

  it('日本語字幕は英語より行長・CPS が小さい', () => {
    const latin = presetFor(DEFAULT_LANGUAGE_PROFILE_CONFIG)
    expect(preset.enMaxCharsPerLine).toBeLessThan(latin.enMaxCharsPerLine)
    expect(preset.enMaxCps).toBeLessThan(latin.enMaxCps)
  })

  it('slowCps は上限 CPS より小さい（矛盾しない）', () => {
    expect(preset.pipelineSlowCps).toBeLessThan(preset.enMaxCps)
  })

  it('過圧縮閾値は冗長閾値より小さい（判定が交差しない）', () => {
    expect(preset.pipelineOverCompressedRatio).toBeLessThan(preset.pipelineVerboseEnRatio)
  })

  it('全項目が有限の正の数', () => {
    for (const key of SUBTITLE_QUALITY_PRESET_KEYS) {
      expect(Number.isFinite(preset[key]), `${key} が有限でない`).toBe(true)
      expect(preset[key], `${key} が正でない`).toBeGreaterThan(0)
    }
  })

  it('表示系は Netflix 日本語ガイドの規定値と一致する', () => {
    // poc/translate_demo.py Step 7 の JA_MAX_* と同じ値。
    // 過去に CPS を 8.0 へ引き上げた経緯があるため（commit 5ba94b7）、
    // ガイド準拠へ戻した意図が黙って失われないよう固定する。
    expect(preset.enMaxCps).toBe(4.0)
    expect(preset.enMaxCharsPerLine).toBe(13)
    expect(preset.enMaxLines).toBe(2)
    expect(preset.subtitleMinDurationSec).toBe(0.5)
  })
})

describe('diffSubtitleQualityPreset', () => {
  it('変更される項目だけを返す', () => {
    const settings = { ...getDefaultAdminSettings(), enMaxCps: 9.9 } as AdminSettings
    const diff = diffSubtitleQualityPreset(settings, presetFor(DEFAULT_LANGUAGE_PROFILE_CONFIG))
    expect(diff).toEqual([{ key: 'enMaxCps', current: 9.9, next: 16.9 }])
  })

  it('英→日 プリセットは既定（日→英）設定から複数項目を変更する', () => {
    const diff = diffSubtitleQualityPreset(getDefaultAdminSettings(), presetFor(EN_TO_JA_LANGUAGES))
    const keys = diff.map(entry => entry.key)
    expect(keys).toContain('enMaxCps')
    expect(keys).toContain('enMaxCharsPerLine')
    expect(keys).toContain('pipelineVerboseEnRatio')
    // 最小表示時間は Netflix 日本語ガイドの 500ms を採用しており、
    // 英語字幕の既定（833ms）とは異なるため差分に出る
    expect(keys).toContain('subtitleMinDurationSec')
    // 行数は言語によらず 2 行なので差分に出ない
    expect(keys).not.toContain('enMaxLines')
  })
})
