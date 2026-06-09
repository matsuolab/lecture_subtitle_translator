import { describe, expect, it } from 'vitest'
import type { AdminSettings } from '@/types/adminSettings'
import { getDefaultAdminSettings } from '@/api/adminSettings'
import {
  BUILTIN_API_COMPATIBILITY_PROFILES,
  buildAiGatewayProfileSnapshot,
  createUserApiCompatibilityProfileFromBuiltin,
  formatApiCompatibilityProfileJson,
  resolveApiCompatibilityProfile,
  validateApiCompatibilityProfileJson,
} from './apiCompatibilityProfile'

function settings(overrides: Partial<AdminSettings> = {}): AdminSettings {
  return {
    ...getDefaultAdminSettings(),
    ...overrides,
  }
}

describe('buildAiGatewayProfileSnapshot', () => {
  it('records the resolved OpenAI request dialect without secrets', () => {
    const snapshot = buildAiGatewayProfileSnapshot(settings({
      translationProvider: 'openai',
      openaiApiKey: 'sk-secret',
      translationModel: 'gpt-5.4-mini',
      pdfExtractionVisionModel: 'gpt-5.4-mini',
      embeddingModel: 'text-embedding-3-small',
    }))

    expect(snapshot.apiCompatibilityProfile).toEqual({
      id: 'builtin:api:openai',
      label: 'OpenAI API',
      profileVersion: '2026.06.08',
      origin: 'builtin',
    })
    expect(snapshot.requestDialect.chat.tokenLimitParam).toBe('max_completion_tokens')
    expect(snapshot.requestDialect.chat.responseFormat).toBe('json_object')
    expect(JSON.stringify(snapshot)).not.toContain('sk-secret')
  })

  it('records the resolved local OpenAI-compatible request dialect', () => {
    const snapshot = buildAiGatewayProfileSnapshot(settings({
      translationProvider: 'local_openai',
      openaiCompatibleBaseUrl: 'http://127.0.0.1:1234/v1',
      translationModel: 'google/gemma-4-12b',
      pdfExtractionVisionModel: 'google/gemma-4-12b',
      embeddingModel: 'text-embedding-3-small',
    }))

    expect(snapshot.apiCompatibilityProfile.id).toBe('builtin:api:lmstudio')
    expect(snapshot.requestDialect.chat.tokenLimitParam).toBe('max_tokens')
    expect(snapshot.requestDialect.chat.responseFormat).toBe('text')
    expect(snapshot.models.chatText.profileId).toBe('gemma')
    expect(snapshot.models.chatVision.profileId).toBe('gemma')
  })

  it('uses a selected user API compatibility profile before provider auto inference', () => {
    const profile = resolveApiCompatibilityProfile(settings({
      translationProvider: 'openai',
      apiCompatibilityProfilePreset: 'user',
      apiCompatibilityProfileJson: JSON.stringify({
        id: 'user:api:text-only',
        label: 'Text Only Server',
        schemaVersion: 1,
        profileVersion: '2026.06.08-user',
        origin: 'user',
        requestDialect: {
          chat: {
            endpoint: '/chat/completions',
            tokenLimitParam: 'max_tokens',
            responseFormat: 'text',
          },
          embeddings: { endpoint: '/embeddings' },
          vision: {
            endpoint: '/chat/completions',
            supportsDataUrl: true,
            supportsRemoteUrl: false,
          },
        },
      }),
    }))

    expect(profile.id).toBe('user:api:text-only')
    expect(profile.requestDialect.chat.tokenLimitParam).toBe('max_tokens')
    expect(profile.requestDialect.chat.responseFormat).toBe('text')
  })

  it('creates an editable user JSON copy from a built-in profile', () => {
    const copy = createUserApiCompatibilityProfileFromBuiltin(BUILTIN_API_COMPATIBILITY_PROFILES.lmStudio)

    expect(copy.id).toBe('user:api:lmstudio')
    expect(copy.origin).toBe('user')
    expect(copy.requestDialect.chat.tokenLimitParam).toBe('max_tokens')
    expect(copy.requestDialect.chat.responseFormat).toBe('text')
    expect(formatApiCompatibilityProfileJson(copy)).toContain('"origin": "user"')
  })

  it('validates API compatibility profile JSON with actionable errors', () => {
    expect(validateApiCompatibilityProfileJson('').ok).toBe(false)
    expect(validateApiCompatibilityProfileJson('{"requestDialect":{}}').ok).toBe(false)

    const valid = validateApiCompatibilityProfileJson(formatApiCompatibilityProfileJson(
      createUserApiCompatibilityProfileFromBuiltin(BUILTIN_API_COMPATIBILITY_PROFILES.openai),
    ))

    expect(valid.ok).toBe(true)
    expect(valid.profile?.id).toBe('user:api:openai')
  })
})
