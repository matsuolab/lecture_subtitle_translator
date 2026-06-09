import { describe, it, expect } from 'vitest'
import dictionaryEn from 'dictionary-en'
import { resolveSpellChecker } from './resolveSpellChecker'

describe('resolveSpellChecker', () => {
  it('returns a checker for a latin language with an available dictionary', async () => {
    const checker = await resolveSpellChecker(
      { label: 'English', script: 'latin' },
      { loadDictionary: () => dictionaryEn },
    )
    expect(checker).not.toBeNull()
    const words = (await checker!.check('this is a lectue')).map(i => i.word)
    expect(words).toContain('lectue')
  })

  it('returns null for CJK (japanese) — delegated to Tier2', async () => {
    const checker = await resolveSpellChecker(
      { label: 'Japanese', script: 'japanese' },
      { loadDictionary: () => dictionaryEn },
    )
    expect(checker).toBeNull()
  })

  it('returns null when no dictionary is available for the language', async () => {
    const checker = await resolveSpellChecker(
      { label: 'Klingon', script: 'latin' },
      { loadDictionary: () => undefined },
    )
    expect(checker).toBeNull()
  })
})
