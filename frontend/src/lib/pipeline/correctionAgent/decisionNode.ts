import type { PipelineThresholds } from '../blockTypes'
import type {
  AgentThresholds,
  CompressionTier,
  CorrectionStrategy,
  DecisionContext,
  DecisionMetrics,
  DecisionNode,
} from './types'
import { buildMetrics } from './metrics'

// ---------------------------------------------------------------------------
// RuleBasedDecisionNode
// ---------------------------------------------------------------------------

export class RuleBasedDecisionNode implements DecisionNode {
  async decide(
    ctx: DecisionContext,
    feasible: CorrectionStrategy[],
  ): Promise<CorrectionStrategy> {
    const thresholds = ctx.thresholds as PipelineThresholds & AgentThresholds
    const m = buildMetrics(ctx, thresholds)
    const f = new Set(feasible)

    // 1. borrow_gap で完全解決できる場合は最優先
    if (f.has('borrow_gap') && this.canBorrowSolveCompletely(m)) {
      return 'borrow_gap'
    }

    // 2. borrow_gap で CompressionTier を下げられる場合も優先
    if (f.has('borrow_gap') && this.canBorrowReduceTier(m)) {
      return 'borrow_gap'
    }

    // 3. 長尺で明確な日本語境界がある場合は split_block を優先
    if (f.has('split_block') && this.shouldAutoSplitLongSegment(ctx, m)) {
      return 'split_block'
    }

    // 4. 行長だけの軽度違反はまず短縮・言い換えで自動解決を試す
    if (ctx.block.violation === 'line_length_only') {
      if (f.has('compress_rephrase')) return 'compress_rephrase'
      if (f.has('compress_trim')) return 'compress_trim'
    }

    // 5. large/extreme → split_block 優先（強圧縮は学術的正確性を損なう）
    if (f.has('split_block') && this.shouldSplitFirst(m)) {
      return 'split_block'
    }

    // 6. tier に応じた圧縮戦略
    const compress = this.chooseCompressionStrategy(m, f)
    if (compress) return compress

    // 7. 圧縮が全部失敗/試み済み → split を再検討
    if (f.has('split_block') && m.splitViable) {
      return 'split_block'
    }

    // 8. compress_core（manual review 前提）
    if (f.has('compress_core')) {
      return 'compress_core'
    }

    // 7. offload_neighbor（デフォルト無効）
    if (f.has('offload_neighbor')) {
      return 'offload_neighbor'
    }

    // feasible が空の場合はコードが accept にする（通常ここには来ない）
    return feasible[0] ?? 'compress_rephrase'
  }

  private canBorrowSolveCompletely(m: DecisionMetrics): boolean {
    return m.totalBorrowableMs >= m.missingDurationMs && m.missingDurationMs > 0
  }

  private canBorrowReduceTier(m: DecisionMetrics): boolean {
    if (m.totalBorrowableMs <= 0) return false
    const borrowedDurationSec = m.totalBorrowableMs / 1000
    // borrow 後の durationSec を想定してoverRatio を再計算
    const newDurationSec = m.durationSec + borrowedDurationSec
    const newPhysicalMax = Math.floor((m.currentChars / m.durationSec) * newDurationSec)
    const newOverRatio = newPhysicalMax > 0 ? m.currentChars / newPhysicalMax : m.overRatio
    // tier が下がるか確認
    return this.tierFromRatio(newOverRatio) < this.tierFromRatio(m.overRatio)
  }

  private tierFromRatio(ratio: number): number {
    if (ratio <= 1.10) return 0
    if (ratio <= 1.25) return 1
    if (ratio <= 1.45) return 2
    if (ratio <= 1.80) return 3
    return 4
  }

  private shouldSplitFirst(m: DecisionMetrics): boolean {
    return (m.tier === 'large' || m.tier === 'extreme') && m.splitViable
  }

  private shouldAutoSplitLongSegment(ctx: DecisionContext, m: DecisionMetrics): boolean {
    if (!m.splitViable) return false
    if (ctx.block.violation !== 'long_segment' && ctx.block.violation !== 'merged_long') return false
    return /[。！？、]|について|として|ために|踏まえて|また|そして|ただし|一方で/.test(ctx.block.jaText)
  }

  private chooseCompressionStrategy(
    m: DecisionMetrics,
    f: Set<CorrectionStrategy>,
  ): CorrectionStrategy | null {
    const tier: CompressionTier = m.tier

    if (tier === 'tiny' || tier === 'small') {
      if (f.has('compress_rephrase')) return 'compress_rephrase'
      if (f.has('compress_trim')) return 'compress_trim'
    }

    if (tier === 'medium') {
      if (f.has('compress_trim')) return 'compress_trim'
      if (f.has('compress_rephrase')) return 'compress_rephrase'
    }

    // large/extreme: compress は補助的（split が先のため、ここには split 不可の場合に来る）
    if (tier === 'large' || tier === 'extreme') {
      if (f.has('compress_rephrase')) return 'compress_rephrase'
      if (f.has('compress_trim')) return 'compress_trim'
    }

    return null
  }
}

