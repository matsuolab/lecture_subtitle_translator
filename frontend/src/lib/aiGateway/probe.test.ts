import { afterEach, describe, expect, it } from 'vitest'
import { getDefaultAdminSettings } from '@/api/adminSettings'
import type { AdminSettings } from '@/types/adminSettings'
import type { TauriFetchOptions } from '@/lib/tauriFetch'
import { createAiGateway } from './index'
import { resetLmStudioContextLengthCache } from './lmStudioContextLength'

function settings(overrides: Partial<AdminSettings> = {}): AdminSettings {
  return {
    ...getDefaultAdminSettings(),
    openaiApiKey: 'sk-test',
    ...overrides,
  }
}

/**
 * LM Studio 拡張エンドポイント (`/api/v0/models`) 用のハンドラ。
 * 404 を返し、resolveLmStudioLoadedContextLength を undefined へフォールバックさせる
 * （このファイルの大半のテストは実コンテキスト長取得そのものの検証対象ではないため、
 * Connection チェックのメッセージに余計な注記を混入させない）。
 * 呼出元の fetch ハンドラでは `.endsWith('/models')` より必ず先にチェックすること
 * （`/api/v0/models` も `/models` で終わるため、順序を誤ると通常の /models 応答に化けてしまう）。
 */
function notFoundIfLmStudioModelsProbe(url: string): Response | undefined {
  return url.endsWith('/api/v0/models') ? new Response('not found', { status: 404 }) : undefined
}

afterEach(() => {
  resetLmStudioContextLengthCache()
})

