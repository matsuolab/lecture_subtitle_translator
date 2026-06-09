import type { GlossaryTerm } from '@/types/subtitle'
import type { SpellIssue } from './types'

/** スペル誤検出のハイライト背景色（用語辞書ハイライトと区別） */
export const SPELL_HIGHLIGHT_COLOR = '#e0563f'

/**
 * SpellIssue[] を既存 `TermHighlight` が解釈する `GlossaryTerm[]` 形へ変換する。
 * 同一表層形は1つにまとめる。
 */
export function spellIssuesToTerms(issues: SpellIssue[]): GlossaryTerm[] {
  const byWord = new Map<string, SpellIssue>()
  for (const i of issues) {
    if (!byWord.has(i.word)) byWord.set(i.word, i)
  }
  return [...byWord.values()].map((i) => ({
    word: i.word,
    expectedTranslation: i.suggestions[0] ?? '',
    actualTranslation: i.word,
    isDeviated: true,
    bgColor: SPELL_HIGHLIGHT_COLOR,
    insight: i.reason === 'repeated_word'
      ? '重複した単語の可能性'
      : i.suggestions.length > 0 ? `修正候補: ${i.suggestions.slice(0, 4).join(', ')}` : 'スペル誤りの可能性',
  }))
}
