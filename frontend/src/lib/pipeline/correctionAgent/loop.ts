import type { AdminSettings } from '@/types/adminSettings'
import type { EnBlock, PipelineThresholds } from '../blockTypes'
import type { PipelineCorrectionAttemptSummary } from '@/types/pipeline'
import type { AgentThresholds, CorrectionAttempt, DecisionNode } from './types'
import { buildContext } from './contextBuilder'
import { getFeasibleStrategies } from './feasibility'
import { applyPatch, meetsConstraints, normalizeAndValidate } from './patchUtils'
import { toolRegistry } from './tools/index'

export interface CorrectionEngineOptions {
  // ツール実行で警告・エラーが発生した場合に呼ばれるコールバック
  // blockId, strategy, message（LLM 実レスポンスを含む診断情報）
  onToolWarning?: (blockId: string, strategy: string, message: string) => void
}

export async function correctionEngine(
  timeline: EnBlock[],
  violatingIndices: number[],
  decisionNode: DecisionNode,
  settings: AdminSettings,
  thresholds: PipelineThresholds & AgentThresholds,
  options: CorrectionEngineOptions = {},
): Promise<EnBlock[]> {
  const { onToolWarning } = options
  let currentTimeline = [...timeline]
  const queue = new Set<string>(
    violatingIndices.map(i => String(timeline[i]?.id ?? i)),
  )

  const attemptHistories = new Map<string, CorrectionAttempt[]>()

  const getHistory = (blockId: string): CorrectionAttempt[] => {
    if (!attemptHistories.has(blockId)) attemptHistories.set(blockId, [])
    return attemptHistories.get(blockId)!
  }

  const summarizeAttempt = (attempt: CorrectionAttempt): PipelineCorrectionAttemptSummary => ({
    strategy: attempt.strategy,
    changed: attempt.changed,
    beforeChars: attempt.beforeChars,
    afterChars: attempt.afterChars,
    beforeViolation: attempt.beforeViolation,
    afterViolation: attempt.afterViolation,
    beforeTranscriptText: attempt.beforeTranscriptText,
    beforeSubtitleText: attempt.beforeSubtitleText,
    afterTranscriptText: attempt.afterTranscriptText,
    afterSubtitleText: attempt.afterSubtitleText,
    rationale: attempt.rationale,
  })

  const attachAttemptHistories = (timelineWithResults: EnBlock[]): EnBlock[] =>
    timelineWithResults.map((block) => {
      const ownHistory = getHistory(String(block.id))
      const sourceId = (block as { splitFrom?: number }).splitFrom
      const sourceHistory = sourceId !== undefined ? getHistory(String(sourceId)) : []
      const attempts = [...sourceHistory, ...ownHistory].map(summarizeAttempt)
      return attempts.length > 0 ? { ...block, correctionAttempts: attempts } : block
    })

  while (queue.size > 0) {
    const blockIdStr = queue.values().next().value as string
    queue.delete(blockIdStr)

    const blockIdx = currentTimeline.findIndex(b => String(b.id) === blockIdStr)
    if (blockIdx === -1) continue

    const block = currentTimeline[blockIdx]

    if (meetsConstraints(block)) continue

    const history = getHistory(blockIdStr)

    if (history.length >= thresholds.maxCorrectionRounds) continue

    const ctx = buildContext(block, blockIdx, currentTimeline, history, thresholds, settings)

    if (ctx.physicalMaxChars < thresholds.minMeaningfulChars) continue

    const feasible = getFeasibleStrategies(ctx, thresholds)

    if (feasible.length === 0) continue

    const strategy = await decisionNode.decide(ctx, feasible)
    const tool = toolRegistry[strategy]

    const beforeViolation = block.violation
    const beforeChars = block.enChars
    const beforeTranscriptText = block.jaText
    const beforeSubtitleText = block.enText

    let patch: ReturnType<typeof normalizeAndValidate>
    try {
      const rawPatch = await tool.execute(block, ctx, settings, thresholds)

      // ツールが warning を付けて返してきた場合（LLM が期待外の出力をしたが続行できた）
      if (rawPatch.warning) {
        onToolWarning?.(blockIdStr, strategy, rawPatch.warning)
      }

      patch = normalizeAndValidate(rawPatch, thresholds)
    } catch (err) {
      // ツール実行失敗 → changed=false として記録し次の戦略へ
      const message = err instanceof Error ? err.message : String(err)
      onToolWarning?.(blockIdStr, strategy, `tool error: ${message}`)
      history.push({
        strategy,
        changed: false,
        beforeChars,
        afterChars: beforeChars,
        beforeViolation,
        afterViolation: beforeViolation,
        beforeTranscriptText,
        beforeSubtitleText,
        afterTranscriptText: beforeTranscriptText,
        afterSubtitleText: beforeSubtitleText,
        rationale: message,
      })
      continue
    }

    const afterTranscriptText = patch.replaceBlocks
      .map(replacement => replacement.jaText)
      .filter(Boolean)
      .join(' / ') || beforeTranscriptText
    const afterSubtitleText = patch.replaceBlocks
      .map(replacement => replacement.enText)
      .filter(Boolean)
      .join(' / ') || beforeSubtitleText
    const afterChars = patch.replaceBlocks
      .reduce((sum, replacement) => sum + replacement.enChars, 0) || beforeChars

    const attempt: CorrectionAttempt = {
      strategy,
      changed: patch.changed,
      beforeChars,
      afterChars,
      beforeViolation,
      afterViolation: patch.replaceBlocks[0]?.violation ?? beforeViolation,
      beforeTranscriptText,
      beforeSubtitleText,
      afterTranscriptText,
      afterSubtitleText,
      rationale: patch.warning,
    }
    history.push(attempt)

    if (!patch.changed) continue

    currentTimeline = applyPatch(currentTimeline, patch)

    for (const dirtyId of patch.dirtyBlockIds) {
      const dirtyBlock = currentTimeline.find(b => String(b.id) === dirtyId)
      if (dirtyBlock && !meetsConstraints(dirtyBlock)) {
        if (getHistory(dirtyId).length < thresholds.maxCorrectionRounds) {
          queue.add(dirtyId)
        }
      }
    }
  }

  return attachAttemptHistories(currentTimeline)
}
