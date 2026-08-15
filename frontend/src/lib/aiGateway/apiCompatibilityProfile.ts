import type { AdminSettings } from '@/types/adminSettings'
import { resolveAiProvider } from '@/lib/pipeline/aiProvider'
import { resolveModelProfile } from '@/lib/pipeline/modelProfile'

/** 組み込みプリセット（BUILTIN_API_COMPATIBILITY_PROFILES）が使う2つの名前。この2つ以外は増やさない。 */
export type BuiltinTokenLimitParam = 'max_tokens' | 'max_completion_tokens'
/**
 * ユーザー定義プロファイル（preset:'user'）では、上記2つ以外の任意の文字列も許容する
 * （resolveExplicitBuiltinApiCompatibilityProfile 参照。ユーザーが実際に運用する
 * OpenAI 互換サーバーの中には、この2つ以外のパラメータ名でトークン上限を受け取るものがある）。
 * `BuiltinTokenLimitParam | (string & {})` は「string に潰さず、'max_tokens' /
 * 'max_completion_tokens' のリテラル型を保ったまま任意の文字列も受け付ける」ための定型パターン。
 * 組み込みプリセット側の定義（BUILTIN_API_COMPATIBILITY_PROFILES）はこの型でも
 * 引き続き 'max_tokens' / 'max_completion_tokens' のリテラルとして型チェックされる
 * （satisfies により object literal のリテラル型が保持されるため）。
 * 実行時の妥当性検証は validateCustomTokenLimitParam が担う（正規化時は必ずそちらを通すこと。
 * この型だけでは任意の文字列を許してしまい、body の他フィールドとの衝突等を防げない）。
 */
export type TokenLimitParam = BuiltinTokenLimitParam | (string & {})
export type JsonResponseFormatMode = 'json_object' | 'json_schema' | 'text' | 'omit'

export interface RequestDialect {
  chat: {
    endpoint: string
    tokenLimitParam: TokenLimitParam
    responseFormat: JsonResponseFormatMode
  }
  embeddings: {
    endpoint: string
  }
  vision: {
    endpoint: string
    supportsDataUrl: boolean
    supportsRemoteUrl: boolean
  }
}

export interface ApiCompatibilityProfile {
  id: string
  label: string
  schemaVersion: 1
  profileVersion: string
  origin: 'builtin' | 'user' | 'imported'
  requestDialect: RequestDialect
}

/**
 * response_format.json_schema (Structured Outputs) を組み立てるための入力。
 * strict:true 前提のため、schema 側は additionalProperties:false / 全フィールド required を
 * 呼出元で徹底しておくこと（gateway 側では検証しない）。
 */
export interface JsonSchemaSpec {
  /** response_format.json_schema.name に入る識別子 */
  name: string
  /** JSON Schema 本体（strict:true 前提で additionalProperties:false / 全フィールド required にしておくこと） */
  schema: Record<string, unknown>
}

export interface AiGatewayProfileSnapshot {
  apiCompatibilityProfile: {
    id: string
    label: string
    profileVersion: string
    origin: ApiCompatibilityProfile['origin']
  }
  requestDialect: RequestDialect
  models: {
    chatText: {
      model: string
      profileId?: string
      profileLabel?: string
      contextLength?: number
      maxOutputTokens?: number
      reasoningOutputStyle?: string
    }
    chatVision: {
      model: string
      profileId?: string
      profileLabel?: string
      contextLength?: number
      maxOutputTokens?: number
      reasoningOutputStyle?: string
    }
    embedding: {
      model: string
      profileId?: string
      profileLabel?: string
      contextLength?: number
      maxOutputTokens?: number
      reasoningOutputStyle?: string
    }
  }
}

