import { afterEach, describe, expect, it } from 'vitest'
import { getDefaultAdminSettings } from '@/api/adminSettings'
import type { AdminSettings } from '@/types/adminSettings'
import { createAiGatewayContext } from './connection'
import { resetLmStudioContextLengthCache, resolveLmStudioLoadedContextLength } from './lmStudioContextLength'

function settings(overrides: Partial<AdminSettings> = {}): AdminSettings {
  return {
    ...getDefaultAdminSettings(),
    translationProvider: 'local_openai',
    openaiCompatibleBaseUrl: 'http://127.0.0.1:1234/v1',
    ...overrides,
  }
}

afterEach(() => {
  resetLmStudioContextLengthCache()
})

describe('resolveLmStudioLoadedContextLength', () => {
  it('reads loaded_context_length from /api/v0/models for a loaded model', async () => {
    const calls: string[] = []
    const context = createAiGatewayContext(settings(), {
      fetch: async (url) => {
        calls.push(String(url))
        return new Response(JSON.stringify({
          data: [
            { id: 'google/gemma-4-12b', state: 'loaded', loaded_context_length: 32768, max_context_length: 131072 },
            { id: 'other-model', state: 'not-loaded', loaded_context_length: 8192 },
          ],
        }), { status: 200 })
      },
    })

    const result = await resolveLmStudioLoadedContextLength(context, 'google/gemma-4-12b')

    expect(result).toBe(32768)
    expect(calls).toEqual(['http://127.0.0.1:1234/api/v0/models'])
  })

  it('falls back to undefined when the requested model is not-loaded', async () => {
    const context = createAiGatewayContext(settings(), {
      fetch: async () => new Response(JSON.stringify({
        data: [{ id: 'google/gemma-4-12b', state: 'not-loaded', loaded_context_length: 8192 }],
      }), { status: 200 }),
    })

    const result = await resolveLmStudioLoadedContextLength(context, 'google/gemma-4-12b')

    expect(result).toBeUndefined()
  })

  it('falls back to undefined when the model is missing from the response', async () => {
    const context = createAiGatewayContext(settings(), {
      fetch: async () => new Response(JSON.stringify({ data: [] }), { status: 200 }),
    })

    const result = await resolveLmStudioLoadedContextLength(context, 'google/gemma-4-12b')

    expect(result).toBeUndefined()
  })

  it('does not throw and falls back to undefined when the endpoint does not exist (e.g. OpenAI)', async () => {
    const context = createAiGatewayContext(settings({
      translationProvider: 'openai',
      openaiApiKey: 'sk-test',
    }), {
      fetch: async () => new Response('not found', { status: 404 }),
    })

    await expect(resolveLmStudioLoadedContextLength(context, 'gpt-5.4-mini')).resolves.toBeUndefined()
  })

  it('does not throw and falls back to undefined on a network failure', async () => {
    const context = createAiGatewayContext(settings(), {
      fetch: async () => { throw new Error('network down') },
    })

    await expect(resolveLmStudioLoadedContextLength(context, 'google/gemma-4-12b')).resolves.toBeUndefined()
  })

  it('does not throw and falls back to undefined on a malformed JSON response', async () => {
    const context = createAiGatewayContext(settings(), {
      fetch: async () => new Response('not json', { status: 200 }),
    })

    await expect(resolveLmStudioLoadedContextLength(context, 'google/gemma-4-12b')).resolves.toBeUndefined()
  })

  it('skips the fetch entirely for non-LM-Studio profiles (e.g. OpenAI)', async () => {
    const calls: string[] = []
    const context = createAiGatewayContext(settings({
      translationProvider: 'openai',
      openaiApiKey: 'sk-test',
    }), {
      fetch: async (url) => {
        calls.push(String(url))
        return new Response('should not be called', { status: 500 })
      },
    })

    const result = await resolveLmStudioLoadedContextLength(context, 'gpt-5.4-mini')

    expect(result).toBeUndefined()
    expect(calls).toEqual([])
  })

  it('caches the result per model so a second call for the same model does not fetch again', async () => {
    let fetchCount = 0
    const context = createAiGatewayContext(settings(), {
      fetch: async () => {
        fetchCount += 1
        return new Response(JSON.stringify({
          data: [{ id: 'google/gemma-4-12b', state: 'loaded', loaded_context_length: 32768 }],
        }), { status: 200 })
      },
    })

    const first = await resolveLmStudioLoadedContextLength(context, 'google/gemma-4-12b')
    const second = await resolveLmStudioLoadedContextLength(context, 'google/gemma-4-12b')

    expect(first).toBe(32768)
    expect(second).toBe(32768)
    expect(fetchCount).toBe(1)
  })

  it('resetLmStudioContextLengthCache clears the cache so a subsequent call fetches again', async () => {
    let fetchCount = 0
    const context = createAiGatewayContext(settings(), {
      fetch: async () => {
        fetchCount += 1
        return new Response(JSON.stringify({
          data: [{ id: 'google/gemma-4-12b', state: 'loaded', loaded_context_length: 32768 }],
        }), { status: 200 })
      },
    })

    await resolveLmStudioLoadedContextLength(context, 'google/gemma-4-12b')
    resetLmStudioContextLengthCache()
    await resolveLmStudioLoadedContextLength(context, 'google/gemma-4-12b')

    expect(fetchCount).toBe(2)
  })
})
