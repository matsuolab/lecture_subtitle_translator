import { describe, it, expect } from 'vitest'
import dictionaryEn from 'dictionary-en'
import { createHunspellChecker } from './hunspellChecker'
import type { SpellChecker } from './types'

/**
 * Day9 納品SRTにそのまま残っていた実際の誤りを回帰フィクスチャ化。
 * Tier1(hunspell) が「辞書で検出可能な綴り誤り・重複語」を取りこぼさないことを固定する。
 */
const CASES: Array<{ text: string; expectWord: string; reason: 'misspelling' | 'repeated_word' }> = [
  { text: 'The goal of this lectue is to provide an overview.', expectWord: 'lectue', reason: 'misspelling' },
  { text: 'OpenAI was quick to recoginize Scaling Law.', expectWord: 'recoginize', reason: 'misspelling' },
  { text: 'a signal of cosiderably less information.', expectWord: 'cosiderably', reason: 'misspelling' },
  { text: 'this ability can be greatly improced through training.', expectWord: 'improced', reason: 'misspelling' },
  { text: 'FLOPS is used alot here.', expectWord: 'alot', reason: 'misspelling' },
  { text: 'The count has not been made made public.', expectWord: 'made', reason: 'repeated_word' },
]

describe('Day9 regression — Tier1 recall on dictionary-detectable errors', () => {
  let checker: SpellChecker
  it('sets up', async () => {
    checker = await createHunspellChecker({ dictionary: dictionaryEn, targetScript: 'Latin' })
  })

  for (const c of CASES) {
    it(`catches "${c.expectWord}" (${c.reason})`, async () => {
      checker ??= await createHunspellChecker({ dictionary: dictionaryEn, targetScript: 'Latin' })
      const issues = await checker.check(c.text)
      expect(issues.some(i => i.reason === c.reason)).toBe(true)
    })
  }

  it('documents Tier1 limitation: real-word error "lager"(→larger) is NOT caught (needs Tier2)', async () => {
    checker ??= await createHunspellChecker({ dictionary: dictionaryEn, targetScript: 'Latin' })
    const issues = await checker.check('on the other hand, with a lager model size')
    expect(issues.map(i => i.word)).not.toContain('lager')
  })
})