// ---------------------------------------------------------------------------
// LLMDecisionNode（実験フラグ）
// ---------------------------------------------------------------------------

export class LLMDecisionNode implements DecisionNode {
  private readonly ruleNode = new RuleBasedDecisionNode()

  async decide(
    ctx: DecisionContext,
    feasible: CorrectionStrategy[],
  ): Promise<CorrectionStrategy> {
    if (feasible.length === 0) return 'compress_rephrase'

    try {
      const strategy = await this.callLlm(ctx, feasible)
      return this.applyGuardrails(strategy, ctx, feasible)
    } catch {
      // LLM 失敗時はルールベースにフォールバック
      return this.ruleNode.decide(ctx, feasible)
    }
  }

  private async callLlm(
    ctx: DecisionContext,
    feasible: CorrectionStrategy[],
  ): Promise<CorrectionStrategy> {
    const { settings } = ctx
    const apiKey = settings.openaiApiKey.trim()
    const baseUrl = (settings.openaiCompatibleBaseUrl.trim() || 'https://api.openai.com/v1').replace(/\/$/, '')
    const model = settings.correctionModel || 'gpt-4.1-nano'

    const prompt = buildDecisionPrompt(ctx, feasible)

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        temperature: 0.0,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content:
              'You are a subtitle correction strategy selector for academic lecture subtitles. ' +
              'Given context about a subtitle block that violates display constraints, ' +
              'select the best correction strategy from the provided feasible strategies. ' +
              'Consider the severity of violation, available timing slack, and academic content preservation. ' +
              'Do NOT calculate character counts yourself — the code handles constraint checking. ' +
              'Respond with JSON: {"strategy": "<strategy_name>", "rationale": "<reason in ≤120 chars>"}',
          },
          { role: 'user', content: prompt },
        ],
      }),
    })

    if (!response.ok) {
      throw new Error(`LLM decision API returned HTTP ${response.status}`)
    }

    const payload = await response.json()
    const content: string = payload?.choices?.[0]?.message?.content ?? ''
    const parsed = JSON.parse(content) as { strategy?: unknown }
    const strategy = typeof parsed.strategy === 'string' ? parsed.strategy : ''

    if (!isCorrectionStrategy(strategy)) {
      throw new Error(`Invalid strategy from LLM: ${strategy}`)
    }
    return strategy
  }

  private applyGuardrails(
    strategy: CorrectionStrategy,
    ctx: DecisionContext,
    feasible: CorrectionStrategy[],
  ): CorrectionStrategy {
    const tried = new Set(ctx.attemptHistory.map(a => a.strategy))
    // 既に試みた or feasible にない → fallback
    if (tried.has(strategy) || !feasible.includes(strategy)) {
      return feasible.find(s => !tried.has(s)) ?? feasible[0] ?? 'compress_rephrase'
    }
    return strategy
  }
}

function buildDecisionPrompt(
  ctx: DecisionContext,
  feasible: CorrectionStrategy[],
): string {
  const thresholds = ctx.thresholds as PipelineThresholds & AgentThresholds
  const durationSec = ctx.block.end - ctx.block.start
  const physicalMax = Math.floor(thresholds.verboseCps * durationSec)

  return JSON.stringify({
    block: {
      text: ctx.block.enText.replace(/\n/g, ' '),
      currentChars: ctx.block.enChars,
      physicalMaxChars: physicalMax,
      jaText: ctx.block.jaText,
    },
    timing: {
      durationSec,
      gapBeforeMs: ctx.gapBeforeMs,
      gapAfterMs: ctx.gapAfterMs,
    },
    neighborSlack: ctx.neighborSlack,
    feasibleStrategies: feasible,
    alreadyAttempted: ctx.attemptHistory.map(a => a.strategy),
    strategyDescriptions: {
      compress_rephrase: 'Shorten while preserving meaning',
      compress_trim: 'Drop qualifications/examples, keep main claim',
      compress_core: 'Keep single most important concept (manual review required)',
      split_block: 'Split Japanese into 2 semantic sentences, re-translate each',
      borrow_gap: 'Extend time window into adjacent silence',
      offload_neighbor: 'Move content to neighboring subtitle block',
    },
  }, null, 2)
}

function isCorrectionStrategy(value: string): value is CorrectionStrategy {
  return [
    'compress_rephrase',
    'compress_trim',
    'compress_core',
    'split_block',
    'borrow_gap',
    'offload_neighbor',
  ].includes(value)
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createDecisionNode(useAgent: boolean): DecisionNode {
  return useAgent ? new LLMDecisionNode() : new RuleBasedDecisionNode()
}
