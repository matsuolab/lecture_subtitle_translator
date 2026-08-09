import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultAdminSettings } from '@/api/adminSettings'
import type { AdminSettings } from '@/types/adminSettings'
import type { JaBlock, PipelineThresholds } from './blockTypes'
import type { CorrectedSegmentLite } from './correct'
import type { TranscriptSegment } from './types'

/**
 * runPhase1 の「部分失敗の誤報防止」ロジック単体テスト。
 *
 * 背景（本番事故）: correctJa が 333 件中 332 件失敗しながら、trace には
 * `correctJa success 187s` としか出ず、失敗の事実がどこにも記録されなかった
 * （partialFailureSummary.ts の JSDoc 参照）。
 *
 * correctSegments / semanticSplitJa / contextGroupCueBlocks / mergeShort は実際の LLM 呼出を
 * 伴う重い依存なので、ここでは phase1.ts 自身の警告発火ロジックだけを単体で検証するために
 * すべてモック化する（統合レベルの実LLM検証は correct.test.ts / translateEn.test.ts が担う）。
 */

const mocks = vi.hoisted(() => ({
  correctSegments: vi.fn(),
  semanticSplitJa: vi.fn(),
  contextGroupCueBlocks: vi.fn(),
  reindexContextGroups: vi.fn((blocks: unknown) => blocks),
  mergeShort: vi.fn((blocks: unknown) => blocks),
  runCorrectionDebug: vi.fn(),
  isCorrectionDebugEnabled: vi.fn(() => false),
}))

vi.mock('./correct', () => ({ correctSegments: mocks.correctSegments }))
vi.mock('./semanticSplitJa', () => ({ semanticSplitJa: mocks.semanticSplitJa }))
vi.mock('./contextGrouping', () => ({
  contextGroupCueBlocks: mocks.contextGroupCueBlocks,
  reindexContextGroups: mocks.reindexContextGroups,
}))
vi.mock('./mergeShort', () => ({ mergeShort: mocks.mergeShort }))
vi.mock('./correctionDebug', () => ({
  runCorrectionDebug: mocks.runCorrectionDebug,
  isCorrectionDebugEnabled: mocks.isCorrectionDebugEnabled,
}))

// vi.mock はホイストされるため、モック対象を import する側は必ずこの後に置く。
const { runPhase1 } = await import('./phase1')

function settings(overrides: Partial<AdminSettings> = {}): AdminSettings {
  return { ...getDefaultAdminSettings(), ...overrides }
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

function makeCorrected(id: number, failureReason?: string): CorrectedSegmentLite {
  const out: CorrectedSegmentLite = {
    id,
    start: id,
    end: id + 1,
    text: `原文${id}`,
    correctedText: `補正済み${id}`,
    correctionDistance: 0,
    correctionFlagged: false,
  }
  if (failureReason !== undefined) out.correctionFailureReason = failureReason
  return out
}

function makeBlock(id: number): JaBlock {
  return { id, start: id, end: id + 1, jaText: `補正済み${id}`, jaChars: 5, alignConf: 'exact' }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.isCorrectionDebugEnabled.mockReturnValue(false)
  mocks.reindexContextGroups.mockImplementation((blocks: unknown) => blocks)
  mocks.mergeShort.mockImplementation((blocks: unknown) => blocks)
})

describe('runPhase1 — correctJa の部分失敗を trace の警告として残す（誤報防止の回帰テスト）', () => {
  it('correctJa が大量失敗した場合、onWarning に CRITICAL な件数付きメッセージが渡る', async () => {
    const corrected = [
      makeCorrected(1, 'http_400: context_size_exceeded ...'),
      makeCorrected(2, 'http_400: context_size_exceeded ...'),
      makeCorrected(3),
    ]
    mocks.correctSegments.mockResolvedValue(corrected)
    mocks.semanticSplitJa.mockResolvedValue({
      blocks: corrected.map((seg) => makeBlock(seg.id)),
      scriptResolution: { script: 'japanese', source: 'auto_detected', meanTokenLength: 1, tokenCount: 1 },
    })
    mocks.contextGroupCueBlocks.mockResolvedValue({
      blocks: corrected.map((seg) => makeBlock(seg.id)),
      detectionCount: 0,
      detectionSuccess: 0,
      detectionFailed: 0,
      groupCount: 0,
      groupedBlockCount: 0,
    })

    const transcriptSegments: TranscriptSegment[] = corrected.map((seg) => ({ id: seg.id, start: seg.start, end: seg.end, text: seg.text }))
    const onWarning = vi.fn()

    await runPhase1(transcriptSegments, settings(), thresholds, runNode, onWarning, {})

    const correctJaWarnings = onWarning.mock.calls.filter(([nodeId]) => nodeId === 'correctJa')
    expect(correctJaWarnings).toHaveLength(1)
    const [, message] = correctJaWarnings[0]
    expect(message).toContain('CRITICAL')
    expect(message).toContain('2 of 3')
  })

  it('correctJa がすべて成功した場合、onWarning は correctJa に対して呼ばれない', async () => {
    const corrected = [makeCorrected(1), makeCorrected(2), makeCorrected(3)]
    mocks.correctSegments.mockResolvedValue(corrected)
    mocks.semanticSplitJa.mockResolvedValue({
      blocks: corrected.map((seg) => makeBlock(seg.id)),
      scriptResolution: { script: 'japanese', source: 'auto_detected', meanTokenLength: 1, tokenCount: 1 },
    })
    mocks.contextGroupCueBlocks.mockResolvedValue({
      blocks: corrected.map((seg) => makeBlock(seg.id)),
      detectionCount: 0,
      detectionSuccess: 0,
      detectionFailed: 0,
      groupCount: 0,
      groupedBlockCount: 0,
    })

    const transcriptSegments: TranscriptSegment[] = corrected.map((seg) => ({ id: seg.id, start: seg.start, end: seg.end, text: seg.text }))
    const onWarning = vi.fn()

    await runPhase1(transcriptSegments, settings(), thresholds, runNode, onWarning, {})

    expect(onWarning.mock.calls.some(([nodeId]) => nodeId === 'correctJa')).toBe(false)
  })
})
