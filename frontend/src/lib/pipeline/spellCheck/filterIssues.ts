import type { ScriptName, SpellIssue } from './types'

export interface FilterOptions {
  targetScript: ScriptName
}

/** 語にターゲットスクリプト以外の「文字(\p{L})」が含まれていれば true（=外来語としてスキップ対象） */
function hasForeignLetter(word: string, targetScript: ScriptName): boolean {
  const target = new RegExp(`\\p{Script=${targetScript}}`, 'u')
  for (const ch of word) {
    if (/\p{L}/u.test(ch) && !target.test(ch)) return true
  }
  return false
}

/** コード識別子・型番（_ = . や数字を含む）か */
function isCodeIdentifier(word: string): boolean {
  return /[_=.]/.test(word) || /\d/.test(word)
}

/** 全大文字の頭字語（2文字以上、小文字を含まない）か */
function isAcronym(word: string): boolean {
  return word.length >= 2 && /^\p{Lu}+$/u.test(word)
}

export function filterIssues(issues: SpellIssue[], opts: FilterOptions): SpellIssue[] {
  return issues.filter(i =>
    !hasForeignLetter(i.word, opts.targetScript) &&
    !isCodeIdentifier(i.word) &&
    !isAcronym(i.word),
  )
}
