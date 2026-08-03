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
import { finalSafeMerge } from './finalSafeMerge'
import { cpsReliefRebalance } from './cpsReliefRebalance'
import { semanticValidation } from './semanticValidation'
import { validateCoverage } from './coverageValidator'
import { runCoverageRepairAgent } from './coverageRepairAgent'
import { runGeneralRepairAgent } from './generalRepairAgent'
import { redistributeJaSpan } from './redistributeJaSpan'
import { tightenTiming } from './tightenTiming'
import { closeSubtitleGaps, formatCloseSubtitleGapsSummary } from './closeSubtitleGaps'
import { normalizeEnBlocks, parseTextNormalizationConfig } from './textNormalization'
import { buildPartialFailureWarning } from './partialFailureSummary'

// summarize は任意。localPipeline.ts の runNode が「成功時のtrace summary」を
// 結果から抽出するために使う（phase1.ts の RunNode と同じ形。closeSubtitleGaps の
// 閉じた件数・合計秒数を人が読める形で trace へ残すために利用する）。
type RunNode = <T>(nodeId: string, run: () => Promise<T> | T, summarize?: (result: T) => string | undefined) => Promise<T>

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
  // 部分失敗の誤報防止: correctJa と同じ仕組み（phase1.ts / partialFailureSummary.ts 参照）で、
  // translateEn が例外を投げずに大量失敗しても trace に件数が残るようにする。
  {
    const failedTranslationCount = blocks.filter((b) => b.translationFailureReason !== undefined).length
    const translationWarning = buildPartialFailureWarning('translation', failedTranslationCount, blocks.length)
    if (translationWarning) onWarning?.('translateEn', translationWarning)
  }
  if (settings.textNormalizationEnabled) {
    try {
      const config = parseTextNormalizationConfig(settings.textNormalizationRulesJson)
      blocks = await runNode('normalizeSubtitleTextPrecheck', () => normalizeEnBlocks(blocks, config, thresholds))
    } catch (error) {
      onWarning?.(
        'normalizeSubtitleTextPrecheck',
        `text normalization skipped before repair: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
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

  blocks = await runNode('mergeContextFragments', () =>
    mergeContextFragments(blocks, settings, thresholds, (blockId, message) => {
      onWarning?.(`mergeContextFragments[block=${blockId}]`, message)
    }),
  )
  {
    const mergeResult = await runNode('finalSafeMerge', () => finalSafeMerge(blocks, thresholds))
    blocks = mergeResult.blocks
  }

  // 最終 semantic check ノード（log_only / enforce 時のみ動作）。
  // context merge / rescue 後の文面を検証するため、mergeContextFragments の後に置く。
  if (settings.semanticCheckMode !== 'off') {
    blocks = await runNode('semanticValidation', () =>
      semanticValidation(blocks, settings, (blockId, message) => {
        onWarning?.(`semanticValidation[block=${blockId}]`, message)
      }),
    )
  }

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
  blocks = await runNode('checkCpsAfterTighten', () => checkCpsViolations(blocks, thresholds))

  // cps_relief_rebalance: 隣接ペアの時刻不均衡で生じた CPS 違反を決定的に再配分する。
  // LLM 不要。proportional_ts 由来の CPS 違反など、generalRepairAgent では本質的に直せない
  // ケースを前段で解消し、後段 LLM repair の負荷と revert ループを減らす。
  {
    const reliefResult = await runNode('cpsReliefRebalance', () => cpsReliefRebalance(blocks, thresholds))
    blocks = reliefResult.blocks
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

  // Stage 4: closeSubtitleGaps — 表示層の「短い空白を閉じる」処理（決定的・LLM不要）
  // アライメント層（asrAlignment.ts）が返す「実際に話された区間」の正しさはそのまま
  // 尊重しつつ、発話中に画面が一瞬空白になる短いギャップだけを前の cue を延ばして
  // 閉じる。長い間（実質的な無音）はそのまま空白を保つ（放送・配信の慣行）。
  // タイミングの正しさ（アライメント層）と表示の連続性（表示層）は別レイヤーとして
  // 扱う方針のため、ここまでの補正・修復ロジックには一切手を入れない。
  //
  // 配置順序について（実装時に確認した内容）:
  //   - tightenTiming（本ファイル前段）は「gap が minGapSec 未満」を widen して
  //     解消する処理。closeSubtitleGaps は逆に「gap を狭める」処理なので、素朴に
  //     先に実行すると互いの結果を打ち消し合う恐れがある → tightenTiming より
  //     後段に置く。さらに closeSubtitleGaps 自体に tightenTiming と同じ
  //     minGapSec を渡し、閉じた後の gap が minGapSec を下回らないようにする
  //     （= gap_too_short を再発させない）。
  //   - classifyViolation（metrics.ts）は duration に依存し、cue を延ばすと cps は
  //     下がる方向に動く。verbose_en 等のCPS超過違反を新たに生むことはないはずだが、
  //     slow_speech（cps < slowCps）は duration が伸びるほど発生しやすくなる方向に
  //     働く。closeSubtitleGaps を CPS 検査・修復ノード（checkCpsAfterTighten /
  //     cpsReliefRebalance / coverageRepairAgent / generalRepairAgent）より前段に
  //     置くと、閉じたことで新たに生まれた slow_speech が「直すべき違反」として
  //     後段の repair agent に渡り、LLM が cue を縮めて閉じたギャップを打ち消し
  //     かねない。そのため repair 系ノードすべての後段（phase2 の最終段）に置く。
  //     cps / violation フィールドは参考情報として checkCpsViolations で再計算する
  //     が、この再計算はここでは何もトリガーしない（表示専用の後処理のため）。
  {
    const agentThresholdsForGapClose = buildAgentThresholds({
      subtitleMinDurationSec: settings.subtitleMinDurationSec,
    })
    const gapCloseResult = await runNode(
      'closeSubtitleGaps',
      () =>
        closeSubtitleGaps(
          blocks,
          settings.subtitleMaxGapSec,
          agentThresholdsForGapClose.minInterSubtitleGapMs / 1000,
        ),
      formatCloseSubtitleGapsSummary,
    )
    blocks = gapCloseResult.blocks
    if (gapCloseResult.closedCount > 0) {
      blocks = await runNode('checkCpsAfterGapClose', () => checkCpsViolations(blocks, thresholds))
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
