import { unified } from 'unified'
import retextEnglish from 'retext-english'
import retextStringify from 'retext-stringify'
import retextSpell from 'retext-spell'
import retextRepeatedWords from 'retext-repeated-words'
import type { ScriptName, SpellChecker, SpellIssue, SpellIssueReason } from './types'
import { filterIssues } from './filterIssues'

export interface HunspellCheckerOptions {
  /** dictionary-* パッケージの import（aff/dic） */
  dictionary: unknown
  /** ロード中の辞書のターゲットスクリプト（'Latin' 等） */
  targetScript: ScriptName
  /** 用語集など、誤検知させたくない語（nspell個人辞書へ注入） */
  personal?: string[]
}

interface RetextMessage {
  actual?: string | null
  expected?: string[] | null
  source?: string | null
  place?: { start?: { offset?: number } } | null
  position?: { start?: { offset?: number } } | null
}

function messageReason(source: string | null | undefined): SpellIssueReason {
  return String(source ?? '').includes('repeated') ? 'repeated_word' : 'misspelling'
}

function messageOffset(m: RetextMessage): number {
  return m.place?.start?.offset ?? m.position?.start?.offset ?? -1
}

export async function createHunspellChecker(opts: HunspellCheckerOptions): Promise<SpellChecker> {
  const personal = opts.personal && opts.personal.length > 0
    ? opts.personal.join('\n')
    : undefined

  // dictionary-* の import 形は retext-spell が受け付けるが型表現が緩いため、
  // オプションをプラグインの引数型へ合わせてキャストする。
  const spellOptions = { dictionary: opts.dictionary, personal } as Parameters<typeof retextSpell>[0]

  const processor = unified()
    .use(retextEnglish)
    .use(retextSpell, spellOptions)
    .use(retextRepeatedWords)
    .use(retextStringify)

  return {
    async check(text: string): Promise<SpellIssue[]> {
      const normalized = text.normalize('NFC')
      const file = await processor.process(normalized)
      const issues: SpellIssue[] = (file.messages as RetextMessage[])
        .map((m) => ({
          word: (m.actual ?? '').trim(),
          offset: messageOffset(m),
          reason: messageReason(m.source),
          suggestions: m.expected ?? [],
        }))
        .filter((i) => i.word.length > 0)
      return filterIssues(issues, { targetScript: opts.targetScript })
    },
  }
}
