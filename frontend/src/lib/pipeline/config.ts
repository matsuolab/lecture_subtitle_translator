/**
 * パイプライン実行設定。
 * AdminSettings から変換して使う。
 */

import type { SubtitleConstraints, QualityThresholds } from './constraints'
import { getSubtitleConstraints, DEFAULT_QUALITY_THRESHOLDS } from './constraints'
import type { AdminSettings } from '@/types/adminSettings'

export interface PipelineConfig {
  // WhisperX
  readonly whisperxUrl: string
  readonly whisperxApiKey: string
  readonly whisperxLanguage: string

  // OpenAI
  readonly openaiApiKey: string
  readonly correctionModel: string
  readonly translationModel: string
  readonly splitModel: string
  readonly embeddingModel: string

  // 字幕制約
  readonly subtitleConstraints: SubtitleConstraints
  readonly qualityThresholds: QualityThresholds

  // 出力
  readonly outputLang: string  // 翻訳先言語コード（デフォルト "en"）
}

export function buildPipelineConfig(settings: AdminSettings): PipelineConfig {
  const outputLang = 'en'
  return {
    whisperxUrl: settings.whisperxUrl ?? '',
    whisperxApiKey: settings.whisperxApiKey ?? '',
    whisperxLanguage: settings.whisperxLanguage ?? 'ja',
    openaiApiKey: settings.openaiApiKey ?? '',
    correctionModel: settings.correctionModel ?? 'gpt-4.1-nano',
    translationModel: settings.translationModel ?? 'gpt-5.4-mini',
    splitModel: 'gpt-4.1-nano',
    embeddingModel: settings.embeddingModel ?? 'text-embedding-3-small',
    subtitleConstraints: getSubtitleConstraints(outputLang),
    qualityThresholds: DEFAULT_QUALITY_THRESHOLDS,
    outputLang,
  }
}
