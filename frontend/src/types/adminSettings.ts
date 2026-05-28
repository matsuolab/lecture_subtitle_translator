export type TranslationProvider = 'openai' | 'gemini' | 'local_openai'
export type ServiceMode = 'managed_service' | 'legacy_pipeline'
export type SemanticCheckMode = 'off' | 'log_only' | 'enforce'
export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high'

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
  pdfFormulaMiniModel: string
  pdfExtractionParallel: boolean
  glossaryMaxOutputTokens: number
  apiRequestConcurrency: number
  embeddingModel: string
  // セマンティックチェック（圧縮前後の意味類似度を Embedding で計測）
  semanticCheckMode: SemanticCheckMode
  enMaxCharsPerLine: number
  enMaxLines: number
  enMaxTotalChars: number
  enMaxCps: number
  subtitleMinDurationSec: number
  subtitleMaxDurationSec: number
  qualityCorrectionThreshold: number

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

  // Phase1: 継続助詞（mid-sentence cut）で終わる JA ブロックを次と結合する前処理
  // semanticSplitJa が「〜が」「〜の」「〜まで」等で切れたブロックを生むと、後段 translateEn が
  // 隣接ブロック内容を取り込んで EN がオーバーフローし、CPS 違反になる。これを未然に防ぐ。
  pipelineMergeContinuationEnabled: boolean
  pipelineMergeContinuationMaxGapSec: number
  pipelineMergeContinuationMaxDurationSec: number
  pipelineMergeContinuationMaxTranscriptChars: number
  // mergeContinuation で使う「未完結末尾」判定モデル（nano クラス推奨）。
  // 空欄なら splitJaModel にフォールバック。多言語対応のため LLM で判定する。
  incompleteEndDetectionModel: string
  incompleteEndDetectionBatchSize: number

  // ノード別モデル
  compressModel: string
  microModel: string
  expandModel: string
  contextMergeModel: string
  splitJaModel: string
  subtitleLanguageLabel: string
  transcriptLanguageLabel: string
  languageProfileConfigJson: string
  textNormalizationEnabled: boolean
  textNormalizationRulesJson: string

  // プロンプト上書き（'' = デフォルト使用）
  correctionAdditionalInstructions: string
  correctionFewShotJson: string
  translationAdditionalInstructions: string
  translationFewShotJson: string
  compressPromptOverride: string
  expandPromptOverride: string

  // coverage_repair_agent の有効化（source_text_undercovered 検出時に発動）
  coverageRepairEnabled: boolean
  // coverage_repair_agent 用モデル（空欄なら compressModel にフォールバック）
  coverageRepairModel: string
  // coverage_repair_agent の reasoning effort
  coverageRepairEffort: ReasoningEffort

  // general_repair_agent エスカレーション（low → medium → high）の有効化
  // OFF にすると manual_review に直行する（PoC 同等プロセス保証を放棄）
  generalRepairEnabled: boolean
  // general_repair_agent 用モデル（空欄なら compressModel にフォールバック）
  generalRepairModel: string
  // general_repair_agent エスカレーション上限。リリース前のコスト抑制中は high も medium 相当に丸める。
  generalRepairMaxEffort: 'low' | 'medium' | 'high'

  // デバッグ機能
  // debugModeEnabled が master switch。OFF 時はサブ機能フラグが ON でも全部無効
  debugModeEnabled: boolean
  // サブ機能: correctJa 後に Embedding で意味変動を計測。debugModeEnabled と AND
  correctionDebugEmbedding: boolean

  // ワークログ（作業データ記録）の保管場所（'' = 既定の appLocalDataDir/worklogs）
  workLogDir: string
}
