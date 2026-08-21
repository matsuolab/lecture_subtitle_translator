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

  it('does not treat an identity glossary entry as a required target-language rendering', () => {
    const result = classifyTranslationRisk(
      '学習を行います。',
      'We train the model.',
      ['学習 => 学習'],
    )

    expect(result.differences).not.toContainEqual(expect.objectContaining({ kind: 'glossary_term' }))
    expect(result.riskBand).toBe('none')
  })

  it('still enforces an identity glossary entry that is a literal identifier', () => {
    const result = classifyTranslationRisk(
      'softmaxを使います。',
      'We use the normalization function.',
      ['softmax => softmax'],
    )

    expect(result.differences).toContainEqual({
      kind: 'glossary_term',
      sourceValue: 'softmax',
      expectedValue: 'softmax',
    })
  })

  it('recognizes a small integer rendered as an English ordinal', () => {
    const result = classifyTranslationRisk(
      '第7章です。',
      'This is the seventh chapter.',
    )

    expect(result.differences).not.toContainEqual({ kind: 'number', sourceValue: '7' })
    expect(result.riskBand).toBe('none')
  })

  it('recognizes an ordinal formed from an English scale word', () => {
    const result = classifyTranslationRisk(
      '第100回です。',
      'This is the one hundredth occurrence.',
    )

    expect(result.differences).toEqual([])
  })

  it('recognizes a Japanese counter followed by 目 as an explicit ordinal', () => {
    const result = classifyTranslationRisk(
      '2個目のチャンクです。',
      'This is the second chunk.',
    )

    expect(result.differences).toEqual([])
  })

  it('recognizes an axis counter followed by 目 as an explicit ordinal', () => {
    const result = classifyTranslationRisk(
      '7軸目で値が飛びます。',
      'The value jumps at the seventh axis.',
    )

    expect(result.differences).toEqual([])
  })

  it('recognizes a compound English number beyond the old lookup-table boundary', () => {
    const result = classifyTranslationRisk(
      '対象は21件です。',
      'There are twenty-one items.',
    )

    expect(result.differences).not.toContainEqual({ kind: 'number', sourceValue: '21' })
    expect(result.riskBand).toBe('none')
  })

  it('does not accept a larger compound number as preserving a component value', () => {
    const result = classifyTranslationRisk(
      '対象は20件です。',
      'There are twenty-one items.',
    )

    expect(result.differences).toContainEqual({ kind: 'number', sourceValue: '20' })
  })

  it('recognizes a spoken English decimal as the same numeric value', () => {
    const result = classifyTranslationRisk(
      '誤差は3.5%です。',
      'The error is three point five percent.',
    )

    expect(result.differences).toEqual([])
    expect(result.riskBand).toBe('none')
  })

  it('does not misread an English fraction as the sum of its component words', () => {
    const result = classifyTranslationRisk(
      '対象は4件です。',
      'One-third of the items are eligible.',
    )

    expect(result.differences).toContainEqual({ kind: 'number', sourceValue: '4' })
    expect(result.riskBand).toBe('high')
  })

  it('composes English scale words instead of enumerating every possible number', () => {
    const result = classifyTranslationRisk(
      '対象は2300件です。',
      'There are two thousand three hundred items.',
    )

    expect(result.differences).toEqual([])
    expect(result.riskBand).toBe('none')
  })

  it('does not add separate numbers joined by ordinary prose', () => {
    const result = classifyTranslationRisk(
      '対象は3件です。',
      'One and two items are eligible.',
    )

    expect(result.differences).toContainEqual({ kind: 'number', sourceValue: '3' })
  })

  it('does not add an enumerated sequence of number words', () => {
    const result = classifyTranslationRisk(
      '対象は6件です。',
      'Items one two three are selected.',
    )

    expect(result.differences).toContainEqual({ kind: 'number', sourceValue: '6' })
  })

  it('recognizes an English indefinite article used as one before a scale', () => {
    const result = classifyTranslationRisk(
      '対象は100件です。',
      'There are a hundred items.',
    )

    expect(result.differences).toEqual([])
  })

  it('recognizes the common grouped reading of a four-digit year', () => {
    const result = classifyTranslationRisk(
      '2026年に実施します。',
      'It will take place in twenty twenty-six.',
    )

    expect(result.differences).toEqual([])
  })

  it('normalizes thousands separators before comparing numeric values', () => {
    const result = classifyTranslationRisk(
      '対象は1,234件です。',
      'There are one thousand two hundred thirty-four items.',
    )

    expect(result.differences).toEqual([])
  })

  it('preserves the sign when comparing a negative number', () => {
    const preserved = classifyTranslationRisk('変化量は-3です。', 'The change is minus three.')
    const lostSign = classifyTranslationRisk('変化量は-3です。', 'The change is three.')

    expect(preserved.differences).toEqual([])
    expect(lostSign.differences).toContainEqual({ kind: 'number', sourceValue: '-3' })
  })

  it('preserves a negative sign when the integer part of a decimal is zero', () => {
    const result = classifyTranslationRisk(
      '変化量は-0.5です。',
      'The change is minus zero point five.',
    )

    expect(result.differences).toEqual([])
  })

  it('keeps number and unit checks independent after verbalized-number normalization', () => {
    const preserved = classifyTranslationRisk('7秒待機します。', 'Wait seven seconds.')
    const missingUnit = classifyTranslationRisk('7秒待機します。', 'Wait seven.')
    const wrongNumber = classifyTranslationRisk('7秒待機します。', 'Wait eight seconds.')

    expect(preserved.differences).toEqual([])
    expect(missingUnit.differences).toEqual([{ kind: 'unit', sourceValue: '秒' }])
    expect(wrongNumber.differences).toContainEqual({ kind: 'number', sourceValue: '7' })
    expect(wrongNumber.differences).not.toContainEqual({ kind: 'unit', sourceValue: '秒' })
  })

  it('does not confuse an ordinal word with a cardinal quantity', () => {
    const result = classifyTranslationRisk(
      '2秒待機します。',
      'Wait a second.',
    )

    expect(result.differences).toContainEqual({ kind: 'number_form', sourceValue: '2' })
    expect(result.riskBand).toBe('medium')
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
