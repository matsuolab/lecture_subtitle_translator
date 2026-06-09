import { describe, it, expect } from 'vitest'
import dictionaryEn from 'dictionary-en'
import { createHunspellChecker } from './hunspellChecker'

describe('HunspellChecker (Latin / dictionary-en)', () => {
  it('detects real misspellings while excluding code tokens, acronyms and foreign script', async () => {
    const checker = await createHunspellChecker({ dictionary: dictionaryEn, targetScript: 'Latin' })
    const issues = await checker.check(
      'The goal of this lectue is to set load_in_4bit=True with EOS for 首都.',
    )
    const words = issues.map(i => i.word)
    expect(words).toContain('lectue')        // 真の誤り → 検出
    expect(words).not.toContain('load_in_4bit=True') // コード識別子 → 除外
    expect(words).not.toContain('EOS')        // 頭字語 → 除外
    expect(words).not.toContain('首都')        // 非ラテン → 除外
  })

  it('flags consecutive repeated words as repeated_word', async () => {
    const checker = await createHunspellChecker({ dictionary: dictionaryEn, targetScript: 'Latin' })
    const issues = await checker.check('the count has not been made made public yet')
    expect(issues.some(i => i.reason === 'repeated_word')).toBe(true)
  })

  it('excludes glossary terms injected as a personal dictionary', async () => {
    const text = 'We install Unsloth for finetuning'
    const without = await createHunspellChecker({ dictionary: dictionaryEn, targetScript: 'Latin' })
    expect((await without.check(text)).map(i => i.word)).toContain('Unsloth')

    const withGlossary = await createHunspellChecker({
      dictionary: dictionaryEn, targetScript: 'Latin', personal: ['Unsloth'],
    })
    expect((await withGlossary.check(text)).map(i => i.word)).not.toContain('Unsloth')
  })
})
