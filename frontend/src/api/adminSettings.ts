import type { AdminSettings, ReasoningEffort, ServiceMode, SemanticCheckMode, TranslationProvider } from '@/types/adminSettings'
import { DEFAULT_LANGUAGE_PROFILE_CONFIG_JSON } from '@/lib/pipeline/languageProfileConfig'
import { DEFAULT_TEXT_NORMALIZATION_RULES_JSON } from '@/lib/pipeline/textNormalization'
import {
  DEFAULT_CORRECTION_ADDITIONAL_INSTRUCTIONS,
  DEFAULT_CORRECTION_FEW_SHOT_JSON,
  DEFAULT_TRANSLATION_ADDITIONAL_INSTRUCTIONS,
  DEFAULT_TRANSLATION_FEW_SHOT_JSON,
} from '@/lib/pipeline/prompts'
import { normalizeConcurrency } from '@/lib/concurrency'

const STORAGE_KEY = 'subtitle-editor.admin-settings.v4'
const ENV_SERVICE_URL = (import.meta.env.VITE_PIPELINE_API_URL as string | undefined)?.replace(/\/$/, '') ?? ''
const ENV_HF_TOKEN = (import.meta.env.VITE_HF_TOKEN as string | undefined) ?? ''
const DEFAULT_LOCAL_TRANSCRIPT_API_BASE = 'http://127.0.0.1:8000'

const DEFAULT_SERVICE_MODE: ServiceMode = 'legacy_pipeline'
const DEFAULT_TRANSLATION_PROVIDER: TranslationProvider = 'openai'
const SHARED_SETTINGS_VERSION = 1
const SHARED_SETTINGS_EXCLUDED_FIELDS = [
  'serviceAuthToken',
  'hfToken',
  'openaiApiKey',
  'geminiApiKey',
  'workLogDir',
] satisfies Array<keyof AdminSettings>

export interface SharedAdminSettingsExport {
  version: number
  exportedAt: string
  kind: 'subtitle-editor-admin-settings'
  excludedFields: string[]
  settings: Partial<AdminSettings>
}

export function getDefaultAdminSettings(): AdminSettings {
  return {
    serviceMode: DEFAULT_SERVICE_MODE,
    serviceUrl: ENV_SERVICE_URL || DEFAULT_LOCAL_TRANSCRIPT_API_BASE,
    serviceAuthToken: '',
    hfToken: ENV_HF_TOKEN,
    openaiApiKey: '',
    geminiApiKey: '',
    openaiCompatibleBaseUrl: '',
    translationProvider: DEFAULT_TRANSLATION_PROVIDER,
    translationModel: 'gpt-5.4-mini',
    correctionModel: 'gpt-5.4-mini',
    pdfExtractionUseVision: false,
    pdfExtractionVisionModel: 'gpt-5.4-mini',
    pdfExtractionParallel: false,
    glossaryMaxOutputTokens: 4096,
    apiRequestConcurrency: 7,
    embeddingModel: 'text-embedding-3-small',
    semanticCheckMode: 'log_only',
    enMaxCharsPerLine: 80,
    enMaxLines: 2,
    enMaxTotalChars: 160,
    enMaxCps: 16.9,
    subtitleMinDurationSec: 0.833,
    subtitleMaxDurationSec: 7.0,
    qualityCorrectionThreshold: 0.15,
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
    pipelineMergeContinuationEnabled: true,
    pipelineMergeContinuationMaxGapSec: 1.5,
    pipelineMergeContinuationMaxDurationSec: 12,
    pipelineMergeContinuationMaxTranscriptChars: 80,
    incompleteEndDetectionModel: 'gpt-5.4-nano',
    incompleteEndDetectionBatchSize: 30,
    compressModel: 'gpt-5.4-mini',
    microModel: 'gpt-5.4-nano',
    expandModel: 'gpt-5.4-mini',
    contextMergeModel: 'gpt-5.4-mini',
    splitJaModel: 'gpt-5.4-nano',
    subtitleLanguageLabel: 'English',
    transcriptLanguageLabel: 'Japanese',
    languageProfileConfigJson: DEFAULT_LANGUAGE_PROFILE_CONFIG_JSON,
    textNormalizationEnabled: true,
    textNormalizationRulesJson: DEFAULT_TEXT_NORMALIZATION_RULES_JSON,
    correctionAdditionalInstructions: DEFAULT_CORRECTION_ADDITIONAL_INSTRUCTIONS,
    correctionFewShotJson: DEFAULT_CORRECTION_FEW_SHOT_JSON,
    translationAdditionalInstructions: DEFAULT_TRANSLATION_ADDITIONAL_INSTRUCTIONS,
    translationFewShotJson: DEFAULT_TRANSLATION_FEW_SHOT_JSON,
    compressPromptOverride: '',
    expandPromptOverride: '',
    coverageRepairEnabled: true,
    coverageRepairModel: 'gpt-5.4-mini',
    coverageRepairEffort: 'low',
    generalRepairEnabled: true,
    generalRepairModel: 'gpt-5.4-mini',
    generalRepairMaxEffort: 'medium',
    debugModeEnabled: false,
    correctionDebugEmbedding: false,
    workLogDir: '',
  }
}

