import type { AdminSettings } from '@/types/adminSettings'
import type { EnBlock, JaBlock, PipelineThresholds } from './blockTypes'
import { checkCpsViolations } from './checkCpsViolations'
import { formatLines } from './formatLines'
import { translateEn } from './translateEn'
import { correctionEngine } from './correctionAgent/loop'
import { createDecisionNode } from './correctionAgent/decisionNode'
import { buildAgentThresholds } from './correctionAgent/types'

type RunNode = <T>(nodeId: string, run: () => Promise<T> | T) => Promise<T>

// ツール警告コールバック: blockId, strategy, LLM 実レスポンスを含む診断メッセージ
type OnWarning = (nodeId: string, message: string) => void

export async function runPhase2(
  jaBlocks: JaBlock[],
  settings: AdminSettings,
  thresholds: PipelineThresholds,
  runNode: RunNode,
  onWarning?: OnWarning,
): Promise<EnBlock[]> {
  let blocks = await runNode('translateEn', () => translateEn(jaBlocks, settings))
  blocks = await runNode('formatLines', () => formatLines(blocks, thresholds))
  blocks = await runNode('checkCpsViolations', () => checkCpsViolations(blocks, thresholds))

  const violatingIndices = blocks
    .map((b, i) => (needsCorrection(b) ? i : -1))
    .filter(i => i !== -1)

  if (violatingIndices.length === 0) return blocks

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
