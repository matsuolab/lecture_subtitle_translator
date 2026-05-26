import type { AdminSettings } from '@/types/adminSettings'
import type { JaBlock, PipelineThresholds } from './blockTypes'
import type { TranscriptSegment } from './types'
import type { CorrectedSegmentLite } from './correct'
import { correctSegments } from './correct'
import { semanticSplitJa } from './semanticSplitJa'
import { mergeShort } from './mergeShort'
import { mergeContinuation } from './mergeContinuation'
import { runCorrectionDebug, isCorrectionDebugEnabled } from './correctionDebug'

type RunNode = <T>(nodeId: string, run: () => Promise<T> | T) => Promise<T>

// Phase2 と同じ形式の警告コールバック。Phase1 ノードからの検出失敗等を trace に残す。
export type Phase1OnWarning = (nodeId: string, message: string) => void

export interface Phase1Options {
  correctionThreshold?: number
  glossaryTerms?: string[]
}

export interface Phase1Result {
  blocks: JaBlock[]
  correctedSegments: CorrectedSegmentLite[]
}

export async function runPhase1(
  transcriptSegments: TranscriptSegment[],
  settings: AdminSettings,
  thresholds: PipelineThresholds,
  runNode: RunNode,
  onWarning?: Phase1OnWarning,
  options: Phase1Options = {},
): Promise<Phase1Result> {
  const corrected = await runNode('correctJa', () =>
    correctSegments(
      transcriptSegments,
      { threshold: options.correctionThreshold },
      settings,
      options.glossaryTerms ?? [],
    ),
  )
  // デバッグ計測：correctJa の効果（意味変動）を Embedding で測る
  // master debugModeEnabled + サブ correctionDebugEmbedding の両方が ON の時のみ実行
  if (isCorrectionDebugEnabled(settings)) {
    await runNode('correctionDebug', () => runCorrectionDebug(corrected, settings))
  }
  const split = await runNode('semanticSplitJa', () =>
    semanticSplitJa(corrected, settings, thresholds, options.glossaryTerms ?? []),
  )
  // Phase1: 「末尾 mid-sentence」のブロックを次と結合する（多言語対応 LLM 判定）
  // semanticSplitJa が継続助詞で切ったブロックを translate 前に統合し、
  // 後段 translateEn の overflow と CPS 違反を未然に防ぐ。
  const continuationMerged = await runNode('mergeContinuation', () =>
    mergeContinuation(split, settings, onWarning),
  )
  const merged = await runNode('mergeShort', () => mergeShort(continuationMerged.blocks, thresholds))
  return { blocks: merged, correctedSegments: corrected }
}