function normalizePositiveNumber(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : parseFloat(value as string)
  return isFinite(n) && n > 0 ? n : fallback
}

function normalizeBoundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : parseFloat(value as string)
  if (!isFinite(n)) return fallback
  const rounded = Math.trunc(n)
  if (rounded < min || rounded > max) return fallback
  return rounded
}

function normalizeServiceMode(value: unknown): ServiceMode {
  return value === 'managed_service' || value === 'legacy_pipeline'
    ? value
    : DEFAULT_SERVICE_MODE
}

function normalizeTranslationProvider(value: unknown): TranslationProvider {
  if (value === 'openai' || value === 'gemini' || value === 'local_openai') {
    return value
  }
  return DEFAULT_TRANSLATION_PROVIDER
}

function normalizeSemanticCheckMode(value: unknown): SemanticCheckMode {
  if (value === 'off' || value === 'log_only' || value === 'enforce') return value
  return 'log_only'
}

function normalizeReasoningEffort(value: unknown, fallback: ReasoningEffort): ReasoningEffort {
  if (value === 'minimal' || value === 'low' || value === 'medium' || value === 'high') return value
  return fallback
}

function normalizeMaxEffort(value: unknown, fallback: 'low' | 'medium' | 'high'): 'low' | 'medium' | 'high' {
  if (value === 'low' || value === 'medium' || value === 'high') return value
  return fallback
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
    openaiCompatibleBaseUrl: typeof raw.openaiCompatibleBaseUrl === 'string' ? raw.openaiCompatibleBaseUrl : '',
    translationProvider: normalizeTranslationProvider(raw.translationProvider),
    translationModel: typeof raw.translationModel === 'string' && raw.translationModel ? raw.translationModel : defaults.translationModel,
    correctionModel: typeof raw.correctionModel === 'string' && raw.correctionModel ? raw.correctionModel : defaults.correctionModel,
    pdfExtractionUseVision: typeof raw.pdfExtractionUseVision === 'boolean' ? raw.pdfExtractionUseVision : defaults.pdfExtractionUseVision,
    pdfExtractionVisionModel: typeof raw.pdfExtractionVisionModel === 'string' && raw.pdfExtractionVisionModel ? raw.pdfExtractionVisionModel : defaults.pdfExtractionVisionModel,
    pdfExtractionParallel: typeof raw.pdfExtractionParallel === 'boolean' ? raw.pdfExtractionParallel : defaults.pdfExtractionParallel,
    glossaryMaxOutputTokens: normalizeBoundedInteger(raw.glossaryMaxOutputTokens, defaults.glossaryMaxOutputTokens, 256, 16384),
    apiRequestConcurrency: normalizeConcurrency(raw.apiRequestConcurrency, defaults.apiRequestConcurrency),
    embeddingModel: typeof raw.embeddingModel === 'string' && raw.embeddingModel ? raw.embeddingModel : defaults.embeddingModel,
    semanticCheckMode: normalizeSemanticCheckMode(raw.semanticCheckMode),
    enMaxCharsPerLine: normalizePositiveNumber(raw.enMaxCharsPerLine, defaults.enMaxCharsPerLine),
    enMaxLines: normalizePositiveNumber(raw.enMaxLines, defaults.enMaxLines),
    enMaxTotalChars: normalizePositiveNumber(raw.enMaxTotalChars, defaults.enMaxTotalChars),
    enMaxCps: normalizePositiveNumber(raw.enMaxCps, defaults.enMaxCps),
    subtitleMinDurationSec: normalizePositiveNumber(raw.subtitleMinDurationSec, defaults.subtitleMinDurationSec),
    subtitleMaxDurationSec: normalizePositiveNumber(raw.subtitleMaxDurationSec, defaults.subtitleMaxDurationSec),
    qualityCorrectionThreshold: normalizePositiveNumber(raw.qualityCorrectionThreshold, defaults.qualityCorrectionThreshold),
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
    pipelineMergeContinuationEnabled: typeof raw.pipelineMergeContinuationEnabled === 'boolean' ? raw.pipelineMergeContinuationEnabled : defaults.pipelineMergeContinuationEnabled,
    pipelineMergeContinuationMaxGapSec: normalizePositiveNumber(raw.pipelineMergeContinuationMaxGapSec, defaults.pipelineMergeContinuationMaxGapSec),
    pipelineMergeContinuationMaxDurationSec: normalizePositiveNumber(raw.pipelineMergeContinuationMaxDurationSec, defaults.pipelineMergeContinuationMaxDurationSec),
    pipelineMergeContinuationMaxTranscriptChars: normalizePositiveNumber(raw.pipelineMergeContinuationMaxTranscriptChars, defaults.pipelineMergeContinuationMaxTranscriptChars),
    incompleteEndDetectionModel: typeof raw.incompleteEndDetectionModel === 'string' && raw.incompleteEndDetectionModel ? raw.incompleteEndDetectionModel : defaults.incompleteEndDetectionModel,
    incompleteEndDetectionBatchSize: normalizeBoundedInteger(raw.incompleteEndDetectionBatchSize, defaults.incompleteEndDetectionBatchSize, 1, 200),
    compressModel: typeof raw.compressModel === 'string' && raw.compressModel ? raw.compressModel : defaults.compressModel,
    microModel: typeof raw.microModel === 'string' && raw.microModel ? raw.microModel : defaults.microModel,
    expandModel: typeof raw.expandModel === 'string' && raw.expandModel ? raw.expandModel : defaults.expandModel,
    contextMergeModel: typeof raw.contextMergeModel === 'string' && raw.contextMergeModel ? raw.contextMergeModel : defaults.contextMergeModel,
    splitJaModel: typeof raw.splitJaModel === 'string' && raw.splitJaModel ? raw.splitJaModel : defaults.splitJaModel,
    subtitleLanguageLabel: typeof raw.subtitleLanguageLabel === 'string' && raw.subtitleLanguageLabel ? raw.subtitleLanguageLabel : defaults.subtitleLanguageLabel,
    transcriptLanguageLabel: typeof raw.transcriptLanguageLabel === 'string' && raw.transcriptLanguageLabel ? raw.transcriptLanguageLabel : defaults.transcriptLanguageLabel,
    languageProfileConfigJson: typeof raw.languageProfileConfigJson === 'string' && raw.languageProfileConfigJson ? raw.languageProfileConfigJson : defaults.languageProfileConfigJson,
    textNormalizationEnabled: typeof raw.textNormalizationEnabled === 'boolean' ? raw.textNormalizationEnabled : defaults.textNormalizationEnabled,
    textNormalizationRulesJson: typeof raw.textNormalizationRulesJson === 'string' ? raw.textNormalizationRulesJson : defaults.textNormalizationRulesJson,
    correctionAdditionalInstructions: typeof raw.correctionAdditionalInstructions === 'string' ? raw.correctionAdditionalInstructions : defaults.correctionAdditionalInstructions,
    correctionFewShotJson: typeof raw.correctionFewShotJson === 'string' ? raw.correctionFewShotJson : defaults.correctionFewShotJson,
    translationAdditionalInstructions: typeof raw.translationAdditionalInstructions === 'string' ? raw.translationAdditionalInstructions : defaults.translationAdditionalInstructions,
    translationFewShotJson: typeof raw.translationFewShotJson === 'string' ? raw.translationFewShotJson : defaults.translationFewShotJson,
    compressPromptOverride: typeof raw.compressPromptOverride === 'string' ? raw.compressPromptOverride : '',
    expandPromptOverride: typeof raw.expandPromptOverride === 'string' ? raw.expandPromptOverride : '',
    coverageRepairEnabled: typeof raw.coverageRepairEnabled === 'boolean' ? raw.coverageRepairEnabled : defaults.coverageRepairEnabled,
    coverageRepairModel: typeof raw.coverageRepairModel === 'string' ? raw.coverageRepairModel : defaults.coverageRepairModel,
    coverageRepairEffort: normalizeReasoningEffort(raw.coverageRepairEffort, defaults.coverageRepairEffort),
    generalRepairEnabled: typeof raw.generalRepairEnabled === 'boolean' ? raw.generalRepairEnabled : defaults.generalRepairEnabled,
    generalRepairModel: typeof raw.generalRepairModel === 'string' ? raw.generalRepairModel : defaults.generalRepairModel,
    generalRepairMaxEffort: normalizeMaxEffort(raw.generalRepairMaxEffort, defaults.generalRepairMaxEffort),
    debugModeEnabled: typeof raw.debugModeEnabled === 'boolean' ? raw.debugModeEnabled : defaults.debugModeEnabled,
    correctionDebugEmbedding: typeof raw.correctionDebugEmbedding === 'boolean' ? raw.correctionDebugEmbedding : defaults.correctionDebugEmbedding,
    workLogDir: typeof raw.workLogDir === 'string' ? raw.workLogDir : '',
  }
}

