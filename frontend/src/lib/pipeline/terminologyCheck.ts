import type { EnBlock } from './blockTypes'

export interface TerminologyCheckResult {
  ok: boolean
  misses: string[]
}

export function checkTerminology(
  segments: EnBlock[],
  glossaryTerms: string[],
): TerminologyCheckResult {
  if (glossaryTerms.length === 0) {
    return { ok: true, misses: [] }
  }

  const allText = segments.map((s) => (s.enText ?? '').toLowerCase()).join(' ')
  const misses = glossaryTerms.filter((term) => !allText.includes(term.toLowerCase()))

  return { ok: misses.length === 0, misses }
}
