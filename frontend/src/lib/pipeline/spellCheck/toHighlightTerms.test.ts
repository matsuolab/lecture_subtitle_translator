import { describe, it, expect } from 'vitest'
import { spellIssuesToTerms, SPELL_HIGHLIGHT_COLOR } from './toHighlightTerms'
import type { SpellIssue } from './types'

const issue = (word: string, suggestions: string[] = []): SpellIssue => ({
  word, offset: 0, reason: 'misspelling', suggestions,
})

describe('spellIssuesToTerms', () => {
  it('maps a spell issue to a GlossaryTerm-shaped highlight with bgColor and suggestion', () => {
    const [term] = spellIssuesToTerms([issue('lectue', ['lecture'])])
    expect(term.word).toBe('lectue')
    expect(term.expectedTranslation).toBe('lecture')
    expect(term.bgColor).toBe(SPELL_HIGHLIGHT_COLOR)
  })

  it('deduplicates repeated words by surface form', () => {
    const terms = spellIssuesToTerms([issue('lectue'), issue('lectue')])
    expect(terms).toHaveLength(1)
  })
})
