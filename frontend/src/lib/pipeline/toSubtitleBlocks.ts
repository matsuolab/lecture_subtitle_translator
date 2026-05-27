import type { SubtitleBlock } from '@/types/subtitle'
import type { EnBlock } from './blockTypes'
import type { PipelineReviewItem } from '@/types/pipeline'
import { summarizeReviewItems } from './reviewDiagnostics'

export function toSubtitleBlocks(
  blocks: EnBlock[],
  reviewItems: PipelineReviewItem[] = [],
): SubtitleBlock[] {
  return blocks.map((block) => ({
    ...(() => {
      const blockItems = reviewItems.filter(item => item.blockId === block.id)
      const review = summarizeReviewItems(blockItems)
      const needsManualStop = review.disposition === 'manual_review'
        || (review.disposition === 'proposed' && review.priority === 'must_review')
      return {
        id: block.id,
        startTime: block.start,
        endTime: block.end,
        source: block.enText,
        target: block.jaText,
        cps: block.cps,
        charCount: block.enChars,
        status: needsManualStop ? 'flagged' as const : 'pending' as const,
        glossaryTerms: [],
        reviewSummary: review.summary,
        reviewAction: review.action,
        reviewPriority: review.priority,
        reviewDisposition: review.disposition,
        contextGroupId: block.contextGroupId,
        contextGroupIndex: block.contextGroupIndex,
        contextGroupSize: block.contextGroupSize,
        contextGroupRole: block.contextGroupRole,
        contextGroupReason: block.contextGroupReason,
        contextGroupText: block.contextGroupText,
        contextGroupSourceIds: block.contextGroupSourceIds,
        correctionAttempts: block.correctionAttempts,
      }
    })(),
  }))
}
