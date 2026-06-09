import { describe, expect, it } from 'vitest'
import type { EnBlock, PipelineThresholds } from './blockTypes'
import { analyzeFragmentation } from './fragmentationDiagnostics'
import { countCpsChars } from '../subtitleMetrics'

const thresholds: PipelineThresholds = {
  shortDurationSec: 1.5,
  longDurationSec: 10,
  mergedLongDurationSec: 7,
  overCompressedRatio: 0.25,
  overCompressedJaChars: 15,
  verboseEnRatio: 1.5,
  verboseCps: 17,
  maxLineLen: 42,
  slowCps: 3,
  maxExpandPerBlock: 3,
  maxCompressPerBlock: 5,
}

function block(seed: Pick<EnBlock, 'id' | 'start' | 'end' | 'jaText' | 'enText'> & Partial<EnBlock>): EnBlock {
  const enChars = countCpsChars(seed.enText)
  const duration = Math.max(0.001, seed.end - seed.start)
  return {
    jaChars: seed.jaText.replace(/\s/g, '').length,
    alignConf: 'exact',
    enRaw: seed.enText,
    enChars,
    cps: enChars / duration,
    maxLineLen: Math.max(...seed.enText.split('\n').map(line => line.length)),
    violation: 'ok',
    expandCount: 0,
    compressCount: 0,
    ...seed,
  }
}

describe('analyzeFragmentation', () => {
  it('reports short and incomplete adjacent cues as feasible merge candidates', () => {
    const result = analyzeFragmentation([
      block({
        id: 1,
        start: 0,
        end: 1.2,
        jaText: 'まず入力を見て、',
        enText: 'First, look at the input,',
      }),
      block({
        id: 2,
        start: 1.35,
        end: 3.5,
        jaText: '次に出力を確認します。',
        enText: 'then check the output.',
      }),
    ], thresholds, 'test')

    expect(result.blockCount).toBe(2)
    expect(result.underShortDurationCount).toBe(1)
    expect(result.sentenceIncompleteEndCount).toBe(1)
    expect(result.mergeCandidatePairCount).toBe(1)
    expect(result.constraintFeasibleMergePairCount).toBe(1)
    expect(result.entries[0]).toMatchObject({
      id: 1,
      mergeCandidateWithNext: true,
    })
    expect(result.entries[0].flags).toContain('under_short_duration')
    expect(result.entries[0].flags).toContain('sentence_incomplete_end')
  })

  it('keeps a merge candidate non-feasible when combined duration is too long', () => {
    const result = analyzeFragmentation([
      block({
        id: 1,
        start: 0,
        end: 1.2,
        jaText: 'まず入力を見て、',
        enText: 'First, look at the input,',
      }),
      block({
        id: 2,
        start: 1.3,
        end: 8.5,
        jaText: '次に長い説明を確認します。',
        enText: 'then check the long explanation in the next part.',
      }),
    ], thresholds, 'test')

    expect(result.mergeCandidatePairCount).toBe(1)
    expect(result.constraintFeasibleMergePairCount).toBe(0)
  })

  it('reports split candidates when a cue exceeds display budgets', () => {
    const result = analyzeFragmentation([
      block({
        id: 1,
        start: 0,
        end: 8.2,
        jaText: '長い説明です。',
        enText: 'This is a very long subtitle line that should be split because it exceeds the two line display budget.',
      }),
    ], thresholds, 'test')

    expect(result.splitCandidateCount).toBe(1)
    expect(result.entries[0].splitCandidate).toBe(true)
    expect(result.entries[0].splitCandidateReason).toContain('duration_over_merged_long_limit')
    expect(result.entries[0].splitCandidateReason).toContain('line_over_limit')
  })
})
