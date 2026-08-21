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
  readonly field: Exclude<keyof PipelineThresholds, 'subtitleScript' | 'transcriptScript'>
  readonly settingsKey: keyof AdminSettings
}> = [
  { field: 'shortDurationSec', settingsKey: 'pipelineShortDurationSec' },
  { field: 'longDurationSec', settingsKey: 'pipelineLongDurationSec' },
  { field: 'mergedLongDurationSec', settingsKey: 'pipelineMergedLongDurationSec' },
  { field: 'overCompressedRatio', settingsKey: 'pipelineOverCompressedRatio' },
  { field: 'overCompressedJaChars', settingsKey: 'pipelineOverCompressedJaChars' },
  // verboseEnRatio は PipelineThresholds から削除済み（判定ロジックが英日文字比を使わなくなったため）。
  // AdminSettings.pipelineVerboseEnRatio 自体は既存保存データ互換のため残るが、対応表には含めない。
  { field: 'verboseCps', settingsKey: 'enMaxCps' },
  { field: 'maxLineLen', settingsKey: 'enMaxCharsPerLine' },
  { field: 'slowCps', settingsKey: 'pipelineSlowCps' },
  { field: 'maxExpandPerBlock', settingsKey: 'pipelineMaxExpandPerBlock' },
  { field: 'maxCompressPerBlock', settingsKey: 'pipelineMaxCompressPerBlock' },
]

/**
 * 本番設定（AdminSettings）から PipelineThresholds を組み立てる。対応表はこのファイルの単一情報源。
 * subtitleScript / transcriptScript（言語作法）はこの対応表の対象外。呼び出し側
 * （localPipeline.ts の buildPipelineThresholds）が languageProfileConfig から別途補う。
 */
export function buildPipelineThresholdsFromSettings(settings: AdminSettings): PipelineThresholds {
  const result = {} as Record<Exclude<keyof PipelineThresholds, 'subtitleScript' | 'transcriptScript'>, number>
  for (const { field, settingsKey } of PIPELINE_THRESHOLD_FIELDS) {
    result[field] = settings[settingsKey] as number
  }
  return result as PipelineThresholds
}
