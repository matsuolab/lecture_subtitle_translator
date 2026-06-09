import { describe, it, expect } from 'vitest'
import { filterIssues } from './filterIssues'
import type { SpellIssue } from './types'

function issue(word: string, offset = 0): SpellIssue {
  return { word, offset, reason: 'misspelling', suggestions: [] }
}

describe('filterIssues — target-script relative filtering', () => {
  it('drops tokens whose script differs from the target, keeps matching ones', () => {
    const issues = [issue('首都'), issue('transformer'), issue('lectue')]
    const kept = filterIssues(issues, { targetScript: 'Latin' })
    expect(kept.map(i => i.word)).toEqual(['transformer', 'lectue'])
  })

  it('drops code identifiers (containing _ = . or digits)', () => {
    const issues = [
      issue('load_in_4bit=True'), issue('q_proj'), issue('model.save_pretrained'),
      issue('A100'), issue('lectue'),
    ]
    const kept = filterIssues(issues, { targetScript: 'Latin' })
    expect(kept.map(i => i.word)).toEqual(['lectue'])
  })

  it('drops all-caps acronyms (EOS, MMLU) but keeps normal words', () => {
    const issues = [issue('EOS'), issue('MMLU'), issue('PEFT'), issue('lectue'), issue('Transformer')]
    const kept = filterIssues(issues, { targetScript: 'Latin' })
    expect(kept.map(i => i.word)).toEqual(['lectue', 'Transformer'])
  })
})
