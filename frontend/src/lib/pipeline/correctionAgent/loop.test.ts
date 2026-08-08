import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

// canApply もモック可能にしておく（Tool.canApply が feasible 絞り込みに使われることを
// 検証するテスト用）。既定は true を返し、各ツールが呼ばれること自体は既存テストの前提を崩さない。
const toolCanApplyMocks = vi.hoisted(() => ({
  compress_micro: vi.fn(() => true),
  compress_rephrase: vi.fn(() => true),
  compress_trim: vi.fn(() => true),
  compress_core: vi.fn(() => true),
  split_block: vi.fn(() => true),
  borrow_gap: vi.fn(() => true),
  offload_neighbor: vi.fn(() => true),
}))

vi.mock('./tools/index', () => ({
  toolRegistry: {
    compress_micro: { name: 'compress_micro', description: '', canApply: toolCanApplyMocks.compress_micro, execute: toolExecuteMocks.compress_micro },
    compress_rephrase: { name: 'compress_rephrase', description: '', canApply: toolCanApplyMocks.compress_rephrase, execute: toolExecuteMocks.compress_rephrase },
    compress_trim: { name: 'compress_trim', description: '', canApply: toolCanApplyMocks.compress_trim, execute: toolExecuteMocks.compress_trim },
    compress_core: { name: 'compress_core', description: '', canApply: toolCanApplyMocks.compress_core, execute: toolExecuteMocks.compress_core },
    split_block: { name: 'split_block', description: '', canApply: toolCanApplyMocks.split_block, execute: toolExecuteMocks.split_block },
    borrow_gap: { name: 'borrow_gap', description: '', canApply: toolCanApplyMocks.borrow_gap, execute: toolExecuteMocks.borrow_gap },
    offload_neighbor: { name: 'offload_neighbor', description: '', canApply: toolCanApplyMocks.offload_neighbor, execute: toolExecuteMocks.offload_neighbor },
  },
}))

// vi.mock はホイストされるため、モック対象を import する側は必ずこの後に置く。
const { correctionEngine } = await import('./loop')
const { meetsConstraints } = await import('./patchUtils')

afterEach(() => {
  vi.resetAllMocks()
})

// resetAllMocks は canApply の既定実装（() => true）も消してしまうため、テストごとに
// 立て直す。個々のテストで false に上書きしたい場合はテスト内で mockReturnValue(false) する。
beforeEach(() => {
  for (const mock of Object.values(toolCanApplyMocks)) mock.mockReturnValue(true)
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

  it('splitFrom が自分自身を指す分割ブロックでも、correctionAttempts に同じ履歴が重複しない', async () => {
    // splitBlock.ts は分割の1個目のユニットに元ブロックと同じ id を割り当てたうえで、
    // 全ユニットに splitFrom = 元ブロックの id を付ける。そのため1個目のユニットは
    // splitFrom === 自分の id になる。attachAttemptHistories が sourceId と block.id の
    // 一致を確認せずに sourceHistory を連結すると、同じ Map エントリ（split_block の
    // 1回の試行）が ownHistory と sourceHistory の両方から連結されて2回記録されてしまう
    // （実データでは correctionAttempts の水増しにつながった回帰）。
    const block = makeBlock()
    const thresholds = makeThresholds()
    const decisionNode = makeDecisionNode(['split_block'])

    const shortTextA = 'Short first half.'
    const shortTextB = 'Short second half.'
    const childA: EnBlock = {
      ...block,
      id: block.id,
      start: 0,
      end: 2.5,
      jaText: 'これは前半です',
      jaChars: 7,
      enText: shortTextA,
      enRaw: shortTextA,
      enChars: countCpsChars(shortTextA),
      cps: countCpsChars(shortTextA) / 2.5,
      maxLineLen: shortTextA.length,
      violation: 'ok',
    }
    ;(childA as unknown as Record<string, unknown>).splitFrom = block.id
    const childB: EnBlock = {
      ...block,
      id: block.id * 1000 + 2,
      start: 2.5,
      end: 5,
      jaText: 'これは後半です',
      jaChars: 7,
      enText: shortTextB,
      enRaw: shortTextB,
      enChars: countCpsChars(shortTextB),
      cps: countCpsChars(shortTextB) / 2.5,
      maxLineLen: shortTextB.length,
      violation: 'ok',
    }
    ;(childB as unknown as Record<string, unknown>).splitFrom = block.id

    toolExecuteMocks.split_block.mockResolvedValueOnce({
      replaceBlocks: [childA, childB],
      dirtyBlockIds: [String(childA.id), String(childB.id)],
      changed: true,
    } satisfies TimelinePatch)

    const result = await correctionEngine([block], [0], decisionNode, settings, thresholds)

    // split_block は1回しか実行されていないので、1個目のユニット（splitFrom === 自分の id）の
    // correctionAttempts も1件だけであるべき（重複していれば2件になる）。
    const first = result.find((b) => b.id === block.id)
    expect(first?.correctionAttempts).toHaveLength(1)
    expect(first?.correctionAttempts?.[0].strategy).toBe('split_block')

    // 2個目のユニット（splitFrom !== 自分の id）は親の履歴を正しく1回だけ引き継ぐ。
    const second = result.find((b) => b.id === block.id * 1000 + 2)
    expect(second?.correctionAttempts).toHaveLength(1)
  })

  it('canApply が false を返すツールは feasible 候補から除外される', async () => {
    const block = makeBlock()
    const thresholds = makeThresholds()
    toolCanApplyMocks.compress_trim.mockReturnValue(false)

    let capturedFeasible: CorrectionStrategy[] = []
    const decisionNode: DecisionNode = {
      decide: vi.fn(async (_ctx, feasible): Promise<CorrectionStrategy> => {
        capturedFeasible = feasible
        return 'compress_rephrase'
      }),
    }
    const shortText = 'Short subtitle text.'
    const shortChars = countCpsChars(shortText)
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

    await correctionEngine([block], [0], decisionNode, settings, thresholds)

    // compress_trim は canApply=false なので decide に渡る feasible には含まれず、
    // execute も一度も呼ばれない。同じ理由で feasible になるはずの他の戦略は残る。
    expect(capturedFeasible).not.toContain('compress_trim')
    expect(capturedFeasible).toContain('compress_rephrase')
    expect(toolExecuteMocks.compress_trim).not.toHaveBeenCalled()
    expect(toolCanApplyMocks.compress_trim).toHaveBeenCalled()
  })
})
