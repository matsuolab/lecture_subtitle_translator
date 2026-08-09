/**
 * 保存済みプロジェクトJSONから PipelineThresholds を解決する、スクリプト共通の処理。
 *
 * 本番（localPipeline.ts）は AdminSettings をそのまま持っているが、スクリプトは
 * エクスポート済みのJSONから読むため、値がどこに入っているかが一定しない。
 * 優先順位は workLog.header.settingsSnapshot > session.adminSettings > コード既定値。
 *
 * 重要: プロジェクトJSONの adminSettings はエクスポート時に一部フィールドへ間引かれることが
 * あり（8/5 のファイルは30項目しか無く pipelineLongDurationSec が欠けていた）、欠けた項目を
 * コード既定値で黙って補うと、実際の設定（long=14秒）ではなく既定値（10秒）で測ってしまう。
 * 実際にそれをやって尺違反の件数を取り違えた。そのため値だけでなく「どこから来たか」も返し、
 * 呼出元が既定値で補った項目を警告できるようにする。
 *
 * フィールド名と設定キーの対応表は src/lib/pipeline/pipelineThresholdFields.ts が単一の情報源。
 */
import { DEFAULT_PIPELINE_THRESHOLDS, type PipelineThresholds } from '../src/lib/pipeline/blockTypes'
import { PIPELINE_THRESHOLD_FIELDS } from '../src/lib/pipeline/pipelineThresholdFields'

export type ThresholdSource = 'settingsSnapshot' | 'adminSettings' | 'コード既定値'

export interface ResolvedProjectThresholds {
  values: PipelineThresholds
  sources: Map<keyof PipelineThresholds, ThresholdSource>
}

function readNumber(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function resolveProjectThresholds(project: Record<string, unknown>): ResolvedProjectThresholds {
  const session = (project.session ?? {}) as Record<string, unknown>
  const admin = (session.adminSettings ?? {}) as Record<string, unknown>
  const workLog = (session.workLog ?? {}) as Record<string, unknown>
  const header = (workLog.header ?? {}) as Record<string, unknown>
  const snapshot = (header.settingsSnapshot ?? {}) as Record<string, unknown>

  const sources = new Map<keyof PipelineThresholds, ThresholdSource>()
  const values = {} as Record<keyof PipelineThresholds, number>
  for (const { field, settingsKey } of PIPELINE_THRESHOLD_FIELDS) {
    const fromSnapshot = readNumber(snapshot, settingsKey)
    if (fromSnapshot !== undefined) {
      sources.set(field, 'settingsSnapshot')
      values[field] = fromSnapshot
      continue
    }
    const fromAdmin = readNumber(admin, settingsKey)
    if (fromAdmin !== undefined) {
      sources.set(field, 'adminSettings')
      values[field] = fromAdmin
      continue
    }
    sources.set(field, 'コード既定値')
    values[field] = DEFAULT_PIPELINE_THRESHOLDS[field] as number
  }
  return { values: values as PipelineThresholds, sources }
}
