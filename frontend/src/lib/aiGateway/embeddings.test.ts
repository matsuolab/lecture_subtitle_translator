import { afterEach, describe, expect, it } from 'vitest'
import { getDefaultAdminSettings } from '@/api/adminSettings'
import type { AdminSettings } from '@/types/adminSettings'
import type { TauriFetchOptions } from '@/lib/tauriFetch'
import { createAiGateway } from './index'
import { getLlmActivitySnapshot, resetLlmActivity } from './llmActivity'
import { getLlmConcurrencyState, resetLlmConcurrency, setLlmConcurrencyLimit } from './llmConcurrency'
import { getLlmErrorLog, resetLlmErrorLog } from './llmErrorLog'

function settings(overrides: Partial<AdminSettings> = {}): AdminSettings {
  return {
    ...getDefaultAdminSettings(),
    ...overrides,
  }
}

describe('AI Gateway embeddings', () => {
  afterEach(() => {
    resetLlmActivity()
  })

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

  describe('LLM activity tracking (inFlight must return to 0 on every exit path)', () => {
    it('clears inFlight after a successful response', async () => {
      resetLlmActivity()
      const gateway = createAiGateway(settings({
        translationProvider: 'local_openai',
        openaiCompatibleBaseUrl: 'http://127.0.0.1:1234/v1',
      }), {
        fetch: async () => new Response(JSON.stringify({
          data: [{ embedding: [1, 0, 0] }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
      })

      await gateway.embeddings({ model: 'text-embedding-3-small', input: ['x'] })

      expect(getLlmActivitySnapshot().inFlight).toBe(0)
      expect(getLlmActivitySnapshot().totalCompleted).toBe(1)
    })

    it('clears inFlight after an HTTP error response', async () => {
      resetLlmActivity()
      const gateway = createAiGateway(settings({
        translationProvider: 'local_openai',
        openaiCompatibleBaseUrl: 'http://127.0.0.1:1234/v1',
      }), {
        fetch: async () => new Response('server error', { status: 500 }),
      })

      const vectors = await gateway.embeddings({ model: 'text-embedding-3-small', input: ['x'] })

      expect(vectors).toBeNull()
      expect(getLlmActivitySnapshot().inFlight).toBe(0)
      expect(getLlmActivitySnapshot().totalCompleted).toBe(1)
    })

    it('clears inFlight when fetch throws (timeout or otherwise)', async () => {
      resetLlmActivity()
      const gateway = createAiGateway(settings({
        translationProvider: 'local_openai',
        openaiCompatibleBaseUrl: 'http://127.0.0.1:1234/v1',
      }), {
        fetch: async () => { throw new DOMException('The operation timed out.', 'TimeoutError') },
      })

      const vectors = await gateway.embeddings({ model: 'text-embedding-3-small', input: ['x'] })

      expect(vectors).toBeNull()
      expect(getLlmActivitySnapshot().inFlight).toBe(0)
      expect(getLlmActivitySnapshot().totalCompleted).toBe(1)
    })
  })

  describe('LLM concurrency slot release (deadlock regression: slot must free on every exit path)', () => {
    afterEach(() => {
      resetLlmConcurrency()
    })

    it('releases the concurrency slot after a successful response', async () => {
      resetLlmConcurrency()
      setLlmConcurrencyLimit(1)
      const gateway = createAiGateway(settings({
        translationProvider: 'local_openai',
        openaiCompatibleBaseUrl: 'http://127.0.0.1:1234/v1',
      }), {
        fetch: async () => new Response(JSON.stringify({
          data: [{ embedding: [1, 0, 0] }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
      })

      await gateway.embeddings({ model: 'text-embedding-3-small', input: ['x'] })

      expect(getLlmConcurrencyState().active).toBe(0)
    })

    it('releases the concurrency slot when fetch throws, unblocking the next queued call', async () => {
      resetLlmConcurrency()
      setLlmConcurrencyLimit(1)
      const gateway = createAiGateway(settings({
        translationProvider: 'local_openai',
        openaiCompatibleBaseUrl: 'http://127.0.0.1:1234/v1',
      }), {
        fetch: async () => { throw new Error('network down') },
      })

      await gateway.embeddings({ model: 'text-embedding-3-small', input: ['x'] })
      expect(getLlmConcurrencyState().active).toBe(0)

      // 解放漏れがあれば limit=1 のこの2回目呼出が永久にスロット待ちになりテストがタイムアウトする。
      await gateway.embeddings({ model: 'text-embedding-3-small', input: ['x'] })
      expect(getLlmConcurrencyState().active).toBe(0)
    })
  })

  describe('llmErrorLog wiring (embeddings は errorMessage を返さず null を返すが、失敗経路は同様にログへ残る)', () => {
    afterEach(() => {
      resetLlmErrorLog()
    })

    it('records the full raw response body to the debug-only error log on an HTTP error', async () => {
      resetLlmErrorLog()
      const gateway = createAiGateway(settings({
        translationProvider: 'local_openai',
        openaiCompatibleBaseUrl: 'http://127.0.0.1:1234/v1',
      }), {
        fetch: async () => new Response('embeddings server exploded: secret-detail-xyz', { status: 500 }),
      })

      const vectors = await gateway.embeddings({ model: 'text-embedding-3-small', input: ['x'] })

      expect(vectors).toBeNull()
      const records = getLlmErrorLog()
      expect(records).toHaveLength(1)
      expect(records[0].httpStatus).toBe(500)
      expect(records[0].detail).toContain('secret-detail-xyz')
    })

    it('records a fetch exception to the debug-only error log', async () => {
      resetLlmErrorLog()
      const gateway = createAiGateway(settings({
        translationProvider: 'local_openai',
        openaiCompatibleBaseUrl: 'http://127.0.0.1:1234/v1',
      }), {
        fetch: async () => { throw new Error('network down') },
      })

      const vectors = await gateway.embeddings({ model: 'text-embedding-3-small', input: ['x'] })

      expect(vectors).toBeNull()
      const records = getLlmErrorLog()
      expect(records.some((r) => r.errorCode === 'fetch_failed' && r.detail.includes('network down'))).toBe(true)
    })

    it('does not record anything on a successful response', async () => {
      resetLlmErrorLog()
      const gateway = createAiGateway(settings({
        translationProvider: 'local_openai',
        openaiCompatibleBaseUrl: 'http://127.0.0.1:1234/v1',
      }), {
        fetch: async () => new Response(JSON.stringify({
          data: [{ embedding: [1, 0, 0] }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
      })

      await gateway.embeddings({ model: 'text-embedding-3-small', input: ['x'] })

      expect(getLlmErrorLog()).toHaveLength(0)
    })
  })
})
