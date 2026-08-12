import { describe, expect, it } from 'vitest'
import { classifyTranslationRisk } from './translationRiskClassifier'

describe('classifyTranslationRisk', () => {
  it('records a deterministic difference when a source number is absent from the translation', () => {
    const result = classifyTranslationRisk(
      'この処理は3回まで再試行します。',
      'This operation will be retried.',
    )

    expect(result.riskBand).toBe('high')
    expect(result.differences).toContainEqual({ kind: 'number', sourceValue: '3' })
    expect(result).not.toHaveProperty('passed')
    expect(result).not.toHaveProperty('manualReview')
  })

  it('recognizes translated unit aliases without reporting a difference', () => {
    const result = classifyTranslationRisk(
      'タイムアウトは5秒です。',
      'The timeout is 5 seconds.',
    )

    expect(result.differences).toEqual([])
    expect(result.riskBand).toBe('none')
  })

  it('records a unit difference even when the numeric value is preserved', () => {
    const result = classifyTranslationRisk(
      'タイムアウトは5秒です。',
      'The timeout value is 5.',
    )

    expect(result.differences).toContainEqual({ kind: 'unit', sourceValue: '秒' })
    expect(result.riskBand).toBe('high')
  })

  it('records a URL difference without interpreting its meaning', () => {
    const result = classifyTranslationRisk(
      '詳細はhttps://example.com/v1を参照してください。',
      'See the documentation for details.',
    )

    expect(result.differences).toContainEqual({ kind: 'url', sourceValue: 'https://example.com/v1' })
  })

  it('records an exact code identifier difference', () => {
    const result = classifyTranslationRisk(
      'sourceSegmentIdを引き継ぎます。',
      'The source identifier is preserved.',
    )

    expect(result.differences).toContainEqual({ kind: 'code_identifier', sourceValue: 'sourceSegmentId' })
  })

  it('records an absent expected glossary rendering when its source term appears', () => {
    const result = classifyTranslationRisk(
      '勾配降下法を使います。',
      'We use an optimization method.',
      ['勾配降下法 => gradient descent'],
    )

    expect(result.differences).toContainEqual({
      kind: 'glossary_term',
      sourceValue: '勾配降下法',
      expectedValue: 'gradient descent',
    })
  })

  it('records source-side negation and conditional signals without producing a verdict', () => {
    const result = classifyTranslationRisk(
      '失敗した場合は、この処理を実行しないでください。',
      'If it fails, skip this operation.',
    )

    expect(result.sourceRiskSignals).toEqual(['negation', 'conditional'])
    expect(result.riskBand).toBe('medium')
    expect(result).not.toHaveProperty('passed')
    expect(result).not.toHaveProperty('failed')
  })
})
