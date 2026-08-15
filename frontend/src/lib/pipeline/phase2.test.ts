import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultAdminSettings } from '@/api/adminSettings'
import type { AdminSettings } from '@/types/adminSettings'
import type { EnBlock, JaBlock, PipelineThresholds } from './blockTypes'
import type { CorrectedSegmentLite } from './correct'

/**
 * runPhase2 の generalRepairAgent 呼び出し条件の回帰テスト。
 *
 * 背景（本ブランチが作った不整合）: sourceTextLexicalOverlap（観測専用・correctedSegments が
 * 必須）と generalRepairAgent（修復・segments を引数に取らず blocks の violation だけで動く）
 * が同じ `if (options.correctedSegments...)` ブロックに入っていたため、correctedSegments が
 * 渡されない呼び出し経路では CPS・行長違反に対する最終修復が丸ごとスキップされていた。
 * phase2.ts の該当コメント参照。
 *
 * phase2.ts の他の依存（translateEn, correctionEngine 等の重い LLM 呼出し）は phase1.test.ts
 * と同様すべてモック化し、generalRepairAgent の呼び出し条件だけを単体で検証する。
 */

const mocks = vi.hoisted(() => ({
  translateEn: vi.fn(),
  formatLines: vi.fn((blocks: unknown) => blocks),
  checkCpsViolations: vi.fn((blocks: unknown) => blocks),
  correctionEngine: vi.fn(),
  createDecisionNode: vi.fn(() => ({})),
  mergeContextFragments: vi.fn(),
  finalSafeMerge: vi.fn(),
  cpsReliefRebalance: vi.fn(),
  semanticValidation: vi.fn(),
  measureSourceTextLexicalOverlap: vi.fn(),
  runGeneralRepairAgent: vi.fn(),
  tightenTiming: vi.fn(),
  closeSubtitleGaps: vi.fn(),
  formatCloseSubtitleGapsSummary: vi.fn(() => undefined),
  normalizeEnBlocks: vi.fn((blocks: unknown) => blocks),
  parseTextNormalizationConfig: vi.fn(() => ({})),
  analyzeInitialTranslations: vi.fn(),
  analyzeSplitEvenlyCandidates: vi.fn(),
}))

vi.mock('./translateEn', () => ({ translateEn: mocks.translateEn }))
vi.mock('./formatLines', () => ({ formatLines: mocks.formatLines }))
vi.mock('./checkCpsViolations', () => ({ checkCpsViolations: mocks.checkCpsViolations }))
vi.mock('./correctionAgent/loop', () => ({ correctionEngine: mocks.correctionEngine }))
vi.mock('./correctionAgent/decisionNode', () => ({ createDecisionNode: mocks.createDecisionNode }))
vi.mock('./contextMergeFragments', () => ({ mergeContextFragments: mocks.mergeContextFragments }))
vi.mock('./finalSafeMerge', () => ({ finalSafeMerge: mocks.finalSafeMerge }))
vi.mock('./cpsReliefRebalance', () => ({ cpsReliefRebalance: mocks.cpsReliefRebalance }))
vi.mock('./semanticValidation', () => ({ semanticValidation: mocks.semanticValidation }))
vi.mock('./sourceTextLexicalOverlap', () => ({
  measureSourceTextLexicalOverlap: mocks.measureSourceTextLexicalOverlap,
}))
vi.mock('./generalRepairAgent', () => ({ runGeneralRepairAgent: mocks.runGeneralRepairAgent }))
vi.mock('./tightenTiming', () => ({ tightenTiming: mocks.tightenTiming }))
vi.mock('./closeSubtitleGaps', () => ({
  closeSubtitleGaps: mocks.closeSubtitleGaps,
  formatCloseSubtitleGapsSummary: mocks.formatCloseSubtitleGapsSummary,
}))
vi.mock('./textNormalization', async (importOriginal) => {
  // DEFAULT_TEXT_NORMALIZATION_RULES_JSON 等の定数は getDefaultAdminSettings が参照するため、
  // 関数だけをモックに差し替え、それ以外の実体は importOriginal で温存する。
  const actual = await importOriginal<typeof import('./textNormalization')>()
  return {
    ...actual,
    normalizeEnBlocks: mocks.normalizeEnBlocks,
    parseTextNormalizationConfig: mocks.parseTextNormalizationConfig,
  }
})
vi.mock('./initialTranslationDiagnostics', () => ({
  analyzeInitialTranslations: mocks.analyzeInitialTranslations,
}))
vi.mock('./splitEvenlyDiagnostics', () => ({
  analyzeSplitEvenlyCandidates: mocks.analyzeSplitEvenlyCandidates,
}))

