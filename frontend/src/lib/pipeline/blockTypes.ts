import type { WordTimestamp } from './types'
import type { PipelineCorrectionAttemptSummary } from '@/types/pipeline'

export type AlignConf = 'exact' | 'proportional' | 'no_words' | 'merged'

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
  | 'untranslated'  // 翻訳 API がリトライ後も未翻訳テキストを返した block

export interface JaBlock {
  id: number
  start: number
  end: number
  jaText: string
  jaChars: number
  alignConf: AlignConf
  words?: WordTimestamp[]
  merged?: boolean
  /**
   * Phase1 detectIncompleteEnds で判定された「末尾が mid-sentence で次に続く」フラグ。
   * - mergeContinuation: true なら次ブロックと結合候補
   * - splitBlock.canApply: true なら split を試みない（前段で結合済 / 結合不能のケース）
   * 未計算（旧データ・OFF時）の場合は undefined。
   */
  endsIncomplete?: boolean
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
  /**
   * 翻訳 API が未翻訳テキストを返した場合のリトライ詳細。
   * UI / ログに「なぜ未翻訳のままなのか」を表示するために使う。
   * 例: 'still_japanese_after_2_retries: jaRatio=0.78'、'api_error: HTTP 429'、'truncated_at_length_limit'
   */
  translationFailureReason?: string
  /** リトライ回数（0 = 初回成功、N = N 回追加でリトライした）*/
  translationRetryAttempts?: number
  /**
   * expandEn の途中で API 失敗した場合の理由（成功 / 不要時は undefined）。
   * 拡張は「短すぎる字幕の追記」なので失敗してもブロック全体は使えるが、
   * 改善の余地が残っていることを UI に表示するためのメタ情報。
   */
  expansionFailureReason?: string
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
