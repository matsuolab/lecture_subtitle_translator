import type { ScriptName, SpellChecker } from './types'
import { createHunspellChecker } from './hunspellChecker'

/** 言語ロールプロファイル（`languageProfileConfig` の subtitle 相当の最小形） */
export interface SpellLanguageProfile {
  label: string
  script: string
}

export interface ResolveSpellCheckerDeps {
  /** 言語ラベルに対応する hunspell 辞書（aff/dic）を返す。無ければ undefined。同期/非同期どちらも可 */
  loadDictionary: (label: string) => unknown | undefined | Promise<unknown | undefined>
  /** 用語集など、誤検知させたくない語（個人辞書へ注入） */
  glossaryTerms?: string[]
}

/**
 * プロファイルの粗い script を、スペル校正可能な Unicode スクリプト名へ対応づける。
 * 校正不成立（CJK など）や不明な場合は null（= Tier2 / no-op への委譲点）。
 */
function toSpellableScript(script: string): ScriptName | null {
  switch (script) {
    case 'latin':
      return 'Latin'
    // 'japanese'(CJK) は綴り概念が異なるため Tier1 では校正しない。
    // 'generic' はスクリプト不定のため Tier1 対象外。
    default:
      return null
  }
}

/**
 * 言語プロファイルから SpellChecker を解決する。
 * Tier1(hunspell) が成立しない場合は null を返し、呼び出し側で Tier2(LLM) 等へ委譲できる。
 */
export async function resolveSpellChecker(
  profile: SpellLanguageProfile,
  deps: ResolveSpellCheckerDeps,
): Promise<SpellChecker | null> {
  const targetScript = toSpellableScript(profile.script)
  if (!targetScript) return null

  const dictionary = await deps.loadDictionary(profile.label)
  if (!dictionary) return null

  return createHunspellChecker({
    dictionary,
    targetScript,
    personal: deps.glossaryTerms,
  })
}
