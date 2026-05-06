import type { AdminSettings } from '@/types/adminSettings'
import type { EnBlock, PipelineThresholds } from '../../blockTypes'
import type { AgentThresholds, DecisionContext, TimelinePatch, Tool } from '../types'
import { buildMetrics } from '../metrics'

export const borrowGapTool: Tool = {
  name: 'borrow_gap',
  description: 'Extend block time window into adjacent silence.',

  canApply(ctx: DecisionContext): boolean {
    const m = buildMetrics(ctx, ctx.thresholds as PipelineThresholds & AgentThresholds)
    return (
      m.totalBorrowableMs >= ctx.thresholds.minUsefulBorrowMs &&
      m.missingDurationMs > 0 &&
      !ctx.attemptHistory.some(a => a.strategy === 'borrow_gap')
    )
  },

  async execute(
    block: EnBlock,
    ctx: DecisionContext,
    _settings: AdminSettings,
    thresholds: PipelineThresholds & AgentThresholds,
  ): Promise<TimelinePatch> {
    const m = buildMetrics(ctx, thresholds)

    let newStart = block.start
    let newEnd = block.end

    let remainingNeededMs = m.missingDurationMs

    // 後ろから優先して借りる（字幕遅延の方が視聴者影響が小さい）
    const canBorrowAfterMs = Math.min(m.borrowableAfterMs, thresholds.maxLagMs)
    const borrowAfterMs = Math.min(remainingNeededMs, canBorrowAfterMs)
    if (borrowAfterMs > 0) {
      newEnd = block.end + borrowAfterMs / 1000
      remainingNeededMs -= borrowAfterMs
    }

    // 前から借りる
    const canBorrowBeforeMs = Math.min(m.borrowableBeforeMs, thresholds.maxLeadMs)
    const borrowBeforeMs = Math.min(remainingNeededMs, canBorrowBeforeMs)
    if (borrowBeforeMs > 0) {
      newStart = block.start - borrowBeforeMs / 1000
    }

    const changed = newStart !== block.start || newEnd !== block.end

    return {
      replaceBlocks: [
        {
          ...block,
          start: newStart,
          end: newEnd,
        },
      ],
      consumedGaps: {
        beforeMs: borrowBeforeMs > 0 ? borrowBeforeMs : undefined,
        afterMs: borrowAfterMs > 0 ? borrowAfterMs : undefined,
      },
      dirtyBlockIds: [String(block.id)],
      changed,
    }
  },
}
