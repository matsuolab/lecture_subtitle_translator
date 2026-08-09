import type { AdminSettings } from '@/types/adminSettings'
import type { PipelineThresholds } from './blockTypes'

/**
 * PipelineThresholds の各フィールドが AdminSettings のどの設定キーに対応するかの、唯一の対応表。
 *
 * localPipeline.ts（本番の閾値組み立て）と、保存済みプロジェクトJSONを読む監査系スクリプト
 * （scripts/auditOutput.ts, scripts/reclassifyViolations.ts）が、それぞれ独自にこの対応を
 * ハードコードしていた。設定キーを追加・変更したときに一方だけ更新漏れが起きる構造だったため、
 * ここに集約する。
 */
export const PIPELINE_THRESHOLD_FIELDS: ReadonlyArray<{
  readonly field: keyof PipelineThresholds
  readonly settingsKey: keyof AdminSettings
}> = [
  { field: 'shortDurationSec', settingsKey: 'pipelineShortDurationSec' },
  { field: 'longDurationSec', settingsKey: 'pipelineLongDurationSec' },
  { field: 'mergedLongDurationSec', settingsKey: 'pipelineMergedLongDurationSec' },
  { field: 'overCompressedRatio', settingsKey: 'pipelineOverCompressedRatio' },
  { field: 'overCompressedJaChars', settingsKey: 'pipelineOverCompressedJaChars' },
  { field: 'verboseEnRatio', settingsKey: 'pipelineVerboseEnRatio' },
  { field: 'verboseCps', settingsKey: 'enMaxCps' },
  { field: 'maxLineLen', settingsKey: 'enMaxCharsPerLine' },
  { field: 'slowCps', settingsKey: 'pipelineSlowCps' },
  { field: 'maxExpandPerBlock', settingsKey: 'pipelineMaxExpandPerBlock' },
  { field: 'maxCompressPerBlock', settingsKey: 'pipelineMaxCompressPerBlock' },
]

/** 本番設定（AdminSettings）から PipelineThresholds を組み立てる。対応表はこのファイルの単一情報源。 */
export function buildPipelineThresholdsFromSettings(settings: AdminSettings): PipelineThresholds {
  const result = {} as Record<keyof PipelineThresholds, number>
  for (const { field, settingsKey } of PIPELINE_THRESHOLD_FIELDS) {
    result[field] = settings[settingsKey] as number
  }
  return result as PipelineThresholds
}
