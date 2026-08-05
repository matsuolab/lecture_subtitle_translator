import { afterEach, describe, expect, it, vi } from 'vitest'

import { getDefaultAdminSettings } from '@/api/adminSettings'
import type { AdminSettings } from '@/types/adminSettings'
import type { EnBlock, PipelineThresholds } from '../blockTypes'
import type { AgentThresholds, CorrectionStrategy, DecisionNode, TimelinePatch } from './types'
import { countCpsChars } from '../../subtitleMetrics'

/**
 * correctionEngine（correctionAgent ループ）の単体テスト。
 *
 * 背景（実機データ・117分・923キューで実測済み）:
 * 従来は戦略が失敗すると即座にそのブロックを queue から捨てていたため、
 * split_block の失敗77件・compress_* の試行不足（実害違反84件に対し2回のみ）が
 * すべて「1回試して終わり」になっていた。再キューは applyPatch 成功後にしか
 * 存在しなかったため、maxCorrectionRounds（4回）も shouldEarlyTerminate（2連続失敗）
 * も成功が続いた場合にしか到達しなかった。
 *
 * 本テストは次を検証する:
 * 1. 戦略が失敗したブロックが、次のラウンドで別の戦略を試されること
 * 2. 同じ戦略で2回続けて失敗したら打ち切られること
 * 3. 異なる戦略で3回連続失敗したら no_meaningful_reduction で打ち切られること
 * 4. maxCorrectionRounds を超えて試行されないこと
 * 5. 成功した場合の挙動が従来どおりであること
 *
 * tools/index（LLM 呼び出しを含む）は全面的にモックし、実 LLM 呼び出しは発生させない。
 * decisionNode も呼び出し元（本テスト）が戦略を明示的に注入するモックを渡す。
 */

const toolExecuteMocks = vi.hoisted(() => ({
  compress_micro: vi.fn(),
  compress_rephrase: vi.fn(),
  compress_trim: vi.fn(),
  compress_core: vi.fn(),
  split_block: vi.fn(),
  borrow_gap: vi.fn(),
  offload_neighbor: vi.fn(),
}))

vi.mock('./tools/index', () => ({
  toolRegistry: {
    compress_micro: { name: 'compress_micro', description: '', canApply: () => true, execute: toolExecuteMocks.compress_micro },
    compress_rephrase: { name: 'compress_rephrase', description: '', canApply: () => true, execute: toolExecuteMocks.compress_rephrase },
    compress_trim: { name: 'compress_trim', description: '', canApply: () => true, execute: toolExecuteMocks.compress_trim },
    compress_core: { name: 'compress_core', description: '', canApply: () => true, execute: toolExecuteMocks.compress_core },
    split_block: { name: 'split_block', description: '', canApply: () => true, execute: toolExecuteMocks.split_block },
    borrow_gap: { name: 'borrow_gap', description: '', canApply: () => true, execute: toolExecuteMocks.borrow_gap },
    offload_neighbor: { name: 'offload_neighbor', description: '', canApply: () => true, execute: toolExecuteMocks.offload_neighbor },
  },
}))

// vi.mock はホイストされるため、モック対象を import する側は必ずこの後に置く。
const { correctionEngine } = await import('./loop')
const { meetsConstraints } = await import('./patchUtils')

afterEach(() => {
  vi.resetAllMocks()
})

const pipelineThresholds: PipelineThresholds = {
  shortDurationSec: 1.5,
  longDurationSec: 10,
  mergedLongDurationSec: 7,
  overCompressedRatio: 0.25,
  overCompressedJaChars: 15,
  verboseEnRatio: 1.5,
  verboseCps: 17,
  maxLineLen: 200, // 行長違反を本テストの関心事から外すため十分大きくする
  slowCps: 3,
  maxExpandPerBlock: 3,
  maxCompressPerBlock: 5,
}

function makeThresholds(overrides: Partial<AgentThresholds> = {}): PipelineThresholds & AgentThresholds {
  return {
    ...pipelineThresholds,
    maxCorrectionRounds: 4,
    minMeaningfulChars: 20,
    minInterSubtitleGapMs: 80,
    minUsefulBorrowMs: 250,
    maxLeadMs: 300,
    maxLagMs: 700,
    minReductionDeltaChars: 4,
    minReductionDeltaRatio: 0.03,
    subtitleMinDurationSec: 0.833,
    maxSplitDepth: 1,
    enableOffloadNeighbor: false,
    useAgentDecision: false,
    ...overrides,
  }
}

const settings: AdminSettings = { ...getDefaultAdminSettings(), semanticCheckMode: 'off' }

function makeBlock(overrides: Partial<EnBlock> = {}): EnBlock {
  const enText = overrides.enText ?? 'x'.repeat(100)
  return {
    id: 1,
    start: 0,
    end: 5,
    jaText: 'これはテスト用の長い日本語のテキストです',
    jaChars: 20,
    alignConf: 'exact',
    enText,
    enRaw: enText,
    enChars: countCpsChars(enText),
    cps: countCpsChars(enText) / 5,
    maxLineLen: enText.length,
    violation: 'cps_over',
    expandCount: 0,
    compressCount: 0,
    ...overrides,
  }
}

function failPatch(block: EnBlock): TimelinePatch {
  return {
    replaceBlocks: [{ ...block }],
    dirtyBlockIds: [],
    changed: false,
  }
}

