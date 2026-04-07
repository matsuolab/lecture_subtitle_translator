import type { AdminSettings, TranslationProvider } from '@/types/adminSettings'

const STORAGE_KEY = 'subtitle-editor.admin-settings.v2'
const ENV_PIPELINE_API_URL = (import.meta.env.VITE_PIPELINE_API_URL as string | undefined)?.replace(/\/$/, '') ?? ''
const ENV_HF_TOKEN = (import.meta.env.VITE_HF_TOKEN as string | undefined) ?? ''

const DEFAULT_TRANSLATION_PROVIDER: TranslationProvider = 'openai'

export function getDefaultAdminSettings(): AdminSettings {
  return {
    pipelineApiUrl: ENV_PIPELINE_API_URL,
    hfToken: ENV_HF_TOKEN,
    openaiApiKey: '',
    geminiApiKey: '',
    deeplApiKey: '',
    openaiCompatibleBaseUrl: '',
    translationProvider: DEFAULT_TRANSLATION_PROVIDER,
  }
}

function normalizeTranslationProvider(value: unknown): TranslationProvider {
  return value === 'openai' || value === 'gemini' || value === 'deepl' || value === 'local'
    ? value
    : DEFAULT_TRANSLATION_PROVIDER
}

export function normalizeAdminSettings(value: unknown): AdminSettings {
  const raw = typeof value === 'object' && value !== null ? value as Partial<AdminSettings> : {}
  const defaults = getDefaultAdminSettings()
  return {
    pipelineApiUrl: typeof raw.pipelineApiUrl === 'string' ? raw.pipelineApiUrl : defaults.pipelineApiUrl,
    hfToken: typeof raw.hfToken === 'string' ? raw.hfToken : defaults.hfToken,
    openaiApiKey: typeof raw.openaiApiKey === 'string' ? raw.openaiApiKey : '',
    geminiApiKey: typeof raw.geminiApiKey === 'string' ? raw.geminiApiKey : '',
    deeplApiKey: typeof raw.deeplApiKey === 'string' ? raw.deeplApiKey : '',
    openaiCompatibleBaseUrl: typeof raw.openaiCompatibleBaseUrl === 'string' ? raw.openaiCompatibleBaseUrl : '',
    translationProvider: normalizeTranslationProvider(raw.translationProvider),
  }
}

export function loadAdminSettings(): AdminSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? normalizeAdminSettings(JSON.parse(raw)) : getDefaultAdminSettings()
  } catch {
    return getDefaultAdminSettings()
  }
}

export function saveAdminSettings(settings: AdminSettings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(normalizeAdminSettings(settings)))
}
