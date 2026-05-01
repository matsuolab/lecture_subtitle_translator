import type { PipelineReviewItem } from '@/types/pipeline'
import type { SubtitleBlock } from '@/types/subtitle'
import type { EnBlock } from './blockTypes'
import { toSubtitleBlocks } from './toSubtitleBlocks'
import { checkTerminology } from './terminologyCheck'

type RunNode = <T>(nodeId: string, run: () => Promise<T> | T) => Promise<T>

export interface Phase3Result {
  blocks: SubtitleBlock[]
  terminologyMisses: string[]
  reviewItems: PipelineReviewItem[]
}

function violationPriority(violation: EnBlock['violation']): PipelineReviewItem['priority'] {
  switch (violation) {
    case 'verbose_en':
    case 'line_length_only':
      return 'must_review'
    case 'short_duration':
    case 'long_segment':
    case 'merged_long':
    case 'proportional_ts':
    case 'over_compressed':
      return 'should_review'
    case 'slow_speech':
      return 'auto_pass'
    case 'ok':
    default:
      return 'auto_pass'
  }
}

export async function runPhase3(
  enBlocks: EnBlock[],
  glossaryTerms: string[],
  runNode: RunNode,
): Promise<Phase3Result> {
  const terminology = await runNode('terminologyCheck', () => checkTerminology(enBlocks, glossaryTerms))
  const blocks = await runNode('toSubtitleBlocks', () => toSubtitleBlocks(enBlocks))

  const reviewItems: PipelineReviewItem[] = enBlocks
    .filter((block) => block.violation !== 'ok')
    .map((block) => ({
      id: `violation-${block.id}`,
      nodeId: 'checkCpsViolations',
      reason: block.violation,
      priority: violationPriority(block.violation),
      score: block.cps,
      blockId: block.id,
    }))

  terminology.misses.forEach((miss, index) => {
    reviewItems.push({
      id: `term-miss-${index}`,
      nodeId: 'terminologyCheck',
      reason: `term missing: ${miss}`,
      priority: 'should_review',
      score: 0,
    })
  })

  return {
    blocks,
    terminologyMisses: terminology.misses,
    reviewItems,
  }
}
