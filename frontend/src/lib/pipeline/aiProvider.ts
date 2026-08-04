import type { AdminSettings, TranslationProvider } from '@/types/adminSettings'

export const OPENAI_CHAT_BASE_URL = 'https://api.openai.com/v1'
export const GEMINI_OPENAI_COMPAT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai'
export const LOCAL_OPENAI_COMPAT_BASE_URL = 'http://127.0.0.1:1234/v1'
export const LOCAL_OLLAMA_OPENAI_COMPAT_BASE_URL = 'http://127.0.0.1:11434/v1'
export const DEFAULT_OPENAI_CHAT_MODEL = 'gpt-5.6-luna'
export const DEFAULT_GEMINI_CHAT_MODEL = 'gemini-3-flash-preview'

export type AiProvider = Extract<TranslationProvider, 'openai' | 'gemini' | 'local_openai'>

export type AiConnection = {
  provider: AiProvider
  providerLabel: string
  apiKey: string
  baseUrl: string
}

export function resolveAiProvider(settings: Pick<AdminSettings, 'translationProvider'>): AiProvider {
  if (settings.translationProvider === 'local_openai') return 'local_openai'
  return settings.translationProvider === 'gemini' ? 'gemini' : 'openai'
}

export function getAiProviderLabel(provider: AiProvider): string {
  if (provider === 'local_openai') return 'Local OpenAI Compatible'
  return provider === 'gemini' ? 'Gemini' : 'OpenAI'
}

export function resolveAiConnection(settings: AdminSettings): AiConnection {
  const provider = resolveAiProvider(settings)
  const providerLabel = getAiProviderLabel(provider)
  const apiKey = provider === 'gemini' ? settings.geminiApiKey.trim() : settings.openaiApiKey.trim()
  const baseUrl = provider === 'gemini'
    ? GEMINI_OPENAI_COMPAT_BASE_URL
    : (
        settings.openaiCompatibleBaseUrl.trim()
        || (provider === 'local_openai' ? LOCAL_OPENAI_COMPAT_BASE_URL : OPENAI_CHAT_BASE_URL)
      ).replace(/\/$/, '')

  return { provider, providerLabel, apiKey, baseUrl }
}

export function requireAiConnection(settings: AdminSettings, purpose = 'the pipeline'): AiConnection {
  const connection = resolveAiConnection(settings)
  if (connection.provider !== 'local_openai' && !connection.apiKey) {
    throw new Error(`${connection.providerLabel} API key is required before running ${purpose}`)
  }
  return connection
}

function isProviderMismatchedModel(provider: AiProvider, model: string): boolean {
  const normalized = model.trim().toLowerCase()
  if (!normalized) return false
  if (provider === 'gemini') {
    return normalized.startsWith('gpt-') || normalized.startsWith('o') || normalized.startsWith('ft:')
  }
  if (provider === 'local_openai') return false
  return normalized.startsWith('gemini-')
}

export function resolveChatModelForProvider(
  settings: AdminSettings,
  requestedModel: string | undefined,
  openAiFallback = DEFAULT_OPENAI_CHAT_MODEL,
  geminiFallback = DEFAULT_GEMINI_CHAT_MODEL,
): string {
  const provider = resolveAiProvider(settings)
  const model = requestedModel?.trim() ?? ''
  if (provider === 'local_openai') return model
  if (!model || isProviderMismatchedModel(provider, model)) {
    return provider === 'gemini' ? geminiFallback : openAiFallback
  }
  return model
}

export function requireChatModelForProvider(
  settings: AdminSettings,
  requestedModel: string | undefined,
  purpose = 'LLM processing',
  openAiFallback = DEFAULT_OPENAI_CHAT_MODEL,
  geminiFallback = DEFAULT_GEMINI_CHAT_MODEL,
): string {
  const model = resolveChatModelForProvider(settings, requestedModel, openAiFallback, geminiFallback)
  if (!model.trim()) {
    throw new Error(`Local OpenAI Compatible model is required before running ${purpose}. Refresh models or enter a local model ID.`)
  }
  return model
}

export function resolveJsonResponseFormatForProvider(
  settings: Pick<AdminSettings, 'translationProvider'>,
): { type: 'json_object' | 'text' } {
  return resolveAiProvider(settings) === 'local_openai'
    ? { type: 'text' }
    : { type: 'json_object' }
}

export function resolveChatCompletionTokenLimitForProvider(
  settings: Pick<AdminSettings, 'translationProvider'>,
  maxTokens: number,
): { max_tokens: number } | { max_completion_tokens: number } {
  return resolveAiProvider(settings) === 'openai'
    ? { max_completion_tokens: maxTokens }
    : { max_tokens: maxTokens }
}