/** strategies を呼び出し順に返す decisionNode モック。想定回数を超えて呼ばれたら例外を投げる。 */
function makeDecisionNode(strategies: CorrectionStrategy[]): DecisionNode {
  const decide = vi.fn(async (): Promise<CorrectionStrategy> => {
    throw new Error('decide unexpectedly called more times than the test expects')
  })
  for (const strategy of strategies) {
    decide.mockImplementationOnce(async () => strategy)
  }
  return { decide }
}

describe('correctionEngine', () => {
  it('戦略が失敗したブロックは、次のラウンドで別の戦略が試される', async () => {
    const block = makeBlock()
    const thresholds = makeThresholds({ maxCorrectionRounds: 2 })
    const decisionNode = makeDecisionNode(['split_block', 'compress_rephrase'])

    toolExecuteMocks.split_block.mockResolvedValueOnce(failPatch(block))
    toolExecuteMocks.compress_rephrase.mockResolvedValueOnce(failPatch(block))

    await correctionEngine([block], [0], decisionNode, settings, thresholds)

    // split_block が失敗しても捨てられず、次のラウンドで compress_rephrase が試された
    expect(toolExecuteMocks.split_block).toHaveBeenCalledTimes(1)
    expect(toolExecuteMocks.compress_rephrase).toHaveBeenCalledTimes(1)
    expect(decisionNode.decide).toHaveBeenCalledTimes(2)
  })

  it('同じ戦略で2回連続失敗すると consecutive_failed_attempts で打ち切られる', async () => {
    const block = makeBlock()
    const thresholds = makeThresholds() // maxCorrectionRounds: 4（デフォルト）
    const decisionNode = makeDecisionNode(['compress_trim', 'compress_trim'])
    const onToolWarning = vi.fn()

    toolExecuteMocks.compress_trim.mockResolvedValue(failPatch(block))

    await correctionEngine([block], [0], decisionNode, settings, thresholds, { onToolWarning })

    // 3回目の同一戦略は試みられず、2回で打ち切られる
    expect(decisionNode.decide).toHaveBeenCalledTimes(2)
    expect(toolExecuteMocks.compress_trim).toHaveBeenCalledTimes(2)
    expect(onToolWarning).toHaveBeenCalledWith(
      String(block.id),
      'compress_trim',
      expect.stringContaining('consecutive_failed_attempts'),
    )
  })

  it('異なる戦略で3回連続失敗すると no_meaningful_reduction で打ち切られる', async () => {
    const block = makeBlock()
    const thresholds = makeThresholds() // maxCorrectionRounds: 4（デフォルト）
    const decisionNode = makeDecisionNode(['compress_rephrase', 'compress_trim', 'compress_core'])
    const onToolWarning = vi.fn()

    toolExecuteMocks.compress_rephrase.mockResolvedValueOnce(failPatch(block))
    toolExecuteMocks.compress_trim.mockResolvedValueOnce(failPatch(block))
    toolExecuteMocks.compress_core.mockResolvedValueOnce(failPatch(block))

    await correctionEngine([block], [0], decisionNode, settings, thresholds, { onToolWarning })

    // 戦略を変え続けているので consecutive_failed_attempts では止まらず、3試行目まで進む
    expect(decisionNode.decide).toHaveBeenCalledTimes(3)
    expect(onToolWarning).toHaveBeenCalledWith(
      String(block.id),
      'compress_core',
      expect.stringContaining('no_meaningful_reduction'),
    )
  })

  it('maxCorrectionRounds を超えて試行されない', async () => {
    const block = makeBlock()
    const thresholds = makeThresholds({ maxCorrectionRounds: 3 })
    const decisionNode = makeDecisionNode(['compress_rephrase', 'compress_trim', 'compress_core'])

    toolExecuteMocks.compress_rephrase.mockResolvedValueOnce(failPatch(block))
    toolExecuteMocks.compress_trim.mockResolvedValueOnce(failPatch(block))
    toolExecuteMocks.compress_core.mockResolvedValueOnce(failPatch(block))

    await correctionEngine([block], [0], decisionNode, settings, thresholds)

    // 3戦略とも異なるため早期終了条件（同一戦略連続 / 3連続無進展）には該当しないが、
    // maxCorrectionRounds=3 を超えて4回目は試みられない
    expect(decisionNode.decide).toHaveBeenCalledTimes(3)
  })

  it('成功した場合は従来どおりパッチが適用され、解消済みブロックは再キューされない', async () => {
    const block = makeBlock()
    const thresholds = makeThresholds()
    const shortText = 'This is a nicely rephrased short line for the subtitle.'
    const shortChars = countCpsChars(shortText)
    const decisionNode = makeDecisionNode(['compress_rephrase'])

    toolExecuteMocks.compress_rephrase.mockResolvedValueOnce({
      replaceBlocks: [{
        ...block,
        enText: shortText,
        enRaw: shortText,
        enChars: shortChars,
        cps: shortChars / 5,
      }],
      dirtyBlockIds: [String(block.id)],
      changed: true,
    } satisfies TimelinePatch)

    const result = await correctionEngine([block], [0], decisionNode, settings, thresholds)

    // 1回で解消されるので、2回目の decide は呼ばれない（dirtyBlockIds に自身を含めても
    // meetsConstraints が true になった時点で再キューされない、という既存挙動を保つ）
    expect(decisionNode.decide).toHaveBeenCalledTimes(1)
    expect(toolExecuteMocks.compress_rephrase).toHaveBeenCalledTimes(1)
    expect(result[0].enText).toBe(shortText)
    expect(meetsConstraints(result[0])).toBe(true)
    expect(result[0].correctionAttempts).toHaveLength(1)
    expect(result[0].correctionAttempts?.[0].changed).toBe(true)
  })
})