export const BUILTIN_API_COMPATIBILITY_PROFILES = {
  openai: {
    id: 'builtin:api:openai',
    label: 'OpenAI API',
    schemaVersion: 1,
    profileVersion: '2026.06.08',
    origin: 'builtin',
    requestDialect: {
      chat: {
        endpoint: '/chat/completions',
        tokenLimitParam: 'max_completion_tokens',
        responseFormat: 'json_object',
      },
      embeddings: { endpoint: '/embeddings' },
      vision: {
        endpoint: '/chat/completions',
        supportsDataUrl: true,
        supportsRemoteUrl: true,
      },
    },
  },
  lmStudio: {
    id: 'builtin:api:lmstudio',
    label: 'LM Studio OpenAI Compatible',
    schemaVersion: 1,
    profileVersion: '2026.07.26',
    origin: 'builtin',
    requestDialect: {
      chat: {
        endpoint: '/chat/completions',
        tokenLimitParam: 'max_tokens',
        responseFormat: 'json_schema',
      },
      embeddings: { endpoint: '/embeddings' },
      vision: {
        endpoint: '/chat/completions',
        supportsDataUrl: true,
        supportsRemoteUrl: true,
      },
    },
  },
  ollama: {
    id: 'builtin:api:ollama',
    label: 'Ollama OpenAI Compatible',
    schemaVersion: 1,
    profileVersion: '2026.07.26',
    origin: 'builtin',
    requestDialect: {
      chat: {
        endpoint: '/chat/completions',
        tokenLimitParam: 'max_tokens',
        responseFormat: 'json_schema',
      },
      embeddings: { endpoint: '/embeddings' },
      vision: {
        endpoint: '/chat/completions',
        supportsDataUrl: true,
        supportsRemoteUrl: true,
      },
    },
  },
  geminiOpenAiCompatible: {
    id: 'builtin:api:gemini-openai-compatible',
    label: 'Gemini OpenAI Compatible',
    schemaVersion: 1,
    profileVersion: '2026.06.08',
    origin: 'builtin',
    requestDialect: {
      chat: {
        endpoint: '/chat/completions',
        tokenLimitParam: 'max_tokens',
        responseFormat: 'json_object',
      },
      embeddings: { endpoint: '/embeddings' },
      vision: {
        endpoint: '/chat/completions',
        supportsDataUrl: true,
        supportsRemoteUrl: true,
      },
    },
  },
} satisfies Record<string, ApiCompatibilityProfile>

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * ユーザー定義プロファイルの requestDialect.chat.tokenLimitParam が実際に
 * body へ設定して問題ない文字列かどうかを検証する。
 * ここを通さずに任意の文字列を受け付けると、以下のいずれかで壊れる:
 *   - JSON のキーとして不適切（空文字・前後空白・__proto__ 等）だと、
 *     applyChatRequestDialect の `{ ...body, [tokenLimitParam]: value }` で
 *     意図しない挙動（プロトタイプ汚染・キー消失）を引き起こしうる
 *   - body の他フィールド名（RESERVED_CHAT_BODY_FIELD_NAMES）と衝突すると、
 *     そのフィールドの値をトークン上限の数値で上書きしてしまい本体を壊す
 */
function validateCustomTokenLimitParam(value: unknown): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof value !== 'string') {
    return { ok: false, error: `requestDialect.chat.tokenLimitParam must be a string (got ${typeof value}).` }
  }
  if (!value.trim()) {
    return { ok: false, error: 'requestDialect.chat.tokenLimitParam must not be empty or whitespace-only.' }
  }
  if (value.trim() !== value) {
    return { ok: false, error: 'requestDialect.chat.tokenLimitParam must not have leading or trailing whitespace.' }
  }
  // JSON のキーとして安全に body へ設定できる形（英数字・アンダースコア・ハイフン、数字始まり不可）
  // に制限する。OpenAI 互換サーバーのパラメータ名は概ねこの形（snake_case / kebab-case）に収まる。
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(value)) {
    return {
      ok: false,
      error: `requestDialect.chat.tokenLimitParam "${value}" is not a valid parameter name. Use letters, digits, underscore, or hyphen, and do not start with a digit.`,
    }
  }
  // __proto__ / constructor / prototype はオブジェクトの組み込みプロパティ名と衝突し、
  // `{ ...body, [tokenLimitParam]: value }` のスプレッド代入でプロトタイプ汚染や
  // 予期しない挙動を引き起こしうるため、正規表現チェックを通っても個別に拒否する。
  if (DANGEROUS_OBJECT_KEY_NAMES.has(value)) {
    return { ok: false, error: `requestDialect.chat.tokenLimitParam "${value}" is a reserved JavaScript object property name and cannot be used.` }
  }
  if (RESERVED_CHAT_BODY_FIELD_NAMES.has(value)) {
    return {
      ok: false,
      error: `requestDialect.chat.tokenLimitParam "${value}" collides with a request body field this app already sets (${[...RESERVED_CHAT_BODY_FIELD_NAMES].sort().join(', ')}). Choose a different name.`,
    }
  }
  return { ok: true, value }
}

/**
 * chatText.ts の buildChatTextBody / chatVision.ts / modelProfile.ts の applySampling・
 * applyReasoningEnable が実際に body へ設定するフィールド名（'model' / 'messages' は options から
 * 直接オブジェクトリテラルで設定されるが同じ理由で衝突対象）。
 * ここに無いフィールドを新たに body へ設定するようになった場合はこのセットも更新すること。
 * 'stream' はこのアプリでは現状送っていないが、Chat Completions API の標準フィールド名であり
 * 将来の衝突を避けるため予約しておく。
 */
const RESERVED_CHAT_BODY_FIELD_NAMES = new Set<string>([
  'model',
  'messages',
  'temperature',
  'reasoning_effort',
  'response_format',
  'top_p',
  'top_k',
  'min_p',
  'presence_penalty',
  'repetition_penalty',
  'chat_template_kwargs',
  'stream',
])

