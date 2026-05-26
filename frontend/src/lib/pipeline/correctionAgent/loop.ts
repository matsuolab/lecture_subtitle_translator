import type { AdminSettings } from '@/types/adminSettings'
import type { EnBlock, PipelineThresholds } from '../blockTypes'
import type { PipelineCorrectionAttemptSummary } from '@/types/pipeline'
import type { AgentThresholds, CorrectionAttempt, DecisionNode, SemanticCheckOutcome } from './types'
import { buildContext } from './contextBuilder'
import { getFeasibleStrategies } from './feasibility'
import { applyPatch, meetsConstraints, normalizeAndValidate } from './patchUtils'
import { toolRegistry } from './tools/index'
import { isFailedAttempt } from './metrics'
import {
  classifySemanticResult,
  computeSimilarity,
  isSemanticCheckAvailable,
} from '../semanticCheck'

/**
 * 早期終了の判定理由（ログに残るので後で集計可能）。
 */
type EarlyTerminationReason =
  | 'consecutive_failed_attempts'  // 直近2試行が isFailedAttempt
  | 'no_meaningful_reduction'       // 直近3試行で char retention >= 95%
  | 'patch_regressed'               // 適用後の char 数が増加（悪化）

/**
 * 早期終了が必要かを判定する。
 * 既存の maxCorrectionRounds (=4) チェックの前段で呼ぶ。
 *
 * 条件:
 * - 直近2試行が isFailedAttempt（変化なし / 削減不十分）→ 諦め
 * - 直近3試行で削減率 < 5%（95%以上残ってる）→ 局所修正で詰む形 → 諦め
 *
 * 諦めた block は後段の coverage_repair_agent / general_repair_agent にハンドオフ。
 */
function shouldEarlyTerminate(
  history: CorrectionAttempt[],
  thresholds: Pick<AgentThresholds, 'minReductionDeltaChars' | 'minReductionDeltaRatio'>,
): EarlyTerminationReason | null {
  if (history.length >= 2) {
    const last2 = history.slice(-2)
    if (last2.every((a) => isFailedAttempt(a, thresholds))) {
      return 'consecutive_failed_attempts'
    }
  }
  if (history.length >= 3) {
    const last3 = history.slice(-3)
    const allStagnant = last3.every((a) => {
      if (!a.changed) return true
      if (a.beforeChars <= 0) return true
      const retention = a.afterChars / a.beforeChars
      return retention >= 0.95
    })
    if (allStagnant) return 'no_meaningful_reduction'
  }
  return null
}

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
    semanticSimilarity: attempt.semanticSimilarity,
    semanticOutcome: attempt.semanticOutcome,
  })

  // セマンティックチェックが利用可能か（API キーや local_openai 等で判定）
  const semanticEnabled = isSemanticCheckAvailable(settings)
  const threshold = Math.max(0, Math.min(1, settings.qualityCorrectionThreshold ?? 0.7))

  // attempt 直後に類似度を計算して attempt オブジェクトを更新する
  const annotateSemantic = async (
    attempt: CorrectionAttempt,
    beforeEn: string,
    afterEn: string,
  ): Promise<void> => {
    if (!semanticEnabled) {
      attempt.semanticOutcome = 'unavailable'
      return
    }
    // 圧縮系・split_block・offload_neighbor のみチェック対象（borrow_gap はテキスト不変）
    const checkable: CorrectionAttempt['strategy'][] = [
      'compress_micro',
      'compress_rephrase',
      'compress_trim',
      'compress_core',
      'split_block',
      'offload_neighbor',
    ]
    if (!checkable.includes(attempt.strategy)) return
    // changed=false なら計算不要
    if (!attempt.changed) return
    const sim = await computeSimilarity(beforeEn, afterEn, settings)
    if (sim === null) {
      attempt.semanticOutcome = 'unavailable'
      return
    }
    attempt.semanticSimilarity = sim
    const outcome: SemanticCheckOutcome = classifySemanticResult(sim, threshold)
    attempt.semanticOutcome = outcome
  }

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

    // 早期終了: ラウンド上限に達する前でも、進展がない場合は break
    // → 後段の coverage_repair_agent / general_repair_agent に救済を委ねる方が経済的
    const terminationReason = shouldEarlyTerminate(history, thresholds)
    if (terminationReason !== null) {
      const lastAttempt = history[history.length - 1]
      onToolWarning?.(blockIdStr, lastAttempt.strategy, `early_termination: ${terminationReason} (rounds=${history.length})`)
      continue
    }

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

    // セマンティックチェック（log_only / enforce 共通でスコアを取得）
    await annotateSemantic(attempt, beforeSubtitleText, afterSubtitleText)

    // enforce モードかつ failed なら差し戻し（changed=false に書き換え、tries 履歴は残す）
    let acceptPatch = patch.changed
    if (
      settings.semanticCheckMode === 'enforce' &&
      attempt.semanticOutcome === 'failed' &&
      patch.changed
    ) {
      acceptPatch = false
      const baseRationale = attempt.rationale ? `${attempt.rationale}; ` : ''
      attempt.rationale = `${baseRationale}rejected by semantic check (similarity=${attempt.semanticSimilarity?.toFixed(3)})`
      attempt.changed = false
      onToolWarning?.(blockIdStr, strategy, attempt.rationale)
    }

    // patch_regressed 検出: 圧縮戦略のはずなのに文字数が増えていたら受け付けない
    // （tier 悪化や LLM の暴走を防止する）
    if (
      acceptPatch &&
      strategy.startsWith('compress_') &&
      afterChars > beforeChars + 2  // 2 文字までの揺れは許容（句読点等）
    ) {
      acceptPatch = false
      const baseRationale = attempt.rationale ? `${attempt.rationale}; ` : ''
      attempt.rationale = `${baseRationale}rejected: patch_regressed (${beforeChars} -> ${afterChars} chars, expected reduction)`
      attempt.changed = false
      onToolWarning?.(blockIdStr, strategy, attempt.rationale)
    }

    history.push(attempt)

    if (!acceptPatch) continue

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
