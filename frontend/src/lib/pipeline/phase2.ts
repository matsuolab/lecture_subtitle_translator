import type { AdminSettings } from '@/types/adminSettings'
import type { EnBlock, JaBlock, PipelineThresholds } from './blockTypes'
import type { CorrectedSegmentLite } from './correct'
import { checkCpsViolations } from './checkCpsViolations'
import { formatLines } from './formatLines'
import { translateEn } from './translateEn'
import { correctionEngine } from './correctionAgent/loop'
import { createDecisionNode } from './correctionAgent/decisionNode'
import { buildAgentThresholds } from './correctionAgent/types'
import { mergeContextFragments } from './contextMergeFragments'
import { semanticValidation } from './semanticValidation'
import { validateCoverage } from './coverageValidator'
import { runCoverageRepairAgent } from './coverageRepairAgent'
import { runGeneralRepairAgent } from './generalRepairAgent'
import { redistributeJaSpan } from './redistributeJaSpan'
import { tightenTiming } from './tightenTiming'

type RunNode = <T>(nodeId: string, run: () => Promise<T> | T) => Promise<T>

// ツール警告コールバック: blockId, strategy, LLM 実レスポンスを含む診断メッセージ
type OnWarning = (nodeId: string, message: string) => void

export interface Phase2Options {
  correctedSegments?: CorrectedSegmentLite[]
}

export async function runPhase2(
  jaBlocks: JaBlock[],
  settings: AdminSettings,
  thresholds: PipelineThresholds,
  runNode: RunNode,
  onWarning?: OnWarning,
  glossaryTerms: string[] = [],
  options: Phase2Options = {},
): Promise<EnBlock[]> {
  let blocks = await runNode('translateEn', () => translateEn(jaBlocks, settings, glossaryTerms))
  blocks = await runNode('formatLines', () => formatLines(blocks, thresholds))
  blocks = await runNode('checkCpsViolations', () => checkCpsViolations(blocks, thresholds))

  const violatingIndices = blocks
    .map((b, i) => (needsCorrection(b) ? i : -1))
    .filter(i => i !== -1)

  if (violatingIndices.length > 0) {
    const agentThresholds = buildAgentThresholds({
      subtitleMinDurationSec: settings.subtitleMinDurationSec,
    })
    const combinedThresholds = { ...thresholds, ...agentThresholds }
    const decisionNode = createDecisionNode(agentThresholds.useAgentDecision)

    blocks = await runNode('correctionEngine', () =>
      correctionEngine(blocks, violatingIndices, decisionNode, settings, combinedThresholds, {
        onToolWarning: (blockId, strategy, message) => {
          onWarning?.(`correctionEngine[block=${blockId},${strategy}]`, message)
        },
      }),
    )
  }

  // 最終 semantic check ノード（log_only / enforce 時のみ動作）
  if (settings.semanticCheckMode !== 'off') {
    blocks = await runNode('semanticValidation', () =>
      semanticValidation(blocks, settings, (blockId, message) => {
        onWarning?.(`semanticValidation[block=${blockId}]`, message)
      }),
    )
  }

  blocks = await runNode('mergeContextFragments', () =>
    mergeContextFragments(blocks, settings, thresholds, (blockId, message) => {
      onWarning?.(`mergeContextFragments[block=${blockId}]`, message)
    }),
  )

  // Stage 2: tighten_timing — 隣接 cue 間の gap_too_short を決定的に解消（LLM不要）
  // タイムスタンプドリフトを防ぐため:
  //   - A.start / B.end は触らない（境界不変）
  //   - 各 cue の min_duration を侵さない
  //   - 修正はペア内に閉じる → 後続 cue は一切影響なし
  {
    const agentThresholdsForTighten = buildAgentThresholds({
      subtitleMinDurationSec: settings.subtitleMinDurationSec,
    })
    const tightenResult = await runNode('tightenTiming', () =>
      tightenTiming(
        blocks,
        agentThresholdsForTighten.minInterSubtitleGapMs / 1000,
        agentThresholdsForTighten.subtitleMinDurationSec,
      ),
    )
    blocks = tightenResult.blocks
  }

  // coverage_validator: 最終 plan が source JA を十分カバーしているか検証（決定的・LCSベース）
  // correctedSegments が渡された場合のみ動作。issue は trace に残るが pipeline は止めない。
  if (options.correctedSegments && options.correctedSegments.length > 0) {
    const segments = options.correctedSegments
    let coverageReport = await runNode('coverageValidator', () => validateCoverage(blocks, segments))

    // Stage 2: redistribute_ja_span — coverage 違反を決定的に救えるものは救う（LLM不要）
    // 境界の取りこぼし等の機械的な不足を時間比例配分で修復。
    // 改善しないケースは内部で revert される（悪化させない）。
    if (!coverageReport.ok) {
      const redistribResult = await runNode('redistributeJaSpan', () =>
        redistributeJaSpan(blocks, segments, coverageReport),
      )
      blocks = redistribResult.blocks
      coverageReport = redistribResult.finalReport
    }

    // coverage_repair_agent: 上記で救えなかった分（意味的な欠落）を mini + low reasoning で修復
    // settings.coverageRepairEnabled が false の場合は完全スキップ（コスト0）
    if (!coverageReport.ok && settings.coverageRepairEnabled) {
      const repairResult = await runNode('coverageRepairAgent', () =>
        runCoverageRepairAgent(blocks, segments, coverageReport, settings, thresholds),
      )
      blocks = repairResult.blocks
      // coverage_repair で何か変えたなら再 validate
      coverageReport = validateCoverage(blocks, segments)
    }

    // Stage 3: general_repair_agent エスカレーション (low → medium → high)
    // - block-level 違反 と coverage 残存違反 の両方を見て修復
    // - 3 段階のうち改善した時点で break、最後まで失敗したら manual_review に確定
    // - PoC 同等プロセス保証: 「PoC でも救えなかった真の難ケース」のみ manual_review
    const hasResidualViolations =
      blocks.some((b) => b.violation !== 'ok' && b.violation !== 'slow_speech') || !coverageReport.ok
    if (hasResidualViolations && settings.generalRepairEnabled) {
      const generalResult = await runNode('generalRepairAgent', () =>
        runGeneralRepairAgent(blocks, segments, coverageReport, settings, thresholds),
      )
      blocks = generalResult.blocks
    }
  }

  return blocks
}

function needsCorrection(block: EnBlock): boolean {
  return (
    block.violation === 'verbose_en' ||
    block.violation === 'line_length_only' ||
    block.violation === 'long_segment' ||
    block.violation === 'merged_long'
  )
}
