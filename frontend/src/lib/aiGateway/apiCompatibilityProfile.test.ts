import { describe, expect, it } from 'vitest'
import type { AdminSettings } from '@/types/adminSettings'
import { getDefaultAdminSettings } from '@/api/adminSettings'
import {
  BUILTIN_API_COMPATIBILITY_PROFILES,
  buildAiGatewayProfileSnapshot,
  createUserApiCompatibilityProfileFromBuiltin,
  formatApiCompatibilityProfileJson,
  resolveApiCompatibilityProfile,
  resolveChatResponseFormatForDialect,
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
    expect(snapshot.requestDialect.chat.responseFormat).toBe('json_schema')
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
    expect(copy.requestDialect.chat.responseFormat).toBe('json_schema')
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

describe('user-defined tokenLimitParam (implementation 4: arbitrary token limit parameter names)', () => {
  function userProfileJson(tokenLimitParam: unknown): string {
    return JSON.stringify({
      id: 'user:api:custom',
      label: 'Custom Server',
      schemaVersion: 1,
      profileVersion: 'user',
      origin: 'user',
      requestDialect: {
        chat: { endpoint: '/chat/completions', tokenLimitParam, responseFormat: 'json_object' },
        embeddings: { endpoint: '/embeddings' },
        vision: { endpoint: '/chat/completions', supportsDataUrl: true, supportsRemoteUrl: false },
      },
    })
  }

  it('accepts an arbitrary tokenLimitParam name that is not one of the two built-in names', () => {
    const result = validateApiCompatibilityProfileJson(userProfileJson('num_predict'))
    expect(result.ok).toBe(true)
    expect(result.profile?.requestDialect.chat.tokenLimitParam).toBe('num_predict')
  })

  it('rejects an empty or whitespace-only tokenLimitParam with an actionable reason', () => {
    const empty = validateApiCompatibilityProfileJson(userProfileJson(''))
    expect(empty.ok).toBe(false)
    expect(empty.error).toContain('tokenLimitParam')
    expect(empty.error).toContain('empty')

    const whitespace = validateApiCompatibilityProfileJson(userProfileJson('   '))
    expect(whitespace.ok).toBe(false)
    expect(whitespace.error).toContain('tokenLimitParam')
  })

  it('rejects a tokenLimitParam that collides with a request body field the app already sets', () => {
    for (const collidingName of ['model', 'messages', 'temperature', 'response_format', 'stream']) {
      const result = validateApiCompatibilityProfileJson(userProfileJson(collidingName))
      expect(result.ok).toBe(false)
      expect(result.error).toContain(collidingName)
      expect(result.error).toContain('collides')
    }
  })

  it('rejects a tokenLimitParam that is a dangerous JavaScript object property name', () => {
    for (const dangerous of ['__proto__', 'constructor', 'prototype']) {
      const result = validateApiCompatibilityProfileJson(userProfileJson(dangerous))
      expect(result.ok).toBe(false)
      expect(result.error).toContain(dangerous)
    }
  })

  it('rejects a non-string tokenLimitParam with an actionable reason', () => {
    const result = validateApiCompatibilityProfileJson(userProfileJson(123))
    expect(result.ok).toBe(false)
    expect(result.error).toContain('tokenLimitParam')
    expect(result.error).toContain('string')
  })

  it('still accepts the two built-in names for a user-defined profile', () => {
    expect(validateApiCompatibilityProfileJson(userProfileJson('max_tokens')).ok).toBe(true)
    expect(validateApiCompatibilityProfileJson(userProfileJson('max_completion_tokens')).ok).toBe(true)
  })
})

describe('resolveChatResponseFormatForDialect', () => {
  it('builds a Structured Outputs response_format for a json_schema profile with a schema', () => {
    const format = resolveChatResponseFormatForDialect(BUILTIN_API_COMPATIBILITY_PROFILES.lmStudio, {
      name: 'glossary_entries',
      schema: { type: 'object', properties: { term: { type: 'string' } }, required: ['term'], additionalProperties: false },
    })

    expect(format).toEqual({
      type: 'json_schema',
      json_schema: {
        name: 'glossary_entries',
        strict: true,
        schema: { type: 'object', properties: { term: { type: 'string' } }, required: ['term'], additionalProperties: false },
      },
    })
  })

  it('falls back to text for a json_schema profile when no schema is given', () => {
    const format = resolveChatResponseFormatForDialect(BUILTIN_API_COMPATIBILITY_PROFILES.lmStudio)
    expect(format).toEqual({ type: 'text' })
  })

  it('ignores a supplied schema for a json_object profile and keeps json_object', () => {
    const format = resolveChatResponseFormatForDialect(BUILTIN_API_COMPATIBILITY_PROFILES.openai, {
      name: 'ignored',
      schema: { type: 'object' },
    })
    expect(format).toEqual({ type: 'json_object' })
  })
})
