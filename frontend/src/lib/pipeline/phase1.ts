import type { AdminSettings } from '@/types/adminSettings'
import type { JaBlock, PipelineThresholds } from './blockTypes'
import type { TranscriptSegment } from './types'
import type { CorrectedSegmentLite } from './correct'
import { correctSegments } from './correct'
import { semanticSplitJa } from './semanticSplitJa'
import { mergeShort } from './mergeShort'
import { runCorrectionDebug, isCorrectionDebugEnabled } from './correctionDebug'

type RunNode = <T>(nodeId: string, run: () => Promise<T> | T) => Promise<T>

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
  const merged = await runNode('mergeShort', () => mergeShort(split, thresholds))
  return { blocks: merged, correctedSegments: corrected }
}
