import type { AdminSettings, ServiceMode, TranslationProvider } from '@/types/adminSettings'
import { DEFAULT_LANGUAGE_PROFILE_CONFIG_JSON } from '@/lib/pipeline/languageProfileConfig'

const STORAGE_KEY = 'subtitle-editor.admin-settings.v3'
const ENV_SERVICE_URL = (import.meta.env.VITE_PIPELINE_API_URL as string | undefined)?.replace(/\/$/, '') ?? ''
const ENV_HF_TOKEN = (import.meta.env.VITE_HF_TOKEN as string | undefined) ?? ''
const DEFAULT_LOCAL_TRANSCRIPT_API_BASE = 'http://127.0.0.1:8000'

const DEFAULT_SERVICE_MODE: ServiceMode = 'legacy_pipeline'
const DEFAULT_TRANSLATION_PROVIDER: TranslationProvider = 'openai'

export function getDefaultAdminSettings(): AdminSettings {
  return {
    serviceMode: DEFAULT_SERVICE_MODE,
    serviceUrl: ENV_SERVICE_URL || DEFAULT_LOCAL_TRANSCRIPT_API_BASE,
    serviceAuthToken: '',
    hfToken: ENV_HF_TOKEN,
    openaiApiKey: '',
    geminiApiKey: '',
    deeplApiKey: '',
    openaiCompatibleBaseUrl: '',
    translationProvider: DEFAULT_TRANSLATION_PROVIDER,
    translationModel: 'gpt-5.4-mini',
    correctionModel: 'gpt-5.4-mini',
    embeddingModel: 'text-embedding-3-small',
    logRetentionCount: null,
    enMaxCharsPerLine: 80,
    enMaxLines: 2,
    enMaxTotalChars: 160,
    enMaxCps: 16.9,
    subtitleMinDurationSec: 0.833,
    subtitleMaxDurationSec: 7.0,
    mergeMinJaChars: 8,
    qualityCorrectionThreshold: 0.15,
    qualityTranslationThreshold: 0.25,
    pipelineShortDurationSec: 1.5,
    pipelineLongDurationSec: 10.0,
    pipelineMergedLongDurationSec: 7.0,
    pipelineVerboseEnRatio: 1.5,
    pipelineOverCompressedRatio: 0.25,
    pipelineOverCompressedJaChars: 15,
    pipelineSlowCps: 3.0,
    pipelineMaxExpandPerBlock: 3,
    pipelineMaxCompressPerBlock: 5,
    pipelineMaxPhase2Retries: 3,
    compressModel: 'gpt-5.4-mini',
    expandModel: 'gpt-5.4-mini',
    contextMergeModel: 'gpt-5.5',
    subtitleLanguageLabel: 'English',
    transcriptLanguageLabel: 'Japanese',
    languageProfileConfigJson: DEFAULT_LANGUAGE_PROFILE_CONFIG_JSON,
    compressPromptOverride: '',
    expandPromptOverride: '',
  }
}

function normalizePositiveNumber(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : parseFloat(value as string)
  return isFinite(n) && n > 0 ? n : fallback
}

function normalizeServiceMode(value: unknown): ServiceMode {
  return value === 'managed_service' || value === 'legacy_pipeline'
    ? value
    : DEFAULT_SERVICE_MODE
}

