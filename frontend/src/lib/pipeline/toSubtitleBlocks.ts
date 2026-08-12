import type { SubtitleBlock } from '@/types/subtitle'
import type { EnBlock } from './blockTypes'
import type { PipelineReviewItem } from '@/types/pipeline'
import { summarizeFormViolationBadge } from './reviewDiagnostics'
import { cloneCueSourceRefs } from '@/types/sourceEvidence'

export function toSubtitleBlocks(
  blocks: EnBlock[],
  reviewItems: PipelineReviewItem[] = [],
): SubtitleBlock[] {
  return blocks.map((block) => ({
    ...(() => {
      const blockItems = reviewItems.filter(item => item.blockId === block.id)
      // エディタの「要確認」バッジは、信頼できる測定形式違反（＋未訳）のみに限定する。
      // 意味系の推測は ReportTab 診断に残し、翻訳者の作業面には出さない。
      const badge = summarizeFormViolationBadge(blockItems)
      const needsManualStop = badge !== null
      return {
        id: block.id,
        startTime: block.start,
        endTime: block.end,
        subtitle: block.enText,
        transcript: block.jaText,
        cps: block.cps,
        charCount: block.enChars,
        status: needsManualStop ? 'flagged' as const : 'pending' as const,
        glossaryTerms: [],
        ...(block.sourceRefs ? { sourceRefs: cloneCueSourceRefs(block.sourceRefs) } : {}),
        reviewSummary: badge?.summary,
        reviewAction: badge?.action,
        reviewPriority: badge?.priority ?? 'auto_pass',
        reviewDisposition: badge?.disposition ?? 'auto_pass',
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
