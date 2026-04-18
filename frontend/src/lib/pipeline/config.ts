/**
 * パイプライン実行設定。
 * AdminSettings から変換して使う。
 */

import type { SubtitleConstraints, QualityThresholds } from './constraints'
import type { AdminSettings } from '@/types/adminSettings'

export interface TimingConstraints {
  readonly minDurationSec: number
  readonly maxDurationSec: number
  readonly minJaChars: number
}

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
  readonly timingConstraints: TimingConstraints

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
    subtitleConstraints: {
      maxChars: settings.enMaxCharsPerLine ?? 42,
      maxLines: settings.enMaxLines ?? 2,
      maxTotalChars: settings.enMaxTotalChars ?? 84,
      maxCps: settings.enMaxCps ?? 17.0,
      maxRetry: 3,
    },
    qualityThresholds: {
      correction: settings.qualityCorrectionThreshold ?? 0.15,
      translation: settings.qualityTranslationThreshold ?? 0.25,
    },
    timingConstraints: {
      minDurationSec: settings.subtitleMinDurationSec ?? 0.833,
      maxDurationSec: settings.subtitleMaxDurationSec ?? 7.0,
      minJaChars: settings.mergeMinJaChars ?? 8,
    },
    outputLang,
  }
}
