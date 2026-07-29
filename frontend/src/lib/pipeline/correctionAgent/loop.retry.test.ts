import { describe, expect, it, vi } from 'vitest'
import type { AdminSettings } from '@/types/adminSettings'
import type { EnBlock, PipelineThresholds } from '../blockTypes'
import type { AgentThresholds, CorrectionStrategy, DecisionNode } from './types'
import { buildAgentThresholds } from './types'

// 全ツールを「何も変えずに失敗する」モックへ差し替える。
// これにより「1つの戦略が失敗したあと、別の戦略を試すか」だけを純粋に観測できる。
const executed: CorrectionStrategy[] = []
vi.mock('./tools/index', () => {
  const makeTool = (strategy: string) => ({
    strategy,
    canApply: () => true,
    execute: async () => {
      executed.push(strategy as CorrectionStrategy)
      return { changed: false, replaceBlocks: [], dirtyBlockIds: [], warning: `${strategy}: mock failure` }
    },
  })
  return {
    toolRegistry: {
      compress_micro: makeTool('compress_micro'),
      compress_rephrase: makeTool('compress_rephrase'),
      compress_trim: makeTool('compress_trim'),
      compress_core: makeTool('compress_core'),
      split_block: makeTool('split_block'),
      borrow_gap: makeTool('borrow_gap'),
      offload_neighbor: makeTool('offload_neighbor'),
    },
  }
})

const { correctionEngine } = await import('./loop')

const thresholds: PipelineThresholds & AgentThresholds = {
  shortDurationSec: 1.5,
  longDurationSec: 14,
  mergedLongDurationSec: 12,
  overCompressedRatio: 0.25,
  overCompressedJaChars: 15,
  verboseEnRatio: 1.5,
  verboseCps: 17,
  maxLineLen: 80,
  slowCps: 3,
  maxExpandPerBlock: 3,
  maxCompressPerBlock: 5,
  ...buildAgentThresholds(),
}

const settings = { semanticCheckMode: 'off', qualityCorrectionThreshold: 0.15 } as AdminSettings

/** CPS 超過（verbose_en）の block。physicalMaxChars = 17*3 = 51 で minMeaningfulChars(20) は超える。 */
function violatingBlock(): EnBlock {
  const text = 'x'.repeat(100)
  return {
    id: 1,
    start: 0,
    end: 3,
    jaText: 'ソース',
    jaChars: 60,
    alignConf: 'exact',
    enText: text,
    enRaw: text,
    enChars: 100,
    cps: 100 / 3,
    maxLineLen: 100,
    violation: 'verbose_en',
  } as EnBlock
}

/** feasible の先頭を選ぶだけの決定ノード（LLM を使わない）。 */
const firstFeasibleNode: DecisionNode = {
  decide: async (_ctx, feasible) => feasible[0],
}

describe('correctionEngine — 失敗した戦略のあとに別の戦略を試すか', () => {
  it('1つの戦略が失敗しても、残りの feasible な戦略を試す', async () => {
    executed.length = 0
    const result = await correctionEngine([violatingBlock()], [0], firstFeasibleNode, settings, thresholds)

    const attempts = result[0].correctionAttempts ?? []
    // 設計上 maxCorrectionRounds=4 まで試行でき、feasibility は tried を除外する。
    // 1 回で打ち切られるなら、複数戦略を持つ意味も早期終了判定も働かない。
    expect(attempts.length, `試行された戦略: ${executed.join(', ')}`).toBeGreaterThan(1)
    // 同じ戦略を繰り返していないこと
    expect(new Set(executed).size).toBe(executed.length)
  })

  it('試行回数は maxCorrectionRounds を超えない', async () => {
    executed.length = 0
    const result = await correctionEngine([violatingBlock()], [0], firstFeasibleNode, settings, thresholds)
    expect((result[0].correctionAttempts ?? []).length).toBeLessThanOrEqual(thresholds.maxCorrectionRounds)
  })
})

describe('correctionEngine — 短い cue でも修復を試みるか', () => {
  it('日本語字幕の文字数予算（CPS 4.0 × 3.9秒 = 15文字）でも試行される', async () => {
    executed.length = 0
    // 英→日プリセット相当。physicalMaxChars = floor(4.0 * 3.9) = 15
    const jaThresholds: PipelineThresholds & AgentThresholds = {
      ...thresholds,
      verboseCps: 4.0,
      maxLineLen: 25,
      subtitleScript: 'japanese',
    }
    const block = {
      ...violatingBlock(),
      end: 3.9,
      enText: 'あ'.repeat(35),
      enRaw: 'あ'.repeat(35),
      enChars: 35,
      cps: 35 / 3.9,
    } as EnBlock

    const result = await correctionEngine([block], [0], firstFeasibleNode, settings, jaThresholds)
    expect(
      (result[0].correctionAttempts ?? []).length,
      'minMeaningfulChars(20) が英語基準のため、日本語の cue が丸ごとスキップされていないか',
    ).toBeGreaterThan(0)
  })
})
