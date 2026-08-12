import { extractEnglishNumberExpressions } from './englishNumberParser'

export type TranslationRiskBand = 'none' | 'low' | 'medium' | 'high'

export type TranslationDifferenceKind = 'number' | 'number_form' | 'unit' | 'url' | 'code_identifier' | 'glossary_term'

export interface TranslationDeterministicDifference {
  kind: TranslationDifferenceKind
  sourceValue: string
  expectedValue?: string
}

export type SourceTranslationRiskSignal = 'negation' | 'conditional'

/**
 * 初回翻訳を後から分析するための観測値。
 *
 * `riskBand` は将来 LLM Judge の候補頻度を見積もる分類であり、翻訳の合否ではない。
 * この型には pass/fail/manualReview や、自動修復を駆動できる disposition を持たせない。
 */
export interface TranslationRiskObservation {
  riskBand: TranslationRiskBand
  differences: TranslationDeterministicDifference[]
  sourceRiskSignals: SourceTranslationRiskSignal[]
}

function normalizeDigits(text: string): string {
  return text.replace(/[０-９]/g, char => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
}

function uniqueMatches(text: string, pattern: RegExp): string[] {
  return [...new Set(text.match(pattern) ?? [])]
}

function canonicalizeNumericLiteral(value: string): string {
  const normalized = value.replaceAll(',', '')
  const negative = normalized.startsWith('-')
  const unsigned = normalized.replace(/^[+-]/, '')
  const [integerPart = '0', fractionPart] = unsigned.split('.')
  const integer = integerPart.replace(/^0+(?=\d)/, '') || '0'
  const fraction = fractionPart?.replace(/0+$/, '')
  const magnitude = fraction ? `${integer}.${fraction}` : integer
  return negative && magnitude !== '0' ? `-${magnitude}` : magnitude
}

function isExplicitSourceOrdinal(sourceText: string, sourceValue: string): boolean {
  const escapedValue = escapeRegExp(sourceValue)
  const ordinalCounter = '(?:番|個|つ|回|人|台|本|枚|日|年|章|節|軸|段階|ステップ|チャンク)目'
  return new RegExp(`(?:第\\s*${escapedValue}|${escapedValue}\\s*(?:位|${ordinalCounter}))`).test(sourceText)
}

type NumberComparison = 'preserved' | 'form_changed' | 'missing'

function compareNumber(sourceValue: string, sourceText: string, translatedText: string): NumberComparison {
  const expected = canonicalizeNumericLiteral(sourceValue)
  if (uniqueMatches(translatedText, /[+-]?\d[\d,]*(?:\.\d+)?/g)
    .some(value => canonicalizeNumericLiteral(value) === expected)) return 'preserved'
  const sourceIsOrdinal = isExplicitSourceOrdinal(sourceText, sourceValue)
  const matchingExpressions = extractEnglishNumberExpressions(translatedText)
    .filter(expression => expression.value === expected)
  if (matchingExpressions.some(expression => sourceIsOrdinal || expression.form === 'cardinal')) return 'preserved'
  return matchingExpressions.length > 0 ? 'form_changed' : 'missing'
}

const UNIT_ALIASES: ReadonlyArray<{ source: string; aliases: readonly string[] }> = [
  { source: 'ミリ秒', aliases: ['ミリ秒', 'ms', 'millisecond', 'milliseconds'] },
  { source: '秒', aliases: ['秒', 'sec', 'secs', 'second', 'seconds'] },
  { source: '分', aliases: ['分', 'min', 'mins', 'minute', 'minutes'] },
  { source: '時間', aliases: ['時間', 'hr', 'hrs', 'hour', 'hours'] },
  { source: '%', aliases: ['%', 'percent', 'percentage'] },
  { source: '％', aliases: ['%', 'percent', 'percentage'] },
  { source: 'GB', aliases: ['gb', 'gigabyte', 'gigabytes'] },
  { source: 'MB', aliases: ['mb', 'megabyte', 'megabytes'] },
  { source: 'KB', aliases: ['kb', 'kilobyte', 'kilobytes'] },
  { source: 'GHz', aliases: ['ghz'] },
  { source: 'MHz', aliases: ['mhz'] },
  { source: 'kHz', aliases: ['khz'] },
  { source: 'Hz', aliases: ['hz'] },
  { source: 'fps', aliases: ['fps', 'frames per second'] },
  { source: 'px', aliases: ['px', 'pixel', 'pixels'] },
  { source: 'CPS', aliases: ['cps', 'characters per second'] },
]

function extractUnitDifferences(sourceText: string, translatedText: string): TranslationDeterministicDifference[] {
  const translationLower = translatedText.toLowerCase()
  return UNIT_ALIASES
    .filter(({ source }) => new RegExp(`\\d(?:[.,]\\d+)?\\s*${escapeRegExp(source)}`, 'i').test(sourceText))
    .filter(({ aliases }) => !aliases.some(alias => translationLower.includes(alias.toLowerCase())))
    .map(({ source }) => ({ kind: 'unit', sourceValue: source }))
}

function extractCodeIdentifiers(sourceText: string): string[] {
  const quoted = [...sourceText.matchAll(/`([^`]+)`/g)].map(match => match[1].trim()).filter(Boolean)
  const shaped = uniqueMatches(
    sourceText,
    /[A-Za-z_$][A-Za-z0-9_$]*(?:_[A-Za-z0-9_$]+|[A-Z][A-Za-z0-9_$]*)+[A-Za-z0-9_$]*|[A-Za-z_$][A-Za-z0-9_$]*\(\)/g,
  ).map(value => value.replace(/\(\)$/, ''))
  return [...new Set([...quoted, ...shaped])]
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function extractGlossaryDifferences(
  sourceText: string,
  translatedText: string,
  glossaryTerms: string[],
): TranslationDeterministicDifference[] {
  const japaneseLexicalPattern = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u
  const translatedLower = translatedText.toLowerCase()
  const differences: TranslationDeterministicDifference[] = []
  for (const rawTerm of glossaryTerms) {
    const [sourcePart, ...expectedParts] = rawTerm.split(/\s*=>\s*/)
    const sourceValue = sourcePart?.trim()
    const expectedValue = (expectedParts.length > 0 ? expectedParts.join(' => ') : sourcePart)?.trim()
    if (!sourceValue || !expectedValue) continue
    // Japanese identity entries describe source-side lexical normalization, while
    // Latin identity entries such as softmax=>softmax are literal preservation contracts.
    if (sourceValue === expectedValue && japaneseLexicalPattern.test(sourceValue)) continue
    if (!sourceText.toLowerCase().includes(sourceValue.toLowerCase())) continue
    if (translatedLower.includes(expectedValue.toLowerCase())) continue
    differences.push({ kind: 'glossary_term', sourceValue, expectedValue })
  }
  return differences
}

function detectSourceRiskSignals(sourceText: string): SourceTranslationRiskSignal[] {
  const signals: SourceTranslationRiskSignal[] = []
  if (/(?:ない|ません|禁止|不可|除く|以外|せず|不要)|\b(?:not|never|without|except)\b/i.test(sourceText)) {
    signals.push('negation')
  }
  if (/(?:場合|ならば|なら|とき|時は|条件)|\b(?:if|when|unless|provided)\b/i.test(sourceText)) {
    signals.push('conditional')
  }
  return signals
}

/** 決定的に比較できる差分と、source 側の意味変化リスクだけを観測する。 */
export function classifyTranslationRisk(
  sourceText: string,
  translatedText: string,
  glossaryTerms: string[] = [],
): TranslationRiskObservation {
  const normalizedSource = normalizeDigits(sourceText)
  const normalizedTranslation = normalizeDigits(translatedText)
  const sourceUrls = uniqueMatches(normalizedSource, /https?:\/\/[A-Za-z0-9._~:/?#@!$&'()*+,;=%-]+/gi)
  const differences: TranslationDeterministicDifference[] = sourceUrls
    .filter(value => !normalizedTranslation.includes(value))
    .map(sourceValue => ({ kind: 'url' as const, sourceValue }))
  const sourceWithoutUrls = sourceUrls.reduce((text, url) => text.replaceAll(url, ' '), normalizedSource)
  differences.push(...extractCodeIdentifiers(sourceWithoutUrls)
    .filter(value => !normalizedTranslation.includes(value))
    .map(sourceValue => ({ kind: 'code_identifier' as const, sourceValue })))
  differences.push(...uniqueMatches(sourceWithoutUrls, /[+-]?\d[\d,]*(?:\.\d+)?/g)
    .flatMap((sourceValue) => {
      const comparison = compareNumber(sourceValue, sourceWithoutUrls, normalizedTranslation)
      if (comparison === 'preserved') return []
      return [{ kind: comparison === 'form_changed' ? 'number_form' as const : 'number' as const, sourceValue }]
    }))
  differences.push(...extractUnitDifferences(normalizedSource, normalizedTranslation))
  differences.push(...extractGlossaryDifferences(normalizedSource, normalizedTranslation, glossaryTerms))
  const sourceRiskSignals = detectSourceRiskSignals(normalizedSource)

  const hasHighRiskDifference = differences.some(difference => difference.kind !== 'number_form')
  return {
    riskBand: hasHighRiskDifference ? 'high' : differences.length > 0 || sourceRiskSignals.length > 0 ? 'medium' : 'none',
    differences,
    sourceRiskSignals,
  }
}
