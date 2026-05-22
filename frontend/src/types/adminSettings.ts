export type TranslationProvider = 'openai' | 'gemini' | 'local_openai'
export type ServiceMode = 'managed_service' | 'legacy_pipeline'
export type SemanticCheckMode = 'off' | 'log_only' | 'enforce'

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
  pdfExtractionUseVision: boolean
  pdfExtractionVisionModel: string
  pdfExtractionParallel: boolean
  glossaryMaxOutputTokens: number
  apiRequestConcurrency: number
  embeddingModel: string
  // セマンティックチェック（圧縮前後の意味類似度を Embedding で計測）
  semanticCheckMode: SemanticCheckMode
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
  microModel: string
  expandModel: string
  contextMergeModel: string
  subtitleLanguageLabel: string
  transcriptLanguageLabel: string
  languageProfileConfigJson: string
  textNormalizationEnabled: boolean
  textNormalizationRulesJson: string

  // プロンプト上書き（'' = デフォルト使用）
  compressPromptOverride: string
  expandPromptOverride: string

  // ワークログ（作業データ記録）の保管場所（'' = 既定の appLocalDataDir/worklogs）
  workLogDir: string
}
