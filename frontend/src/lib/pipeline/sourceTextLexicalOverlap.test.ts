import { describe, expect, it } from 'vitest'
import type { EnBlock } from './blockTypes'
import type { CorrectedSegmentLite } from './correct'
import { measureSourceTextLexicalOverlap } from './sourceTextLexicalOverlap'

function segment(
  partial: Partial<CorrectedSegmentLite> & Pick<CorrectedSegmentLite, 'id' | 'start' | 'end' | 'correctedText'>,
): CorrectedSegmentLite {
  return {
    text: partial.correctedText,
    correctionDistance: 0,
    correctionFlagged: false,
    ...partial,
  }
}

function block(partial: Partial<EnBlock> & Pick<EnBlock, 'id' | 'start' | 'end' | 'jaText'>): EnBlock {
  return {
    jaChars: partial.jaText.length,
    enText: '',
    enRaw: '',
    enChars: 0,
    cps: 0,
    maxLineLen: 0,
    violation: 'ok',
    alignConf: 'exact',
    merged: false,
    expandCount: 0,
    compressCount: 0,
    ...partial,
  }
}

describe('measureSourceTextLexicalOverlap', () => {
  it('reports the overlap ratio for a segment fully covered by its blocks', () => {
    const sourceText = 'これは長い日本語の原文セグメントであり二十文字を超えている'
    const segments: CorrectedSegmentLite[] = [
      segment({ id: 1, start: 0, end: 4, correctedText: sourceText }),
    ]
    const blocks: EnBlock[] = [
      block({ id: 1, start: 0, end: 4, jaText: sourceText }),
    ]

    const report = measureSourceTextLexicalOverlap(blocks, segments)

    expect(report.totalSegments).toBe(1)
    expect(report.observations).toHaveLength(1)
    expect(report.observations[0].overlapRatio).toBe(1)
    expect(report.avgOverlapRatio).toBe(1)
  })

  it('does not have pass/fail fields (ok / passedSegments / failedSegments / threshold)', () => {
    const sourceText = 'これは長い日本語の原文セグメントであり二十文字を超えている'
    const segments: CorrectedSegmentLite[] = [
      segment({ id: 1, start: 0, end: 4, correctedText: sourceText }),
    ]
    const blocks: EnBlock[] = [
      // 意図的に一部しかカバーしない block（正当な書き換え・誤帰属等でも起こりうる）
      block({ id: 1, start: 0, end: 4, jaText: 'これは短い' }),
    ]

    const report = measureSourceTextLexicalOverlap(blocks, segments)

    expect(report).not.toHaveProperty('ok')
    expect(report).not.toHaveProperty('passedSegments')
    expect(report).not.toHaveProperty('failedSegments')
    expect(report).not.toHaveProperty('threshold')
    expect(report.observations[0]).not.toHaveProperty('coverageRatio')
  })

  it('includes every measurable segment in observations regardless of overlap ratio (no threshold filtering)', () => {
    const highOverlapText = 'これは長い日本語の原文セグメントであり二十文字を超えている'
    const lowOverlapText = 'これも二十文字を超える別の長い日本語の原文セグメントである'
    const segments: CorrectedSegmentLite[] = [
      segment({ id: 1, start: 0, end: 4, correctedText: highOverlapText }),
      segment({ id: 2, start: 10, end: 14, correctedText: lowOverlapText }),
    ]
    const blocks: EnBlock[] = [
      block({ id: 1, start: 0, end: 4, jaText: highOverlapText }),
      // segment 2 はほとんどカバーされない（重なり率が低くても observations には入る）
      block({ id: 2, start: 10, end: 14, jaText: '全然違う内容' }),
    ]

    const report = measureSourceTextLexicalOverlap(blocks, segments)

    expect(report.totalSegments).toBe(2)
    expect(report.observations.map((o) => o.sourceSegmentId).sort()).toEqual([1, 2])
    const lowEntry = report.observations.find((o) => o.sourceSegmentId === 2)
    expect(lowEntry).toBeDefined()
    expect(lowEntry?.overlapRatio ?? 1).toBeLessThan(0.9)
  })

  it('skips segments whose normalized source text is under 20 chars (too noisy to measure)', () => {
    const segments: CorrectedSegmentLite[] = [
      segment({ id: 1, start: 0, end: 1, correctedText: '短い文。' }),
    ]
    const blocks: EnBlock[] = [
      block({ id: 1, start: 0, end: 1, jaText: '短い文。' }),
    ]

    const report = measureSourceTextLexicalOverlap(blocks, segments)

    expect(report.totalSegments).toBe(0)
    expect(report.observations).toHaveLength(0)
    expect(report.avgOverlapRatio).toBeNull()
  })
})