export function loadAdminSettings(): AdminSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return normalizeAdminSettings(JSON.parse(raw))

    return getDefaultAdminSettings()
  } catch {
    return getDefaultAdminSettings()
  }
}

export function saveAdminSettings(settings: AdminSettings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(normalizeAdminSettings(settings)))
}

function stripUnshareableAdminSettings(settings: AdminSettings): Partial<AdminSettings> {
  const shared: Partial<AdminSettings> = { ...settings }
  for (const field of SHARED_SETTINGS_EXCLUDED_FIELDS) {
    delete shared[field]
  }
  return shared
}

export function createSharedAdminSettingsExport(settings: AdminSettings): SharedAdminSettingsExport {
  return {
    version: SHARED_SETTINGS_VERSION,
    exportedAt: new Date().toISOString(),
    kind: 'subtitle-editor-admin-settings',
    excludedFields: [...SHARED_SETTINGS_EXCLUDED_FIELDS],
    settings: stripUnshareableAdminSettings(normalizeAdminSettings(settings)),
  }
}

export function parseSharedAdminSettingsExport(text: string): Partial<AdminSettings> {
  const parsed = JSON.parse(text) as unknown
  const rawSettings = (
    typeof parsed === 'object'
    && parsed !== null
    && 'settings' in parsed
    && typeof (parsed as { settings?: unknown }).settings === 'object'
    && (parsed as { settings?: unknown }).settings !== null
  )
    ? (parsed as { settings: unknown }).settings
    : parsed

  const normalized = normalizeAdminSettings(rawSettings)
  return stripUnshareableAdminSettings(normalized)
}