// vi.mock はホイストされるため、モック対象を import する側は必ずこの後に置く。
const { runPhase2 } = await import('./phase2')

function settings(overrides: Partial<AdminSettings> = {}): AdminSettings {
  return {
    ...getDefaultAdminSettings(),
    // 本テストでは generalRepairAgent の呼び出し条件だけを見たいので、
    // 他の分岐（textNormalization / semanticValidation）は無効化しておく。
    textNormalizationEnabled: false,
    semanticCheckMode: 'off',
    generalRepairEnabled: true,
    ...overrides,
  }
}

const thresholds: PipelineThresholds = {
  shortDurationSec: 1,
  longDurationSec: 8,
  mergedLongDurationSec: 10,
  overCompressedRatio: 0.5,
  overCompressedJaChars: 40,
  verboseCps: 20,
  maxLineLen: 42,
  slowCps: 5,
  maxExpandPerBlock: 3,
  maxCompressPerBlock: 3,
}

const runNode = async <T>(_nodeId: string, run: () => Promise<T> | T): Promise<T> => run()

function makeJaBlock(id: number): JaBlock {
  return { id, start: id, end: id + 1, jaText: `原文${id}`, jaChars: 5, alignConf: 'exact' }
}

function makeEnBlock(id: number): EnBlock {
  return {
    ...makeJaBlock(id),
    enText: `translated ${id}`,
    enChars: 12,
    cps: 20,
    maxLineLen: 12,
    // needsCorrection（correctionEngine の起動条件）には該当させず、
    // かつ hasResidualViolations（'ok' でも 'slow_speech' でもない）には該当させる
    // 違反コードを選び、correctionEngine を起動せずに generalRepairAgent の起動条件だけを検証する。
    violation: 'proportional_ts',
    expandCount: 0,
    compressCount: 0,
  }
}

function makeCorrectedSegment(id: number): CorrectedSegmentLite {
  return {
    id,
    start: id,
    end: id + 1,
    text: `原文${id}`,
    correctedText: `原文${id}`,
    correctionDistance: 0,
    correctionFlagged: false,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.translateEn.mockImplementation((jaBlocks: JaBlock[]) => jaBlocks.map((b) => makeEnBlock(b.id)))
  mocks.mergeContextFragments.mockImplementation((blocks: unknown) => blocks)
  mocks.finalSafeMerge.mockImplementation((blocks: unknown) => ({ blocks }))
  mocks.cpsReliefRebalance.mockImplementation((blocks: unknown) => ({ blocks }))
  mocks.tightenTiming.mockImplementation((blocks: unknown) => ({ blocks }))
  mocks.closeSubtitleGaps.mockImplementation((blocks: unknown) => ({ blocks, closedCount: 0 }))
  mocks.runGeneralRepairAgent.mockImplementation((blocks: unknown) => Promise.resolve({ blocks }))
  mocks.measureSourceTextLexicalOverlap.mockReturnValue({ observations: [] })
  mocks.analyzeInitialTranslations.mockReturnValue({ totalBlocks: 1, observedBlockCount: 0, observations: [] })
  mocks.analyzeSplitEvenlyCandidates.mockReturnValue({ consideredPairCount: 0, candidateCount: 0, observations: [] })
})

