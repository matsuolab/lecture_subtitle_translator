/**
 * splitEn ノード。
 * EnglishBlock ごとに CPS を確認し、制約内であれば確定ブロックとして出力する。
 * 超過した場合は CpsViolation として返し、runner が splitJa へのロールバックを判断する。
 *
 * LLM 不使用。純粋 TypeScript。
 */

import type { NodeContract, NodeContext } from '../nodeContract'
import type {
  EnglishBlock,
  PipelineSubtitleBlock,
  SplitEnResult,
  CpsViolation,
} from '../types'
import { checkBlock } from '../utils/cps'

export const splitEnNode: NodeContract<readonly EnglishBlock[], SplitEnResult> = {
  id: 'splitEn',
  schemaVersion: '1.0',

  async run(
    input: readonly EnglishBlock[],
    ctx: NodeContext,
  ): Promise<SplitEnResult> {
    ctx.onProgress('splitEn: CPS確認中...')

    const { maxCps, maxChars } = ctx.config.subtitleConstraints
    const blocks: PipelineSubtitleBlock[] = []
    const violations: CpsViolation[] = []

    for (const block of input) {
      const duration = block.end - block.start
      const { charCount, cps, cpsOk } = checkBlock(block.enText, duration, maxCps, maxChars)

      blocks.push({
        id: block.id,
        start: block.start,
        end: block.end,
        text: block.enText,
        jaText: block.jaText,
        charCount,
        cps,
        cpsOk,
        sourceSegmentId: block.id,
        flagged: !cpsOk,
        attempt: block.attempt,
        sourceSegmentIds: block.sourceSegmentIds,
        blockKey: block.blockKey,
      })

      if (!cpsOk) {
        violations.push({
          blockId: block.id,
          start: block.start,
          end: block.end,
          cps,
          maxCps,
        })
      }
    }

    return { blocks, violations }
  },
}
