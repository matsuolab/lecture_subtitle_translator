import { describe, expect, it } from 'vitest'
import {
  createSharedAdminSettingsExport,
  getDefaultAdminSettings,
  normalizeAdminSettings,
  parseSharedAdminSettingsExport,
} from './adminSettings'

describe('shared admin settings', () => {
  it('excludes secrets and OpenAI compatible base URL by default', () => {
    const payload = createSharedAdminSettingsExport({
      ...getDefaultAdminSettings(),
      openaiApiKey: 'sk-secret',
      geminiApiKey: 'gemini-secret',
      serviceAuthToken: 'service-secret',
      hfToken: 'hf-secret',
      workLogDir: 'C:/private/worklogs',
      openaiCompatibleBaseUrl: 'http://127.0.0.1:1234/v1',
    })

    expect(payload.settings.openaiApiKey).toBeUndefined()
    expect(payload.settings.geminiApiKey).toBeUndefined()
    expect(payload.settings.serviceAuthToken).toBeUndefined()
    expect(payload.settings.hfToken).toBeUndefined()
    expect(payload.settings.workLogDir).toBeUndefined()
    expect(payload.settings.openaiCompatibleBaseUrl).toBeUndefined()
    expect(payload.excludedFields).toContain('openaiCompatibleBaseUrl')
  })

  it('can include OpenAI compatible base URL when the exporter chooses it', () => {
    const payload = createSharedAdminSettingsExport({
      ...getDefaultAdminSettings(),
      openaiCompatibleBaseUrl: 'http://127.0.0.1:1234/v1',
    }, { includeOpenAiCompatibleBaseUrl: true })

    expect(payload.settings.openaiCompatibleBaseUrl).toBe('http://127.0.0.1:1234/v1')
    expect(payload.excludedFields).not.toContain('openaiCompatibleBaseUrl')
  })

  it('imports an included OpenAI compatible base URL while still excluding secrets', () => {
    const payload = createSharedAdminSettingsExport({
      ...getDefaultAdminSettings(),
      openaiApiKey: 'sk-secret',
      openaiCompatibleBaseUrl: 'http://127.0.0.1:11434/v1',
    }, { includeOpenAiCompatibleBaseUrl: true })

    const patch = parseSharedAdminSettingsExport(JSON.stringify(payload))

    expect(patch.openaiApiKey).toBeUndefined()
    expect(patch.openaiCompatibleBaseUrl).toBe('http://127.0.0.1:11434/v1')
  })

  it('exports and imports API compatibility profile settings without secrets', () => {
    const apiCompatibilityProfileJson = JSON.stringify({
      id: 'user:api:my-server',
      label: 'My Server',
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
    })
    const payload = createSharedAdminSettingsExport({
      ...getDefaultAdminSettings(),
      openaiApiKey: 'sk-secret',
      apiCompatibilityProfilePreset: 'user',
      apiCompatibilityProfileJson,
    })

    expect(payload.settings.apiCompatibilityProfilePreset).toBe('user')
    expect(payload.settings.apiCompatibilityProfileJson).toBe(apiCompatibilityProfileJson)
    expect(JSON.stringify(payload)).not.toContain('sk-secret')

    const patch = parseSharedAdminSettingsExport(JSON.stringify(payload))
    expect(patch.apiCompatibilityProfilePreset).toBe('user')
    expect(patch.apiCompatibilityProfileJson).toBe(apiCompatibilityProfileJson)
    expect(patch.openaiApiKey).toBeUndefined()
  })
})

describe('admin settings model profile migration', () => {
  it('copies legacy single model profile settings into capability-specific profiles', () => {
    const normalized = normalizeAdminSettings({
      modelProfilePreset: 'qwen',
      modelProfileJson: '{"id":"legacy"}',
    })

    expect(normalized.chatTextProfilePreset).toBe('qwen')
    expect(normalized.chatVisionProfilePreset).toBe('qwen')
    expect(normalized.embeddingProfilePreset).toBe('qwen')
    expect(normalized.chatTextProfileJson).toBe('{"id":"legacy"}')
    expect(normalized.chatVisionProfileJson).toBe('{"id":"legacy"}')
    expect(normalized.embeddingProfileJson).toBe('{"id":"legacy"}')
  })

  it('drops removed model profile presets back to auto', () => {
    const normalized = normalizeAdminSettings({
      modelProfilePreset: 'openai',
      chatTextProfilePreset: 'deepseek',
      chatVisionProfilePreset: 'non_reasoning',
      embeddingProfilePreset: 'qwen',
    })

    expect(normalized.modelProfilePreset).toBe('auto')
    expect(normalized.chatTextProfilePreset).toBe('auto')
    expect(normalized.chatVisionProfilePreset).toBe('auto')
    expect(normalized.embeddingProfilePreset).toBe('qwen')
  })
})

describe('llmRequestTimeoutSec normalization', () => {
  it('defaults to 600 seconds when unset', () => {
    expect(getDefaultAdminSettings().llmRequestTimeoutSec).toBe(600)
    expect(normalizeAdminSettings({}).llmRequestTimeoutSec).toBe(600)
  })

  it('clamps values below the 30 second floor', () => {
    expect(normalizeAdminSettings({ llmRequestTimeoutSec: 0 }).llmRequestTimeoutSec).toBe(30)
    expect(normalizeAdminSettings({ llmRequestTimeoutSec: -100 }).llmRequestTimeoutSec).toBe(30)
  })

  it('clamps values above the 3600 second ceiling', () => {
    expect(normalizeAdminSettings({ llmRequestTimeoutSec: 999_999 }).llmRequestTimeoutSec).toBe(3600)
  })

  it('keeps in-range values as-is', () => {
    expect(normalizeAdminSettings({ llmRequestTimeoutSec: 120 }).llmRequestTimeoutSec).toBe(120)
  })

  it('falls back to the default for non-numeric input', () => {
    expect(normalizeAdminSettings({ llmRequestTimeoutSec: 'not-a-number' }).llmRequestTimeoutSec).toBe(600)
  })
})
