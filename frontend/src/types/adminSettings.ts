export type TranslationProvider = 'openai' | 'gemini'
export type ServiceMode = 'managed_service' | 'legacy_pipeline'

export interface AdminSettings {
  serviceMode: ServiceMode
  serviceUrl: string
  serviceAuthToken: string
  hfToken: string
  openaiApiKey: string
  geminiApiKey: string
  openaiCompatibleBaseUrl: string
  translationProvider: TranslationProvider
  translationModel: string
  correctionModel: string
  embeddingModel: string
  logRetentionCount: number | null
  enMaxCharsPerLine: number
  enMaxLines: number
  enMaxTotalChars: number
  enMaxCps: number
  subtitleMinDurationSec: number
  subtitleMaxDurationSec: number
  mergeMinJaChars: number
  qualityCorrectionThreshold: number
  qualityTranslationThreshold: number

  // パイプライン閾値（PipelineThresholds に完全マッピング）
  pipelineShortDurationSec: number
  pipelineLongDurationSec: number
  pipelineMergedLongDurationSec: number
  pipelineVerboseEnRatio: number
  pipelineOverCompressedRatio: number
  pipelineOverCompressedJaChars: number
  pipelineSlowCps: number
  pipelineMaxExpandPerBlock: number
  pipelineMaxCompressPerBlock: number
  pipelineMaxPhase2Retries: number

  // ノード別モデル
  compressModel: string
  expandModel: string
  contextMergeModel: string
  subtitleLanguageLabel: string
  transcriptLanguageLabel: string
  languageProfileConfigJson: string

  // プロンプト上書き（'' = デフォルト使用）
  compressPromptOverride: string
  expandPromptOverride: string
}