const DANGEROUS_OBJECT_KEY_NAMES = new Set<string>(['__proto__', 'constructor', 'prototype'])

type NormalizeResult<T> = { ok: true; value: T } | { ok: false; error: string }

function normalizeRequestDialect(value: unknown): NormalizeResult<RequestDialect> {
  if (!isObject(value)) return { ok: false, error: 'requestDialect must be an object.' }
  if (!isObject(value.chat)) return { ok: false, error: 'requestDialect.chat must be an object.' }
  if (!isObject(value.embeddings)) return { ok: false, error: 'requestDialect.embeddings must be an object.' }
  if (!isObject(value.vision)) return { ok: false, error: 'requestDialect.vision must be an object.' }

  const tokenLimitParamResult = validateCustomTokenLimitParam(value.chat.tokenLimitParam)
  if (!tokenLimitParamResult.ok) return { ok: false, error: tokenLimitParamResult.error }

  const responseFormat = value.chat.responseFormat
  if (responseFormat !== 'json_object' && responseFormat !== 'json_schema' && responseFormat !== 'text' && responseFormat !== 'omit') {
    return {
      ok: false,
      error: `requestDialect.chat.responseFormat must be one of "json_object" | "json_schema" | "text" | "omit" (got ${JSON.stringify(responseFormat)}).`,
    }
  }

  return {
    ok: true,
    value: {
      chat: {
        endpoint: typeof value.chat.endpoint === 'string' && value.chat.endpoint ? value.chat.endpoint : '/chat/completions',
        tokenLimitParam: tokenLimitParamResult.value,
        responseFormat,
      },
      embeddings: {
        endpoint: typeof value.embeddings.endpoint === 'string' && value.embeddings.endpoint ? value.embeddings.endpoint : '/embeddings',
      },
      vision: {
        endpoint: typeof value.vision.endpoint === 'string' && value.vision.endpoint ? value.vision.endpoint : '/chat/completions',
        supportsDataUrl: typeof value.vision.supportsDataUrl === 'boolean' ? value.vision.supportsDataUrl : true,
        supportsRemoteUrl: typeof value.vision.supportsRemoteUrl === 'boolean' ? value.vision.supportsRemoteUrl : false,
      },
    },
  }
}

function normalizeApiCompatibilityProfileWithReason(value: unknown): NormalizeResult<ApiCompatibilityProfile> {
  if (!isObject(value)) return { ok: false, error: 'API Compatibility Profile JSON must be an object.' }
  const dialectResult = normalizeRequestDialect(value.requestDialect)
  if (!dialectResult.ok) return { ok: false, error: dialectResult.error }
  return {
    ok: true,
    value: {
      id: typeof value.id === 'string' && value.id ? value.id : 'user:api:unnamed',
      label: typeof value.label === 'string' && value.label ? value.label : 'User API Compatibility Profile',
      schemaVersion: 1,
      profileVersion: typeof value.profileVersion === 'string' && value.profileVersion ? value.profileVersion : 'user',
      origin: value.origin === 'imported' ? 'imported' : 'user',
      requestDialect: dialectResult.value,
    },
  }
}

export function normalizeApiCompatibilityProfile(value: unknown): ApiCompatibilityProfile | undefined {
  const result = normalizeApiCompatibilityProfileWithReason(value)
  return result.ok ? result.value : undefined
}

export interface ApiCompatibilityProfileValidationResult {
  ok: boolean
  profile?: ApiCompatibilityProfile
  error?: string
}