describe('AI Gateway probeAll', () => {
  it('checks connection, chat text, embeddings, and chat vision from one public call', async () => {
    const calls: Array<{ url: string; init: TauriFetchOptions }> = []
    const gateway = createAiGateway(settings({
      translationProvider: 'openai',
      translationModel: 'gpt-5.4-mini',
      pdfExtractionVisionModel: 'gpt-5.4-nano',
      embeddingModel: 'text-embedding-3-small',
    }), {
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} })
        if (String(url).endsWith('/models')) {
          return new Response(JSON.stringify({ data: [{ id: 'gpt-5.4-mini' }] }), { status: 200 })
        }
        if (String(url).endsWith('/embeddings')) {
          return new Response(JSON.stringify({ data: [{ embedding: [1, 0, 0] }] }), { status: 200 })
        }
        return new Response(JSON.stringify({
          choices: [
            {
              finish_reason: 'stop',
              message: { content: '{"ok":true}', refusal: null },
            },
          ],
        }), { status: 200 })
      },
    })

    const results = await gateway.probeAll()

    // OpenAI プロファイル（LM Studio 系ではない）なので /api/v0/models は一切叩かれない
    // （lmStudioContextLength.ts の isLmStudioProfile ガード）。呼出シーケンスは従来どおり。
    expect(results.map(result => [result.name, result.status])).toEqual([
      ['Connection', 'success'],
      ['Chat Text', 'success'],
      ['Embeddings', 'success'],
      ['Chat Vision', 'success'],
    ])
    expect(calls.map(call => call.url)).toEqual([
      'https://api.openai.com/v1/models',
      'https://api.openai.com/v1/chat/completions',
      'https://api.openai.com/v1/embeddings',
      'https://api.openai.com/v1/chat/completions',
    ])

    const visionBody = JSON.parse(String(calls[3].init.body))
    expect(visionBody.messages[0].content[1].type).toBe('image_url')
    expect(visionBody.messages[0].content[1].image_url.url).toContain('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAY')
    expect(visionBody.messages[0].content[0].text).toContain('Return JSON only')
    // provider が openai なので、chatVision 経路でもトークン上限は送らない。
    expect(visionBody.max_completion_tokens).toBeUndefined()
    expect(visionBody.max_tokens).toBeUndefined()
  })

  it('uses the local OpenAI-compatible request dialect for probes', async () => {
    const calls: Array<{ url: string; init: TauriFetchOptions }> = []
    const gateway = createAiGateway(settings({
      translationProvider: 'local_openai',
      openaiCompatibleBaseUrl: 'http://127.0.0.1:1234/v1',
      translationModel: 'google/gemma-4-12b',
      pdfExtractionVisionModel: 'google/gemma-4-12b',
      embeddingModel: 'text-embedding-3-small',
    }), {
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} })
        const lmStudioProbe = notFoundIfLmStudioModelsProbe(String(url))
        if (lmStudioProbe) return lmStudioProbe
        if (String(url).endsWith('/models')) {
          return new Response(JSON.stringify({ data: [{ id: 'google/gemma-4-12b' }] }), { status: 200 })
        }
        if (String(url).endsWith('/embeddings')) {
          return new Response(JSON.stringify({ data: [{ embedding: [1, 0, 0] }] }), { status: 200 })
        }
        return new Response(JSON.stringify({
          choices: [
            {
              finish_reason: 'stop',
              message: { content: '{"ok":true}', refusal: null },
            },
          ],
        }), { status: 200 })
      },
    })

    const results = await gateway.probeAll()

    expect(results.every(result => result.status === 'success')).toBe(true)
    // local_openai (127.0.0.1:1234) は既定で LM Studio プロファイルへ解決されるため、
    // Connection チェック直後に `/api/v0/models` への実コンテキスト長取得が1回挟まる
    // （lmStudioContextLength.ts 参照）。よって chat/vision の呼出は 1 つずつ後ろへずれる。
    const chatBody = JSON.parse(String(calls[2].init.body))
    const visionBody = JSON.parse(String(calls[4].init.body))
    expect(chatBody.response_format).toEqual({ type: 'text' })
    expect(visionBody.response_format).toEqual({ type: 'text' })
    expect(typeof chatBody.max_tokens).toBe('number')
    expect(chatBody.max_completion_tokens).toBeUndefined()
    expect(visionBody.messages[0].content[0].text).toContain('Return JSON only')
    expect(visionBody.max_tokens).toBe(256)
    expect(visionBody.max_completion_tokens).toBeUndefined()
  })

  it('uses the explicitly selected API compatibility profile for probe requests', async () => {
    const calls: Array<{ url: string; init: TauriFetchOptions }> = []
    const gateway = createAiGateway(settings({
      translationProvider: 'openai',
      apiCompatibilityProfilePreset: 'lmstudio',
      translationModel: 'gpt-5.4-mini',
      pdfExtractionVisionModel: 'gpt-5.4-nano',
      embeddingModel: 'text-embedding-3-small',
    }), {
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} })
        const lmStudioProbe = notFoundIfLmStudioModelsProbe(String(url))
        if (lmStudioProbe) return lmStudioProbe
        if (String(url).endsWith('/models')) {
          return new Response(JSON.stringify({ data: [{ id: 'gpt-5.4-mini' }] }), { status: 200 })
        }
        if (String(url).endsWith('/embeddings')) {
          return new Response(JSON.stringify({ data: [{ embedding: [1, 0, 0] }] }), { status: 200 })
        }
        return new Response(JSON.stringify({
          choices: [
            {
              finish_reason: 'stop',
              message: { content: '{"ok":true}', refusal: null },
            },
          ],
        }), { status: 200 })
      },
    })

    const results = await gateway.probeAll()

    expect(results.every(result => result.status === 'success')).toBe(true)
    // apiCompatibilityProfilePreset:'lmstudio' を明示指定した場合も同様に実コンテキスト長取得が
    // 挟まる（provider が openai でも、プロファイルの明示指定がプロバイダ既定より優先されるため）。
    const chatBody = JSON.parse(String(calls[2].init.body))
    const visionBody = JSON.parse(String(calls[4].init.body))
    expect(chatBody.response_format).toEqual({ type: 'text' })
    expect(visionBody.response_format).toEqual({ type: 'text' })
    // Chat Text (chatText.ts 経由) は translationProvider: 'openai' に基づく provider で判定される。
    // apiCompatibilityProfilePreset: 'lmstudio' は endpoint/tokenLimitParam/responseFormat の
    // 「方言」だけを切り替えるものであり、adaptChatCompletionRequest が参照する provider
    // （resolveAiProvider(settings) 由来）には影響しない。provider が openai である以上、
    // トークン上限フィールドは方言に関わらず送らない（modelProfile.ts の
    // stripTokenLimitFields 参照）。
    expect(chatBody.max_tokens).toBeUndefined()
    expect(chatBody.max_completion_tokens).toBeUndefined()
    // Chat Vision (chatVision.ts) は adaptChatCompletionRequest を通らないが、トークン上限を
    // 送るかどうかの provider 分岐だけは同じ規則で適用している。方言が lmstudio でも
    // provider が openai である以上、上限は送らない。
    expect(visionBody.max_tokens).toBeUndefined()
    expect(visionBody.max_completion_tokens).toBeUndefined()
  })

  describe('Connection の実コンテキスト長注記', () => {
    it('LM Studio プロファイルで loaded_context_length を Connection メッセージに含める', async () => {
      const gateway = createAiGateway(settings({
        translationProvider: 'local_openai',
        openaiCompatibleBaseUrl: 'http://127.0.0.1:1234/v1',
        translationModel: 'google/gemma-4-12b',
        pdfExtractionVisionModel: 'google/gemma-4-12b',
        embeddingModel: 'text-embedding-3-small',
      }), {
        fetch: async (url) => {
          if (String(url).endsWith('/api/v0/models')) {
            return new Response(JSON.stringify({
              data: [{ id: 'google/gemma-4-12b', state: 'loaded', loaded_context_length: 32768, max_context_length: 131072 }],
            }), { status: 200 })
          }
          if (String(url).endsWith('/models')) {
            return new Response(JSON.stringify({ data: [{ id: 'google/gemma-4-12b' }] }), { status: 200 })
          }
          if (String(url).endsWith('/embeddings')) {
            return new Response(JSON.stringify({ data: [{ embedding: [1, 0, 0] }] }), { status: 200 })
          }
          return new Response(JSON.stringify({
            choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}', refusal: null } }],
          }), { status: 200 })
        },
      })

      const results = await gateway.probeAll()
      const connection = results.find(r => r.name === 'Connection')
      expect(connection?.status).toBe('success')
      expect(connection?.message).toContain('loaded_context_length=32768')
      expect(connection?.message).not.toContain('WARNING')
    })

    it('loaded_context_length が小さすぎる場合、対処手段つきの警告を Connection メッセージに含める', async () => {
      const gateway = createAiGateway(settings({
        translationProvider: 'local_openai',
        openaiCompatibleBaseUrl: 'http://127.0.0.1:1234/v1',
        translationModel: 'google/gemma-4-12b',
        pdfExtractionVisionModel: 'google/gemma-4-12b',
        embeddingModel: 'text-embedding-3-small',
      }), {
        fetch: async (url) => {
          if (String(url).endsWith('/api/v0/models')) {
            return new Response(JSON.stringify({
              data: [{ id: 'google/gemma-4-12b', state: 'loaded', loaded_context_length: 8192 }],
            }), { status: 200 })
          }
          if (String(url).endsWith('/models')) {
            return new Response(JSON.stringify({ data: [{ id: 'google/gemma-4-12b' }] }), { status: 200 })
          }
          if (String(url).endsWith('/embeddings')) {
            return new Response(JSON.stringify({ data: [{ embedding: [1, 0, 0] }] }), { status: 200 })
          }
          return new Response(JSON.stringify({
            choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}', refusal: null } }],
          }), { status: 200 })
        },
      })

      const results = await gateway.probeAll()
      const connection = results.find(r => r.name === 'Connection')
      expect(connection?.status).toBe('success')
      expect(connection?.message).toContain('loaded_context_length=8192')
      expect(connection?.message).toContain('WARNING')
      // ユーザーが対処できる具体的な手段（lms load -c ...）を警告文に含めること
      expect(connection?.message).toContain('lms load -c')
    })

    it('OpenAI プロファイルでは /api/v0/models を叩かず、注記も付かない', async () => {
      const calls: string[] = []
      const gateway = createAiGateway(settings({
        translationProvider: 'openai',
        translationModel: 'gpt-5.4-mini',
        pdfExtractionVisionModel: 'gpt-5.4-nano',
        embeddingModel: 'text-embedding-3-small',
      }), {
        fetch: async (url) => {
          calls.push(String(url))
          if (String(url).endsWith('/models')) {
            return new Response(JSON.stringify({ data: [{ id: 'gpt-5.4-mini' }] }), { status: 200 })
          }
          if (String(url).endsWith('/embeddings')) {
            return new Response(JSON.stringify({ data: [{ embedding: [1, 0, 0] }] }), { status: 200 })
          }
          return new Response(JSON.stringify({
            choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}', refusal: null } }],
          }), { status: 200 })
        },
      })

      const results = await gateway.probeAll()
      expect(calls.some(url => url.includes('/api/v0/models'))).toBe(false)
      const connection = results.find(r => r.name === 'Connection')
      expect(connection?.message).not.toContain('loaded_context_length')
    })
  })
})
