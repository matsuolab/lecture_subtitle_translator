import type { AdminSettings, TranslationProvider } from '@/types/adminSettings'

export const OPENAI_CHAT_BASE_URL = 'https://api.openai.com/v1'
export const GEMINI_OPENAI_COMPAT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai'
export const DEFAULT_OPENAI_CHAT_MODEL = 'gpt-5.4-mini'
export const DEFAULT_GEMINI_CHAT_MODEL = 'gemini-3-flash-preview'

export type AiProvider = Extract<TranslationProvider, 'openai' | 'gemini'>

export type AiConnection = {
  provider: AiProvider
  providerLabel: string
  apiKey: string
  baseUrl: string
}

export function resolveAiProvider(settings: Pick<AdminSettings, 'translationProvider'>): AiProvider {
  return settings.translationProvider === 'gemini' ? 'gemini' : 'openai'
}

export function getAiProviderLabel(provider: AiProvider): string {
  return provider === 'gemini' ? 'Gemini' : 'OpenAI'
}

export function resolveAiConnection(settings: AdminSettings): AiConnection {
  const provider = resolveAiProvider(settings)
  const providerLabel = getAiProviderLabel(provider)
  const apiKey = provider === 'gemini'
    ? settings.geminiApiKey.trim()
    : settings.openaiApiKey.trim()
  const baseUrl = provider === 'gemini'
    ? GEMINI_OPENAI_COMPAT_BASE_URL
    : (settings.openaiCompatibleBaseUrl.trim() || OPENAI_CHAT_BASE_URL).replace(/\/$/, '')

  return { provider, providerLabel, apiKey, baseUrl }
}

export function requireAiConnection(settings: AdminSettings, purpose = 'the pipeline'): AiConnection {
  const connection = resolveAiConnection(settings)
  if (!connection.apiKey) {
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
  if (!model || isProviderMismatchedModel(provider, model)) {
    return provider === 'gemini' ? geminiFallback : openAiFallback
  }
  return model
}
