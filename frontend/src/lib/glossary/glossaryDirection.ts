/**
 * 用語抽出プロンプトの翻訳方向解決。
 *
 * 辞書エントリは ja/en の言語ペアで保持しているが、どちらが書きおこし（原文）で
 * どちらが字幕（訳文）かは翻訳方向で入れ替わる。照合側は既に
 * `resolveGlossaryRoles` (utils/glossaryApply.ts) で方向対応済みだが、抽出側は
 * プロンプトに「source=日本語、target=英語」と直書きされていた。
 *
 * 本モジュールは同じ `resolveGlossaryRoles` を再利用し、プロンプトに埋め込む
 * 言語名・フィールド説明文をそこから導出する。ja/en というフィールド名自体は
 * 内部互換のため据え置き、「どちらの言語が入るか」だけを方向で切り替える。
 */

import { loadLanguageProfileConfig } from '@/lib/pipeline/languageProfileConfig'
import { DEFAULT_GLOSSARY_ROLES, resolveGlossaryRoles, type GlossaryField, type GlossaryRoles } from '@/utils/glossaryApply'
import type { AdminSettings } from '@/types/adminSettings'

export interface GlossaryPromptDirection {
  /** 辞書フィールドの役割割り当て（字幕=訳文 / 書きおこし=原文）。 */
  roles: GlossaryRoles
  /** 書きおこし（原文）側の言語表示名。例: "日本語" / "English"。 */
  transcriptLanguage: string
  /** 字幕（訳文）側の言語表示名。 */
  subtitleLanguage: string
  /** `ja` フィールドに入る言語名。 */
  jaLanguage: string
  /** `en` フィールドに入る言語名。 */
  enLanguage: string
  /** 既定（日本語書きおこし → 英語字幕）構成かどうか。 */
  isDefaultDirection: boolean
}

/**
 * 言語プロファイルの label は利用者が自由に設定できる（"English" / "Japanese" のほか
 * "英語" など）。プロンプトに埋める際は日本語表記へ寄せた方が指示文と馴染むため、
 * 既知ラベルだけ正規化し、未知ラベルは利用者の指定をそのまま尊重する。
 */
const LANGUAGE_LABEL_ALIASES: Record<string, string> = {
  english: '英語',
  japanese: '日本語',
  chinese: '中国語',
  korean: '韓国語',
}

function normalizeLanguageLabel(label: string): string {
  const trimmed = label.trim()
  if (!trimmed) return ''
  return LANGUAGE_LABEL_ALIASES[trimmed.toLowerCase()] ?? trimmed
}

/** 役割 → その役割に割り当てられた言語名、の逆引き。 */
function languageForField(
  field: GlossaryField,
  roles: GlossaryRoles,
  transcriptLanguage: string,
  subtitleLanguage: string,
): string {
  return roles.transcript === field ? transcriptLanguage : subtitleLanguage
}

/**
 * 設定から用語抽出プロンプト用の方向情報を解決する。
 *
 * 未設定・未知言語では既定（書きおこし=日本語 / 字幕=英語）へフォールバックする。
 * これは `resolveGlossaryRoles` のフォールバックと同じ方針で、既定構成の
 * プロンプト文面が従来と一致することを保証するため。
 */
export function resolveGlossaryPromptDirection(settings: AdminSettings): GlossaryPromptDirection {
  const languages = loadLanguageProfileConfig(settings)
  const roles = resolveGlossaryRoles(languages)

  const transcriptLanguage = normalizeLanguageLabel(languages.transcript.label) || '日本語'
  const subtitleLanguage = normalizeLanguageLabel(languages.subtitle.label) || '英語'

  return {
    roles,
    transcriptLanguage,
    subtitleLanguage,
    jaLanguage: languageForField('ja', roles, transcriptLanguage, subtitleLanguage),
    enLanguage: languageForField('en', roles, transcriptLanguage, subtitleLanguage),
    isDefaultDirection:
      roles.transcript === DEFAULT_GLOSSARY_ROLES.transcript
      && roles.subtitle === DEFAULT_GLOSSARY_ROLES.subtitle,
  }
}
