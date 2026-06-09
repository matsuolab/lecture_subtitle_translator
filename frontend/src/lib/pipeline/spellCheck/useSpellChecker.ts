import { useEffect, useState } from 'react'
import type { AdminSettings } from '@/types/adminSettings'
import { loadLanguageProfileConfig } from '../languageProfileConfig'
import { resolveSpellChecker } from './resolveSpellChecker'
import { loadDictionaryForLabel } from './dictionaryRegistry'
import type { SpellChecker } from './types'

/**
 * 字幕言語・用語集・ユーザー個人辞書から SpellChecker を解決する React フック。
 * 対応辞書がある言語なら自動で校正する。非対応言語・辞書なしの場合は null（= 校正しない）。
 * 個人辞書 = 用語集の英語語 + spellUserDictionary（ユーザー全体）。
 */
export function useSpellChecker(
  settings: AdminSettings,
  glossaryEnTerms: string[],
): SpellChecker | null {
  const [checker, setChecker] = useState<SpellChecker | null>(null)

  const personalKey = JSON.stringify([...glossaryEnTerms, ...settings.spellUserDictionary])
  const importedKey = JSON.stringify(settings.spellImportedDictionaryLabels)
  const profile = loadLanguageProfileConfig(settings).subtitle

  useEffect(() => {
    let cancelled = false
    const personal = [...glossaryEnTerms, ...settings.spellUserDictionary]
    const importedLabels = settings.spellImportedDictionaryLabels
    resolveSpellChecker(profile, {
      loadDictionary: (label) => loadDictionaryForLabel(label, importedLabels),
      glossaryTerms: personal,
    })
      .then((resolved) => { if (!cancelled) setChecker(() => resolved) })
      .catch(() => { if (!cancelled) setChecker(null) })
    return () => { cancelled = true }
    // personalKey/importedKey/profile が変わったら再構築
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile.label, profile.script, personalKey, importedKey])

  return checker
}