describe('runPhase2 — generalRepairAgent は correctedSegments の有無に依存しない（不整合修正の回帰テスト）', () => {
  it('correctedSegments が渡されない場合でも generalRepairAgent が呼ばれる', async () => {
    const jaBlocks = [makeJaBlock(1)]

    await runPhase2(jaBlocks, settings(), thresholds, runNode, undefined, [], {})

    expect(mocks.runGeneralRepairAgent).toHaveBeenCalledTimes(1)
    // 観測専用の sourceTextLexicalOverlap は segments 必須のため呼ばれない
    expect(mocks.measureSourceTextLexicalOverlap).not.toHaveBeenCalled()
  })

  it('correctedSegments が空配列の場合でも generalRepairAgent が呼ばれる', async () => {
    const jaBlocks = [makeJaBlock(1)]

    await runPhase2(jaBlocks, settings(), thresholds, runNode, undefined, [], { correctedSegments: [] })

    expect(mocks.runGeneralRepairAgent).toHaveBeenCalledTimes(1)
    expect(mocks.measureSourceTextLexicalOverlap).not.toHaveBeenCalled()
  })

  it('correctedSegments が渡された場合は sourceTextLexicalOverlap と generalRepairAgent の両方が呼ばれる', async () => {
    const jaBlocks = [makeJaBlock(1)]
    const correctedSegments = [makeCorrectedSegment(1)]

    await runPhase2(jaBlocks, settings(), thresholds, runNode, undefined, [], { correctedSegments })

    expect(mocks.measureSourceTextLexicalOverlap).toHaveBeenCalledTimes(1)
    expect(mocks.runGeneralRepairAgent).toHaveBeenCalledTimes(1)
  })

  it('generalRepairEnabled が false の場合は generalRepairAgent が呼ばれない', async () => {
    const jaBlocks = [makeJaBlock(1)]

    await runPhase2(jaBlocks, settings({ generalRepairEnabled: false }), thresholds, runNode, undefined, [], {})

    expect(mocks.runGeneralRepairAgent).not.toHaveBeenCalled()
  })

  it('残存違反がない場合は generalRepairAgent が呼ばれない', async () => {
    mocks.translateEn.mockImplementation((jaBlocks: JaBlock[]) =>
      jaBlocks.map((b) => ({ ...makeEnBlock(b.id), violation: 'ok' as const })),
    )
    const jaBlocks = [makeJaBlock(1)]

    await runPhase2(jaBlocks, settings(), thresholds, runNode, undefined, [], {})

    expect(mocks.runGeneralRepairAgent).not.toHaveBeenCalled()
  })

  it('初訳直後とretime-only後の診断を観測nodeとして記録する', async () => {
    mocks.translateEn.mockImplementation((jaBlocks: JaBlock[]) =>
      jaBlocks.map((b) => ({ ...makeEnBlock(b.id), violation: 'ok' as const })),
    )
    const nodeIds: string[] = []
    const recordingRunNode = async <T>(nodeId: string, run: () => Promise<T> | T): Promise<T> => {
      nodeIds.push(nodeId)
      return run()
    }

    await runPhase2([makeJaBlock(1)], settings(), thresholds, recordingRunNode, undefined, ['用語 => term'])

    expect(mocks.analyzeInitialTranslations).toHaveBeenCalledWith(expect.any(Array), ['用語 => term'])
    expect(mocks.analyzeSplitEvenlyCandidates).toHaveBeenCalledWith(expect.any(Array), thresholds)
    expect(nodeIds.indexOf('initialTranslationDiagnostics')).toBeGreaterThan(nodeIds.indexOf('translateEn'))
    expect(nodeIds.indexOf('splitEvenlyDiagnostics')).toBeGreaterThan(nodeIds.indexOf('cpsReliefRebalance'))
  })
})
