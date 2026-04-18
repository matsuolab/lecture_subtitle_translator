export type TranslationProvider = 'openai' | 'gemini' | 'deepl' | 'local'

export interface AdminSettings {
  // 旧バックエンドAPI（廃止予定）
  pipelineApiUrl: string
  hfToken: string

  // OpenAI
  openaiApiKey: string
  geminiApiKey: string
  deeplApiKey: string
  openaiCompatibleBaseUrl: string
  translationProvider: TranslationProvider

  // WhisperX ローカルサーバー
  whisperxUrl: string
  whisperxApiKey: string
  whisperxLanguage: string

  // モデル設定
  correctionModel: string
  translationModel: string
  embeddingModel: string

  // ログ設定
  /** 保持するログ件数の上限。null = 無制限（デフォルト）。 */
  logRetentionCount: number | null

  // 字幕品質パラメータ
  /** 英語1行あたりの最大文字数（デフォルト: 42） */
  enMaxCharsPerLine: number
  /** 英語字幕の最大行数（デフォルト: 2） */
  enMaxLines: number
  /** 英語字幕の全行合計最大文字数（デフォルト: 84） */
  enMaxTotalChars: number
  /** 英語字幕の最大CPS（デフォルト: 17.0） */
  enMaxCps: number
  /** 字幕最短表示時間・秒（デフォルト: 0.833） */
  subtitleMinDurationSec: number
  /** 字幕最長表示時間・秒（デフォルト: 7.0） */
  subtitleMaxDurationSec: number
  /** マージ対象とするJA最小文字数（デフォルト: 8） */
  mergeMinJaChars: number
  /** 補正品質Embedding距離閾値（デフォルト: 0.15） */
  qualityCorrectionThreshold: number
  /** 翻訳品質Embedding距離閾値（デフォルト: 0.25） */
  qualityTranslationThreshold: number
}
