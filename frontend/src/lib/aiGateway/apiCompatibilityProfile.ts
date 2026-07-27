import type { AdminSettings } from '@/types/adminSettings'
import { resolveAiProvider } from '@/lib/pipeline/aiProvider'
import { resolveModelProfile } from '@/lib/pipeline/modelProfile'

export type TokenLimitParam = 'max_tokens' | 'max_completion_tokens'
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

function normalizeRequestDialect(value: unknown): RequestDialect | undefined {
  if (!isObject(value) || !isObject(value.chat) || !isObject(value.embeddings) || !isObject(value.vision)) return undefined
  const tokenLimitParam = value.chat.tokenLimitParam
  const responseFormat = value.chat.responseFormat
  if (tokenLimitParam !== 'max_tokens' && tokenLimitParam !== 'max_completion_tokens') return undefined
  if (responseFormat !== 'json_object' && responseFormat !== 'json_schema' && responseFormat !== 'text' && responseFormat !== 'omit') return undefined
  return {
    chat: {
      endpoint: typeof value.chat.endpoint === 'string' && value.chat.endpoint ? value.chat.endpoint : '/chat/completions',
      tokenLimitParam,
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
  }
}

export function normalizeApiCompatibilityProfile(value: unknown): ApiCompatibilityProfile | undefined {
  if (!isObject(value)) return undefined
  const requestDialect = normalizeRequestDialect(value.requestDialect)
  if (!requestDialect) return undefined
  return {
    id: typeof value.id === 'string' && value.id ? value.id : 'user:api:unnamed',
    label: typeof value.label === 'string' && value.label ? value.label : 'User API Compatibility Profile',
    schemaVersion: 1,
    profileVersion: typeof value.profileVersion === 'string' && value.profileVersion ? value.profileVersion : 'user',
    origin: value.origin === 'imported' ? 'imported' : 'user',
    requestDialect,
  }
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
    const profile = normalizeApiCompatibilityProfile(parsed)
    if (!profile) {
      return {
        ok: false,
        error: 'requestDialect.chat / embeddings / vision and valid tokenLimitParam / responseFormat are required.',
      }
    }
    return { ok: true, profile }
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
