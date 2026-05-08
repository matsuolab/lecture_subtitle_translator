import type { PipelineReviewItem } from '@/types/pipeline'
import type { SubtitleBlock } from '@/types/subtitle'
import type { EnBlock } from './blockTypes'
import { toSubtitleBlocks } from './toSubtitleBlocks'
import { checkTerminology } from './terminologyCheck'
import type { PipelineThresholds } from './blockTypes'
import { buildReviewItemsForBlock } from './reviewDiagnostics'

type RunNode = <T>(nodeId: string, run: () => Promise<T> | T) => Promise<T>

export interface Phase3Result {
  blocks: SubtitleBlock[]
  terminologyMisses: string[]
  reviewItems: PipelineReviewItem[]
}

export async function runPhase3(
  enBlocks: EnBlock[],
  glossaryTerms: string[],
  thresholds: PipelineThresholds,
  runNode: RunNode,
): Promise<Phase3Result> {
  const terminology = await runNode('terminologyCheck', () => checkTerminology(enBlocks, glossaryTerms))
  const reviewItems: PipelineReviewItem[] = enBlocks.flatMap(block => buildReviewItemsForBlock(block, thresholds))
  const blocks = await runNode('toSubtitleBlocks', () => toSubtitleBlocks(enBlocks, reviewItems))

  terminology.misses.forEach((miss, index) => {
    reviewItems.push({
      id: `term-miss-${index}`,
      nodeId: 'terminologyCheck',
      reason: `term missing: ${miss}`,
      category: 'terminology',
      priority: 'should_review',
      disposition: 'manual_review',
      title: '用語が欠落している可能性があります',
      action: '用語辞書の期待表記が字幕に含まれているか確認してください',
      details: [miss],
      proposal: {
        kind: 'verify_terms',
        confidence: 0.45,
        rationale: '用語辞書が不完全なため、自動置換ではなく根拠付き確認に留める必要があります',
      },
      score: 0,
    })
  })

  return {
    blocks,
    terminologyMisses: terminology.misses,
    reviewItems,
  }
}
