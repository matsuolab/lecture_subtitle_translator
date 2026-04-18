import type { AdminSettings, TranslationProvider } from '@/types/adminSettings'
import { setSecret, getSecret } from './keychain'

const STORAGE_KEY = 'subtitle-editor.admin-settings.v2'
const ENV_PIPELINE_API_URL = (import.meta.env.VITE_PIPELINE_API_URL as string | undefined)?.replace(/\/$/, '') ?? ''
const ENV_HF_TOKEN = (import.meta.env.VITE_HF_TOKEN as string | undefined) ?? ''

const DEFAULT_TRANSLATION_PROVIDER: TranslationProvider = 'openai'

/**
 * keychain に保存するセンシティブフィールドと keychain アカウント名のマッピング。
 * localStorage には空文字列として保存し、実値は keychain にのみ置く。
 */
const SENSITIVE_ACCOUNT_MAP: Partial<Record<keyof AdminSettings, string>> = {
  openaiApiKey:  'openai_api_key',
  geminiApiKey:  'gemini_api_key',
  deeplApiKey:   'deepl_api_key',
  hfToken:       'hf_token',
  whisperxApiKey: 'whisperx_api_key',
}

export function getDefaultAdminSettings(): AdminSettings {
  return {
    pipelineApiUrl: ENV_PIPELINE_API_URL,
    hfToken: ENV_HF_TOKEN,
    openaiApiKey: '',
    geminiApiKey: '',
    deeplApiKey: '',
    openaiCompatibleBaseUrl: '',
    translationProvider: DEFAULT_TRANSLATION_PROVIDER,
    whisperxUrl: '',
    whisperxApiKey: '',
    whisperxLanguage: 'ja',
    correctionModel: 'gpt-4.1-nano',
    translationModel: 'gpt-4.1-mini',
    embeddingModel: 'text-embedding-3-small',
    logRetentionCount: null,
    enMaxCharsPerLine: 42,
    enMaxLines: 2,
    enMaxTotalChars: 84,
    enMaxCps: 17.0,
    subtitleMinDurationSec: 0.833,
    subtitleMaxDurationSec: 7.0,
    mergeMinJaChars: 8,
    qualityCorrectionThreshold: 0.15,
    qualityTranslationThreshold: 0.25,
  }
}

function normalizeTranslationProvider(value: unknown): TranslationProvider {
  return value === 'openai' || value === 'gemini' || value === 'deepl' || value === 'local'
    ? value
    : DEFAULT_TRANSLATION_PROVIDER
}

function normalizePositiveNumber(value: unknown, defaultValue: number): number {
  return typeof value === 'number' && isFinite(value) && value > 0 ? value : defaultValue
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
    whisperxUrl: typeof raw.whisperxUrl === 'string' ? raw.whisperxUrl : '',
    whisperxApiKey: typeof raw.whisperxApiKey === 'string' ? raw.whisperxApiKey : '',
    whisperxLanguage: typeof raw.whisperxLanguage === 'string' ? raw.whisperxLanguage : 'ja',
    correctionModel: typeof raw.correctionModel === 'string' ? raw.correctionModel : defaults.correctionModel,
    translationModel: typeof raw.translationModel === 'string' ? raw.translationModel : defaults.translationModel,
    embeddingModel: typeof raw.embeddingModel === 'string' ? raw.embeddingModel : defaults.embeddingModel,
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
  }
}

/**
 * 非センシティブな設定を localStorage から同期的に読み込む。
 * センシティブフィールド（APIキー等）は空文字列を返す。
 * 実値は hydrateFromKeychain() で非同期に補完する。
 *
 * 旧バージョン（keychain 未対応）からの移行互換性のため、
 * localStorage にセンシティブ値が残っている場合もそのまま読み込む。
 * hydrateFromKeychain() 実行後の最初の saveAdminSettings() で
 * localStorage からセンシティブ値が除去される。
 */
export function loadAdminSettings(): AdminSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? normalizeAdminSettings(JSON.parse(raw)) : getDefaultAdminSettings()
  } catch {
    return getDefaultAdminSettings()
  }
}

/**
 * 非センシティブな設定を localStorage に保存する。
 * センシティブフィールドは空文字列として上書きし、localStorage から除去する。
 */
export function saveAdminSettings(settings: AdminSettings): void {
  const sanitized = { ...normalizeAdminSettings(settings) }
  for (const key of Object.keys(SENSITIVE_ACCOUNT_MAP) as (keyof AdminSettings)[]) {
    (sanitized as Record<string, unknown>)[key] = ''
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(sanitized))
}

/**
 * keychain からセンシティブ値を読み込み、adminSettings へのパッチを返す。
 * keychain にエントリがない（未設定 or 初回起動）場合はそのキーを含まない。
 * Tauri 外環境ではエラーを無視して空のパッチを返す。
 */
export async function hydrateFromKeychain(): Promise<Partial<AdminSettings>> {
  const patch: Partial<AdminSettings> = {}
  for (const [field, account] of Object.entries(SENSITIVE_ACCOUNT_MAP)) {
    const value = await getSecret(account).catch(() => null)
    if (typeof value === 'string' && value.length > 0) {
      (patch as unknown as Record<string, string>)[field] = value
    }
  }
  return patch
}

/**
 * センシティブ値を keychain に保存する。
 * 空文字列の場合もそのまま書き込む（フィールドのクリアに相当）。
 * Tauri 外環境ではエラーを無視する。
 */
export async function saveSecrets(settings: AdminSettings): Promise<void> {
  for (const [field, account] of Object.entries(SENSITIVE_ACCOUNT_MAP)) {
    const value = (settings as unknown as Record<string, string>)[field] ?? ''
    await setSecret(account, value).catch(() => {})
  }
}
