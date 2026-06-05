import { describe, expect, it } from 'vitest'
import { getDefaultAdminSettings } from '@/api/adminSettings'
import type { AdminSettings } from '@/types/adminSettings'
import type { TauriFetchOptions } from '@/lib/tauriFetch'
import { createAiGateway } from './index'

function settings(overrides: Partial<AdminSettings> = {}): AdminSettings {
  return {
    ...getDefaultAdminSettings(),
    ...overrides,
  }
}

describe('AI Gateway embeddings', () => {
  it('uses the same local OpenAI-compatible connection for embedding vectors', async () => {
    const calls: Array<{ url: string; init: TauriFetchOptions }> = []
    const gateway = createAiGateway(settings({
      translationProvider: 'local_openai',
      openaiCompatibleBaseUrl: 'http://127.0.0.1:1234/v1',
    }), {
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} })
        return new Response(JSON.stringify({
          data: [
            { embedding: [1, 0, 0] },
            { embedding: [0, 1, 0] },
          ],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      },
    })

    const vectors = await gateway.embeddings({
      model: 'text-embedding-3-small',
      input: ['before', 'after'],
    })

    expect(vectors).toEqual([[1, 0, 0], [0, 1, 0]])
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('http://127.0.0.1:1234/v1/embeddings')
    expect(calls[0].init.headers).toMatchObject({
      'Content-Type': 'application/json',
    })
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      model: 'text-embedding-3-small',
      input: ['before', 'after'],
    })
  })
})
