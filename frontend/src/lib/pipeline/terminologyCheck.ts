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

  const allJaText = segments.map((s) => s.jaText ?? '').join(' ')
  const allEnText = segments.map((s) => s.enText ?? '').join(' ')
  const allJaLower = allJaText.toLowerCase()
  const allEnLower = allEnText.toLowerCase()
  const misses = glossaryTerms.filter((term) => {
    const parsed = parseGlossaryTerm(term)
    if (!parsed) return false

    const sourceAppears = includesLoose(allJaLower, parsed.source)
      || includesLoose(allEnLower, parsed.source)
    if (!sourceAppears) return false

    return !includesLoose(allEnLower, parsed.expected)
  })

  return { ok: misses.length === 0, misses }
}

function parseGlossaryTerm(term: string): { source: string; expected: string } | null {
  const trimmed = term.trim()
  if (!trimmed) return null
  const pair = trimmed.split(/\s*=>\s*/)
  if (pair.length >= 2) {
    const source = pair[0]?.trim()
    const expected = pair.slice(1).join(' => ').trim()
    if (!source || !expected) return null
    return { source, expected }
  }

  return { source: trimmed, expected: trimmed }
}

function includesLoose(textLower: string, term: string): boolean {
  const normalized = term.trim().toLowerCase()
  return normalized.length > 0 && textLower.includes(normalized)
}