export function validateApiCompatibilityProfileJson(text: string): ApiCompatibilityProfileValidationResult {
  if (!text.trim()) return { ok: false, error: 'API Compatibility Profile JSON is empty.' }
  try {
    const parsed = JSON.parse(text) as unknown
    const result = normalizeApiCompatibilityProfileWithReason(parsed)
    if (!result.ok) return { ok: false, error: result.error }
    return { ok: true, profile: result.value }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export function createUserApiCompatibilityProfileFromBuiltin(profile: ApiCompatibilityProfile): ApiCompatibilityProfile {
  const baseId = profile.id.replace(/^builtin:api:/, '').replace(/^user:api:/, '')
  return {
    ...profile,
    id: `user:api:${baseId}`,
    label: `${profile.label} User Profile`,
    origin: 'user',
    profileVersion: `${profile.profileVersion}-user`,
    requestDialect: {
      chat: { ...profile.requestDialect.chat },
      embeddings: { ...profile.requestDialect.embeddings },
      vision: { ...profile.requestDialect.vision },
    },
  }
}

export function formatApiCompatibilityProfileJson(profile: ApiCompatibilityProfile): string {
  return JSON.stringify(profile, null, 2)
}

function resolveExplicitBuiltinApiCompatibilityProfile(preset: AdminSettings['apiCompatibilityProfilePreset']): ApiCompatibilityProfile | undefined {
  if (preset === 'openai') return BUILTIN_API_COMPATIBILITY_PROFILES.openai
  if (preset === 'lmstudio') return BUILTIN_API_COMPATIBILITY_PROFILES.lmStudio
  if (preset === 'ollama') return BUILTIN_API_COMPATIBILITY_PROFILES.ollama
  if (preset === 'gemini_openai_compatible') return BUILTIN_API_COMPATIBILITY_PROFILES.geminiOpenAiCompatible
  return undefined
}

export function resolveApiCompatibilityProfile(
  settings: Pick<AdminSettings,
    | 'translationProvider'
    | 'openaiCompatibleBaseUrl'
    | 'apiCompatibilityProfilePreset'
    | 'apiCompatibilityProfileJson'
  >,
): ApiCompatibilityProfile {
  if (settings.apiCompatibilityProfilePreset === 'user') {
    try {
      const profile = normalizeApiCompatibilityProfile(JSON.parse(settings.apiCompatibilityProfileJson))
      if (profile) return profile
    } catch {
      // handled below
    }
    throw new Error('Invalid API Compatibility Profile JSON')
  }

  const explicit = resolveExplicitBuiltinApiCompatibilityProfile(settings.apiCompatibilityProfilePreset)
  if (explicit) return explicit

  const provider = resolveAiProvider(settings)
  if (provider === 'local_openai') {
    return settings.openaiCompatibleBaseUrl.includes('11434')
      ? BUILTIN_API_COMPATIBILITY_PROFILES.ollama
      : BUILTIN_API_COMPATIBILITY_PROFILES.lmStudio
  }
  if (provider === 'gemini') return BUILTIN_API_COMPATIBILITY_PROFILES.geminiOpenAiCompatible
  return BUILTIN_API_COMPATIBILITY_PROFILES.openai
}

export function applyChatRequestDialect(
  body: Record<string, unknown>,
  profile: ApiCompatibilityProfile,
  options: { maxOutputTokens?: number },
): Record<string, unknown> {
  if (typeof options.maxOutputTokens !== 'number') return body
  return {
    ...body,
    [profile.requestDialect.chat.tokenLimitParam]: options.maxOutputTokens,
  }
}

/**
 * プロファイルの responseFormat モードに応じて実際に送る response_format を解決する。
 *
 * - json_schema かつ jsonSchema 指定あり → Structured Outputs 形式（strict:true 固定）
 * - json_schema かつ jsonSchema 指定なし → スキーマなしで json_schema は送れないため text にフォールバック
 *   （変更前の LM Studio / Ollama プロファイルの既定挙動を維持する）
 * - json_object / text → { type: mode } をそのまま返す。jsonSchema が渡されていても無視する
 *   （OpenAI / Gemini OpenAI Compatible の既存挙動を一切変えないため）
 * - omit → undefined
 */
export function resolveChatResponseFormatForDialect(
  profile: ApiCompatibilityProfile,
  jsonSchema?: JsonSchemaSpec,
): Record<string, unknown> | undefined {
  const mode = profile.requestDialect.chat.responseFormat
  if (mode === 'json_schema') {
    if (jsonSchema) {
      return {
        type: 'json_schema',
        json_schema: {
          name: jsonSchema.name,
          strict: true,
          schema: jsonSchema.schema,
        },
      }
    }
    return { type: 'text' }
  }
  if (mode === 'json_object' || mode === 'text') return { type: mode }
  return undefined
}

function summarizeResolvedModelProfile(
  settings: AdminSettings,
  model: string,
  capability: 'chatText' | 'chatVision' | 'embedding',
): AiGatewayProfileSnapshot['models']['chatText'] {
  const profile = resolveModelProfile(settings, model, capability)
  return {
    model,
    profileId: profile?.id,
    profileLabel: profile?.label,
    contextLength: profile?.contextLength,
    maxOutputTokens: profile?.maxOutputTokens,
    reasoningOutputStyle: profile?.reasoning.output.style,
  }
}

export function buildAiGatewayProfileSnapshot(settings: AdminSettings): AiGatewayProfileSnapshot {
  const apiProfile = resolveApiCompatibilityProfile(settings)
  return {
    apiCompatibilityProfile: {
      id: apiProfile.id,
      label: apiProfile.label,
      profileVersion: apiProfile.profileVersion,
      origin: apiProfile.origin,
    },
    requestDialect: apiProfile.requestDialect,
    models: {
      chatText: summarizeResolvedModelProfile(settings, settings.translationModel, 'chatText'),
      chatVision: summarizeResolvedModelProfile(settings, settings.pdfExtractionVisionModel, 'chatVision'),
      embedding: summarizeResolvedModelProfile(settings, settings.embeddingModel, 'embedding'),
    },
  }
}
