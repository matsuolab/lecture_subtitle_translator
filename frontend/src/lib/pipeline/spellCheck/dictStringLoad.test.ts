import { describe, it, expect } from 'vitest'
import { createHunspellChecker } from './hunspellChecker'
import type { HunspellDictionary } from './dictionaryRegistry'

declare const require: (id: string) => { readFileSync: (p: string, e: string) => string }
declare const process: { cwd: () => string }
const { readFileSync } = require('fs')

// ブラウザ経路の再現: 同梱辞書を **UTF-8 文字列** として渡す（Uint8Array ではない）。
// nspell の affix/dictionary は doc.toString('utf8') を呼ぶため、string でなければ壊れる。
function loadEnAsStrings(): HunspellDictionary {
  const dir = `${process.cwd()}/src/lib/pipeline/spellCheck/dictionaries`
  return {
    aff: readFileSync(`${dir}/en.aff`, 'utf-8'),
    dic: readFileSync(`${dir}/en.dic`, 'utf-8'),
  }
}

describe('browser-path dictionary (string aff/dic)', () => {
  it('does NOT flag common English words when dictionary is passed as strings', async () => {
    const checker = await createHunspellChecker({ dictionary: loadEnAsStrings(), targetScript: 'Latin' })
    const words = (await checker.check('Mr. Suzuki is out today for training.')).map(i => i.word)
    for (const common of ['is', 'out', 'today', 'for', 'training']) {
      expect(words).not.toContain(common)
    }
  })

  it('still flags a real misspelling with string dictionary', async () => {
    const checker = await createHunspellChecker({ dictionary: loadEnAsStrings(), targetScript: 'Latin' })
    const words = (await checker.check('this is a lectue')).map(i => i.word)
    expect(words).toContain('lectue')
  })
})