function normalizeTranslationProvider(value: unknown): TranslationProvider {
  if (value === 'openai' || value === 'gemini' || value === 'deepl') {
    return value
  }
  if (value === 'local') {
    return DEFAULT_TRANSLATION_PROVIDER
  }
  return DEFAULT_TRANSLATION_PROVIDER
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
    translationModel: typeof raw.translationModel === 'string' && raw.translationModel ? raw.translationModel : defaults.translationModel,
    correctionModel: typeof raw.correctionModel === 'string' && raw.correctionModel ? raw.correctionModel : defaults.correctionModel,
    embeddingModel: typeof raw.embeddingModel === 'string' && raw.embeddingModel ? raw.embeddingModel : defaults.embeddingModel,
    logRetentionCount: typeof raw.logRetentionCount === 'number' ? raw.logRetentionCount : null,
    enMaxCharsPerLine: normalizePositiveNumber(raw.enMaxCharsPerLine, defaults.enMaxCharsPerLine),
    enMaxLines: normalizePositiveNumber(raw.enMaxLines, defaults.enMaxLines),
    enMaxTotalChars: normalizePositiveNumber(raw.enMaxTotalChars, defaults.enMaxTotalChars),
    enMaxCps: normalizePositiveNumber(raw.enMaxCps, defaults.enMaxCps),
    subtitleMinDurationSec: normalizePositiveNumber(raw.subtitleMinDurationSec, defaults.subtitleMinDurationSec),
    subtitleMaxDurationSec: normalizePositiveNumber(raw.subtitleMaxDurationSec, defaults.subtitleMaxDurationSec),
    mergeMinJaChars: normalizePositiveNumber(raw.mergeMinJaChars, defaults.mergeMinJaChars),
    qualityCorrectionThreshold: normalizePositiveNumber(raw.qualityCorrectionThreshold, defaults.qualityCorrectionThreshold),
    qualityTranslationThreshold: normalizePositiveNumber(raw.qualityTranslationThreshold, defaults.qualityTranslationThreshold),
    pipelineShortDurationSec: normalizePositiveNumber(raw.pipelineShortDurationSec, defaults.pipelineShortDurationSec),
    pipelineLongDurationSec: normalizePositiveNumber(raw.pipelineLongDurationSec, defaults.pipelineLongDurationSec),
    pipelineMergedLongDurationSec: normalizePositiveNumber(raw.pipelineMergedLongDurationSec, defaults.pipelineMergedLongDurationSec),
    pipelineVerboseEnRatio: normalizePositiveNumber(raw.pipelineVerboseEnRatio, defaults.pipelineVerboseEnRatio),
    pipelineOverCompressedRatio: normalizePositiveNumber(raw.pipelineOverCompressedRatio, defaults.pipelineOverCompressedRatio),
    pipelineOverCompressedJaChars: normalizePositiveNumber(raw.pipelineOverCompressedJaChars, defaults.pipelineOverCompressedJaChars),
    pipelineSlowCps: normalizePositiveNumber(raw.pipelineSlowCps, defaults.pipelineSlowCps),
    pipelineMaxExpandPerBlock: normalizePositiveNumber(raw.pipelineMaxExpandPerBlock, defaults.pipelineMaxExpandPerBlock),
    pipelineMaxCompressPerBlock: normalizePositiveNumber(raw.pipelineMaxCompressPerBlock, defaults.pipelineMaxCompressPerBlock),
    pipelineMaxPhase2Retries: normalizePositiveNumber(raw.pipelineMaxPhase2Retries, defaults.pipelineMaxPhase2Retries),
    compressModel: typeof raw.compressModel === 'string' && raw.compressModel ? raw.compressModel : defaults.compressModel,
    expandModel: typeof raw.expandModel === 'string' && raw.expandModel ? raw.expandModel : defaults.expandModel,
    contextMergeModel: typeof raw.contextMergeModel === 'string' && raw.contextMergeModel ? raw.contextMergeModel : defaults.contextMergeModel,
    subtitleLanguageLabel: typeof raw.subtitleLanguageLabel === 'string' && raw.subtitleLanguageLabel ? raw.subtitleLanguageLabel : defaults.subtitleLanguageLabel,
    transcriptLanguageLabel: typeof raw.transcriptLanguageLabel === 'string' && raw.transcriptLanguageLabel ? raw.transcriptLanguageLabel : defaults.transcriptLanguageLabel,
    languageProfileConfigJson: typeof raw.languageProfileConfigJson === 'string' && raw.languageProfileConfigJson ? raw.languageProfileConfigJson : defaults.languageProfileConfigJson,
    compressPromptOverride: typeof raw.compressPromptOverride === 'string' ? raw.compressPromptOverride : '',
    expandPromptOverride: typeof raw.expandPromptOverride === 'string' ? raw.expandPromptOverride : '',
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
