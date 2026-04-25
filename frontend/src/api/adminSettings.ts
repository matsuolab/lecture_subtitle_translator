import type { AdminSettings, ServiceMode, TranslationProvider } from '@/types/adminSettings'

const STORAGE_KEY = 'subtitle-editor.admin-settings.v3'
const ENV_SERVICE_URL = (import.meta.env.VITE_PIPELINE_API_URL as string | undefined)?.replace(/\/$/, '') ?? ''
const ENV_HF_TOKEN = (import.meta.env.VITE_HF_TOKEN as string | undefined) ?? ''

const DEFAULT_SERVICE_MODE: ServiceMode = 'legacy_pipeline'
const DEFAULT_TRANSLATION_PROVIDER: TranslationProvider = 'openai'

export function getDefaultAdminSettings(): AdminSettings {
  return {
    serviceMode: DEFAULT_SERVICE_MODE,
    serviceUrl: ENV_SERVICE_URL,
    serviceAuthToken: '',
    hfToken: ENV_HF_TOKEN,
    openaiApiKey: '',
    geminiApiKey: '',
    deeplApiKey: '',
    openaiCompatibleBaseUrl: '',
    translationProvider: DEFAULT_TRANSLATION_PROVIDER,
  }
}

function normalizeServiceMode(value: unknown): ServiceMode {
  return value === 'managed_service' || value === 'legacy_pipeline'
    ? value
    : DEFAULT_SERVICE_MODE
}

function normalizeTranslationProvider(value: unknown): TranslationProvider {
  return value === 'openai' || value === 'gemini' || value === 'deepl' || value === 'local'
    ? value
    : DEFAULT_TRANSLATION_PROVIDER
}

export function normalizeAdminSettings(value: unknown): AdminSettings {
  const raw = typeof value === 'object' && value !== null ? value as Partial<AdminSettings> & { pipelineApiUrl?: string } : {}
  const defaults = getDefaultAdminSettings()
  const migratedServiceUrl = typeof raw.serviceUrl === 'string'
    ? raw.serviceUrl
    : typeof raw.pipelineApiUrl === 'string'
      ? raw.pipelineApiUrl
      : defaults.serviceUrl

  return {
    serviceMode: normalizeServiceMode(raw.serviceMode),
    serviceUrl: migratedServiceUrl,
    serviceAuthToken: typeof raw.serviceAuthToken === 'string' ? raw.serviceAuthToken : '',
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
    if (raw) return normalizeAdminSettings(JSON.parse(raw))

    const legacy = localStorage.getItem('subtitle-editor.admin-settings.v2')
    return legacy ? normalizeAdminSettings(JSON.parse(legacy)) : getDefaultAdminSettings()
  } catch {
    return getDefaultAdminSettings()
  }
}

export function saveAdminSettings(settings: AdminSettings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(normalizeAdminSettings(settings)))
}
