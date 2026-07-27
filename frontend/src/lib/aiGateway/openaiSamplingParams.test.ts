import { describe, expect, it } from 'vitest'
import { BUILTIN_API_COMPATIBILITY_PROFILES } from './apiCompatibilityProfile'
import { shouldSuppressOpenAiSamplingParams, stripOpenAiSamplingParams } from './openaiSamplingParams'

describe('shouldSuppressOpenAiSamplingParams', () => {
  it('returns true for OpenAI builtin profile + gpt-5 prefixed models', () => {
    expect(shouldSuppressOpenAiSamplingParams(BUILTIN_API_COMPATIBILITY_PROFILES.openai, 'gpt-5.4-mini')).toBe(true)
    expect(shouldSuppressOpenAiSamplingParams(BUILTIN_API_COMPATIBILITY_PROFILES.openai, 'gpt-5')).toBe(true)
    expect(shouldSuppressOpenAiSamplingParams(BUILTIN_API_COMPATIBILITY_PROFILES.openai, 'GPT-5.4-Mini')).toBe(true)
  })

  it('returns true for OpenAI builtin profile + o3 / o4 prefixed models', () => {
    expect(shouldSuppressOpenAiSamplingParams(BUILTIN_API_COMPATIBILITY_PROFILES.openai, 'o3-mini')).toBe(true)
    expect(shouldSuppressOpenAiSamplingParams(BUILTIN_API_COMPATIBILITY_PROFILES.openai, 'o4-mini')).toBe(true)
  })

  it('returns false for non-reasoning OpenAI models (adaptive learning handles these instead)', () => {
    expect(shouldSuppressOpenAiSamplingParams(BUILTIN_API_COMPATIBILITY_PROFILES.openai, 'gpt-4.1-mini')).toBe(false)
    expect(shouldSuppressOpenAiSamplingParams(BUILTIN_API_COMPATIBILITY_PROFILES.openai, 'gpt-4o-mini')).toBe(false)
  })

  it('returns false for LM Studio / Ollama / Gemini profiles even for a gpt-5-named model (local determinism must be preserved)', () => {
    expect(shouldSuppressOpenAiSamplingParams(BUILTIN_API_COMPATIBILITY_PROFILES.lmStudio, 'gpt-5.4-mini')).toBe(false)
    expect(shouldSuppressOpenAiSamplingParams(BUILTIN_API_COMPATIBILITY_PROFILES.ollama, 'gpt-5.4-mini')).toBe(false)
    expect(shouldSuppressOpenAiSamplingParams(BUILTIN_API_COMPATIBILITY_PROFILES.geminiOpenAiCompatible, 'gpt-5.4-mini')).toBe(false)
  })

  it('returns false for a user-defined custom profile even if its id happens to resemble openai', () => {
    expect(shouldSuppressOpenAiSamplingParams({ id: 'user:api:openai' }, 'gpt-5.4-mini')).toBe(false)
  })

  it('returns false for an empty model string', () => {
    expect(shouldSuppressOpenAiSamplingParams(BUILTIN_API_COMPATIBILITY_PROFILES.openai, '')).toBe(false)
  })
})

describe('stripOpenAiSamplingParams', () => {
  it('removes temperature and top_p from the body', () => {
    const body = { model: 'gpt-5.4-mini', temperature: 0, top_p: 0.9, messages: [] }
    const stripped = stripOpenAiSamplingParams(body)
    expect(stripped).not.toHaveProperty('temperature')
    expect(stripped).not.toHaveProperty('top_p')
    expect(stripped.model).toBe('gpt-5.4-mini')
  })

  it('returns the same reference (no unnecessary copy) when neither param is present', () => {
    const body = { model: 'gpt-5.4-mini' }
    expect(stripOpenAiSamplingParams(body)).toBe(body)
  })

  it('does not mutate the original body (immutability)', () => {
    const body = { model: 'gpt-5.4-mini', temperature: 0.2 }
    const stripped = stripOpenAiSamplingParams(body)
    expect(body).toHaveProperty('temperature', 0.2)
    expect(stripped).not.toBe(body)
  })
})
