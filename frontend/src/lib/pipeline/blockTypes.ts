import type { WordTimestamp } from './types'
import type { PipelineCorrectionAttemptSummary } from '@/types/pipeline'

export type AlignConf = 'exact' | 'proportional' | 'merged'

export type ViolationCode =
  | 'ok'
  | 'short_duration'
  | 'over_compressed'
  | 'verbose_en'
  | 'line_length_only'
  | 'long_segment'
  | 'proportional_ts'
  | 'merged_long'
  | 'slow_speech'

export interface JaBlock {
  id: number
  start: number
  end: number
  jaText: string
  jaChars: number
  alignConf: AlignConf
  words?: WordTimestamp[]
  merged?: boolean
}

export interface EnBlock extends JaBlock {
  enText: string
  enRaw?: string
  enChars: number
  cps: number
  maxLineLen: number
  violation: ViolationCode
  expandCount: number
  compressCount: number
  enTextOriginal?: string
  embeddingDistances?: {
    distJaToOrig: number
    distOrigToModified: number
    distJaToModified: number
  }
  correctionAttempts?: PipelineCorrectionAttemptSummary[]
}

export interface PipelineThresholds {
  shortDurationSec: number
  longDurationSec: number
  mergedLongDurationSec: number
  overCompressedRatio: number
  overCompressedJaChars: number
  verboseEnRatio: number
  verboseCps: number
  maxLineLen: number
  slowCps: number
  maxExpandPerBlock: number
  maxCompressPerBlock: number
  maxPhase2Retries: number
}

export interface BlockMetrics {
  duration: number
  jaChars: number
  enChars: number
  enJaRatio: number
  cps: number
  maxLineLen: number
}

export const DEFAULT_PIPELINE_THRESHOLDS: PipelineThresholds = {
  shortDurationSec: 1.5,
  longDurationSec: 10.0,
  mergedLongDurationSec: 7.0,
  overCompressedRatio: 0.25,
  overCompressedJaChars: 15,
  verboseEnRatio: 1.5,
  verboseCps: 17,
  maxLineLen: 42,
  slowCps: 3.0,
  maxExpandPerBlock: 3,
  maxCompressPerBlock: 5,
  maxPhase2Retries: 3,
}
