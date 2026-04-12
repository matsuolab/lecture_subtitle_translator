/**
 * exportSrt ノード。
 * PipelineSubtitleBlock[] を SRT 文字列に変換して返す。
 * ファイルへの書き込みは呼び出し元（runner.ts）が担当する。
 */

import type { NodeContract, NodeContext } from '../nodeContract'
import type { PipelineSubtitleBlock } from '../types'
import { serializeToSrt } from '../utils/srtSerialize'

export interface ExportSrtOutput {
  readonly srtContent: string
  readonly blockCount: number
  readonly flaggedCount: number
}

export const exportSrtNode: NodeContract<
  readonly PipelineSubtitleBlock[],
  ExportSrtOutput
> = {
  id: 'exportSrt',
  schemaVersion: '1.0',

  async run(
    input: readonly PipelineSubtitleBlock[],
    ctx: NodeContext,
  ): Promise<ExportSrtOutput> {
    ctx.onProgress('exportSrt: SRT 生成中...')

    const srtContent = serializeToSrt(
      input.map(b => ({ id: b.id, start: b.start, end: b.end, text: b.text }))
    )

    return {
      srtContent,
      blockCount: input.length,
      flaggedCount: input.filter(b => b.flagged).length,
    }
  },
}
