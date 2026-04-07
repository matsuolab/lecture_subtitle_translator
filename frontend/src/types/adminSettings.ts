export type TranslationProvider = 'openai' | 'gemini' | 'deepl' | 'local'

export interface AdminSettings {
  pipelineApiUrl: string
  hfToken: string
  openaiApiKey: string
  geminiApiKey: string
  deeplApiKey: string
  openaiCompatibleBaseUrl: string
  translationProvider: TranslationProvider
}
