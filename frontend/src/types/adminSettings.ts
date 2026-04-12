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
}
