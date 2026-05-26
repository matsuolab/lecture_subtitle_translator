import type { AdminSettings } from '@/types/adminSettings'
import type { JaBlock } from './blockTypes'
import { detectIncompleteEnds } from './detectIncompleteEnds'

export interface MergeContinuationResult {
  blocks: JaBlock[]
  detectionCount: number
  detectionSuccess: number
  detectionFailed: number
  mergedCount: number
  abortReason?: string
}

export type OnWarning = (nodeId: string, message: string) => void

function mergePair(left: JaBlock, right: JaBlock): JaBlock {
  return {
    id: left.id,
    start: left.start,
    end: right.end,
    jaText: `${left.jaText} ${right.jaText}`.trim(),
    jaChars: left.jaChars + right.jaChars,
    alignConf: 'merged',
    words: [...(left.words ?? []), ...(right.words ?? [])],
    merged: true,
    // 結合後は再判定するまで未計算とする
    endsIncomplete: undefined,
  }
}

interface MergeConfig {
  maxGapSec: number
  maxDurationSec: number
  maxTranscriptChars: number
}

function canMergeWithNext(cur: JaBlock, next: JaBlock, cfg: MergeConfig): boolean {
  const gap = next.start - cur.end
  if (gap > cfg.maxGapSec) return false
  if (gap < 0) return false  // 重なりは異常 → スキップ
  const mergedDuration = next.end - cur.start
  if (mergedDuration > cfg.maxDurationSec) return false
  const mergedChars = cur.jaChars + next.jaChars
  if (mergedChars > cfg.maxTranscriptChars) return false
  return true
}

/**
 * Phase1: 「末尾が mid-sentence で次に続く」JaBlock を次ブロックと結合する。
 *
 * 詳細仕様: 同階層の detectIncompleteEnds.ts コメント参照。
 *
 * @param blocks semanticSplitJa 出力（または mergeShort 前のブロック）
 * @param settings AdminSettings（enabled / 閾値・モデル ID を参照）
 * @param onWarning 検出失敗・early abort 時の警告通知（trace に残す）
 */
export async function mergeContinuation(
  blocks: JaBlock[],
  settings: AdminSettings,
  onWarning?: OnWarning,
): Promise<MergeContinuationResult> {
  if (!settings.pipelineMergeContinuationEnabled) {
    return { blocks, detectionCount: 0, detectionSuccess: 0, detectionFailed: 0, mergedCount: 0 }
  }
  if (blocks.length <= 1) {
    return { blocks, detectionCount: 0, detectionSuccess: 0, detectionFailed: 0, mergedCount: 0 }
  }

  const detection = await detectIncompleteEnds(blocks.map(b => b.jaText), settings)

  // 失敗の見える化: trace に残す
  if (detection.abortReason) {
    onWarning?.(
      'mergeContinuation',
      `detection aborted: ${detection.abortReason} (skipped ${detection.failed} of ${blocks.length} blocks; no continuation merge will happen)`,
    )
  } else if (detection.failed > 0) {
    onWarning?.(
      'mergeContinuation',
      `detection partial failure: ${detection.failed} of ${blocks.length} blocks fell back to no-merge (e.g. transient API errors)`,
    )
  }

  const tagged = blocks.map((block, i) => ({ ...block, endsIncomplete: detection.flags[i] }))

  const cfg: MergeConfig = {
    maxGapSec: settings.pipelineMergeContinuationMaxGapSec,
    maxDurationSec: settings.pipelineMergeContinuationMaxDurationSec,
    maxTranscriptChars: settings.pipelineMergeContinuationMaxTranscriptChars,
  }

  const result: JaBlock[] = [...tagged]
  let i = 0
  let mergedCount = 0
  while (i < result.length - 1) {
    const cur = result[i]
    const next = result[i + 1]
    if (cur.endsIncomplete && canMergeWithNext(cur, next, cfg)) {
      result.splice(i, 2, mergePair(cur, next))
      mergedCount += 1
      // 結合後の endsIncomplete は undefined → 連鎖結合を抑制（次ループで false 扱い）
      continue
    }
    i += 1
  }

  return {
    blocks: result,
    detectionCount: detection.flags.length,
    detectionSuccess: detection.success,
    detectionFailed: detection.failed,
    mergedCount,
    abortReason: detection.abortReason,
  }
}
