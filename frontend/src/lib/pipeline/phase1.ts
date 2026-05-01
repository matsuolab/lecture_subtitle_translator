import type { AdminSettings } from '@/types/adminSettings'
import type { PipelineThresholds } from './blockTypes'
import type { TranscriptSegment } from './types'
import { correctSegments } from './correct'
import { splitJa } from './splitJa'
import { mergeShort } from './mergeShort'

type RunNode = <T>(nodeId: string, run: () => Promise<T> | T) => Promise<T>

export interface Phase1Options {
  correctionThreshold?: number
  glossaryTerms?: string[]
}

export async function runPhase1(
  transcriptSegments: TranscriptSegment[],
  settings: AdminSettings,
  thresholds: PipelineThresholds,
  runNode: RunNode,
  options: Phase1Options = {},
): Promise<ReturnType<typeof mergeShort>> {
  const corrected = await runNode('correctJa', () =>
    correctSegments(
      transcriptSegments,
      { threshold: options.correctionThreshold },
      settings,
      options.glossaryTerms ?? [],
    ),
  )
  const split = await runNode('splitJa', () => splitJa(corrected))
  return await runNode('mergeShort', () => mergeShort(split, thresholds))
}
