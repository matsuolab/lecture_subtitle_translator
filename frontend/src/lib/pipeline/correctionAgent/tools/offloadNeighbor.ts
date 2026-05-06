import type { AdminSettings } from '@/types/adminSettings'
import type { EnBlock, PipelineThresholds } from '../../blockTypes'
import type { AgentThresholds, DecisionContext, TimelinePatch, Tool } from '../types'

// 初期版: 常に canApply = false
// enableOffloadNeighbor フラグが true になった段階で実装を追加する
export const offloadNeighborTool: Tool = {
  name: 'offload_neighbor',
  description: 'Move content to neighboring subtitle block. Disabled by default.',

  canApply(ctx: DecisionContext): boolean {
    return ctx.thresholds.enableOffloadNeighbor
  },

  async execute(
    block: EnBlock,
    _ctx: DecisionContext,
    _settings: AdminSettings,
    _thresholds: PipelineThresholds & AgentThresholds,
  ): Promise<TimelinePatch> {
    return {
      replaceBlocks: [block],
      dirtyBlockIds: [],
      changed: false,
    }
  },
}
