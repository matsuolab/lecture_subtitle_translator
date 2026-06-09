/** Unicode スクリプト名（開いた文字列）。例: 'Latin' | 'Cyrillic' | 'Ethiopic' | 'Adlam' */
export type ScriptName = string

export type SpellIssueReason = 'misspelling' | 'repeated_word'

export interface SpellIssue {
  /** フラグされた語（actual） */
  word: string
  /** 入力テキスト内の文字オフセット */
  offset: number
  reason: SpellIssueReason
  /** 修正候補（nspell由来。無い場合は空配列） */
  suggestions: string[]
}

export interface SpellChecker {
  check(text: string): Promise<SpellIssue[]>
}
