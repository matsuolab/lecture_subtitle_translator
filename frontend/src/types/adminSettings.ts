export type TranslationProvider = 'openai' | 'gemini' | 'deepl' | 'local'
export type ServiceMode = 'managed_service' | 'legacy_pipeline'

export interface AdminSettings {
  serviceMode: ServiceMode
  serviceUrl: string
  serviceAuthToken: string
  hfToken: string
  openaiApiKey: string
  geminiApiKey: string
  deeplApiKey: string
  openaiCompatibleBaseUrl: string
  translationProvider: TranslationProvider
}
