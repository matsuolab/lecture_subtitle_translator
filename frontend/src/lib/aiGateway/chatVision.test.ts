import { afterEach, describe, expect, it } from 'vitest'
import { getDefaultAdminSettings } from '@/api/adminSettings'
import type { AdminSettings } from '@/types/adminSettings'
import type { TauriFetchOptions } from '@/lib/tauriFetch'
import { createAiGateway } from './index'
import { getLlmActivitySnapshot, resetLlmActivity } from './llmActivity'
import { getLlmConcurrencyState, resetLlmConcurrency, setLlmConcurrencyLimit } from './llmConcurrency'
import { getLlmErrorLog, resetLlmErrorLog } from './llmErrorLog'
import { resetParamCompat } from './paramCompat'

function settings(overrides: Partial<AdminSettings> = {}): AdminSettings {
  return {
    ...getDefaultAdminSettings(),
    openaiApiKey: 'sk-test',
    ...overrides,
  }
}

describe('AI Gateway chatVision', () => {
  afterEach(() => {
    resetLlmActivity()
  })

  it('applies the OpenAI request dialect to mixed text and image_url Chat Completions', async () => {
    const calls: Array<{ url: string; init: TauriFetchOptions }> = []
    const gateway = createAiGateway(settings({ translationProvider: 'openai' }), {
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} })
        return new Response(JSON.stringify({
          choices: [
            {
              finish_reason: 'stop',
              message: { content: '{"terms":[]}', refusal: null },
            },
          ],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      },
    })

    const result = await gateway.chatVision({
      nodeName: 'vision-regression',
      model: 'gpt-5.4-nano',
      messages: [
        { role: 'system', content: 'Return JSON only.' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Read this PDF page.' },
            { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,abc', detail: 'high' } },
          ],
        },
      ],
      maxTokens: 4096,
      responseFormat: 'json_object',
    })

    expect(result.content).toBe('{"terms":[]}')
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://api.openai.com/v1/chat/completions')
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      model: 'gpt-5.4-nano',
      messages: [
        { role: 'system', content: 'Return JSON only.' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Read this PDF page.' },
            { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,abc', detail: 'high' } },
          ],
        },
      ],
      // provider が openai のため、maxTokens: 4096 を渡してもトークン上限は送られない
      // （chatVision.ts の provider 分岐 / modelProfile.ts の stripTokenLimitFields 参照）。
      response_format: { type: 'json_object' },
    })
  })

  it('sends a Structured Outputs response_format when jsonSchema is provided for LM Studio', async () => {
    const calls: Array<{ init: TauriFetchOptions }> = []
    const gateway = createAiGateway(settings({
      translationProvider: 'local_openai',
      openaiCompatibleBaseUrl: 'http://127.0.0.1:1234/v1',
    }), {
      fetch: async (_url, init) => {
        calls.push({ init: init ?? {} })
        return new Response(JSON.stringify({
          choices: [{ finish_reason: 'stop', message: { content: '{"terms":[]}', refusal: null } }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      },
    })

    await gateway.chatVision({
      nodeName: 'vision-json-schema',
      model: 'google/gemma-4-12b',
      messages: [{ role: 'user', content: 'Read this page.' }],
      maxTokens: 512,
      jsonSchema: {
        name: 'terms_response',
        schema: { type: 'object', properties: { terms: { type: 'array' } }, required: ['terms'], additionalProperties: false },
      },
    })

    const body = JSON.parse(String(calls[0].init.body))
    expect(body.response_format).toEqual({
      type: 'json_schema',
      json_schema: {
        name: 'terms_response',
        strict: true,
        schema: { type: 'object', properties: { terms: { type: 'array' } }, required: ['terms'], additionalProperties: false },
      },
    })
    // local_openai は据え置き。小さいコンテキストを推論と本文で共有するため上限が必要で、
    // openai / gemini と違ってトークン上限を送り続ける。
    expect(body.max_tokens).toBe(512)
  })

  it('reports errorCode=truncated on finish_reason=length', async () => {
    const gateway = createAiGateway(settings({ translationProvider: 'openai' }), {
      fetch: async () => new Response(JSON.stringify({
        choices: [{ finish_reason: 'length', message: { content: 'partial', refusal: null } }],
        usage: { prompt_tokens: 5, completion_tokens: 16, completion_tokens_details: { reasoning_tokens: 9 } },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    })

    const result = await gateway.chatVision({
      nodeName: 'vision-truncated-regression',
      model: 'gpt-5.4-nano',
      messages: [{ role: 'user', content: 'Read this page.' }],
      maxTokens: 16,
    })

    expect(result.errorCode).toBe('truncated')
    // provider が openai のため maxTokens: 16 を渡しても上限は送らない（chatVision.ts の provider
    // 分岐 / modelProfile.ts の stripTokenLimitFields 参照）。分岐判定には使わない表示用メッセージ
    // だが、原因究明に必要な情報（上限の有無・消費内訳・本文長）を含んでいることを確認する。
    expect(result.errorMessage?.startsWith('truncated_at_length_limit:')).toBe(true)
    expect(result.errorMessage).toContain('上限は送っていない')
    expect(result.errorMessage).toContain('消費 completion=16（うち推論9）')
    expect(result.errorMessage).toContain(`本文${'partial'.length}文字`)
    expect(result.completionTokens).toBe(16)
    expect(result.reasoningTokens).toBe(9)
  })

  it('reports errorCode=fetch_failed when the network request throws', async () => {
    const gateway = createAiGateway(settings({ translationProvider: 'openai' }), {
      fetch: async () => { throw new Error('network down') },
    })

    const result = await gateway.chatVision({
      nodeName: 'vision-fetch-failure-regression',
      model: 'gpt-5.4-nano',
      messages: [{ role: 'user', content: 'Read this page.' }],
    })

    expect(result.errorCode).toBe('fetch_failed')
    expect(result.errorMessage).toContain('fetch_failed')
  })

  it('reports errorCode=connection_failed when connection resolution fails before any fetch is issued', async () => {
    let fetchCalled = false
    const gateway = createAiGateway({
      ...getDefaultAdminSettings(),
      translationProvider: 'openai',
      openaiApiKey: '',
    }, {
      fetch: async () => { fetchCalled = true; throw new Error('should not be called') },
    })

    const result = await gateway.chatVision({
      nodeName: 'vision-connection-failure-regression',
      model: 'gpt-5.4-nano',
      messages: [{ role: 'user', content: 'Read this page.' }],
    })

    expect(fetchCalled).toBe(false)
    expect(result.errorCode).toBe('connection_failed')
    expect(result.errorMessage).toContain('connection_failed')
  })

  it('reports errorCode=timeout with a distinct errorMessage when fetch throws a timeout error', async () => {
    const gateway = createAiGateway(settings({ translationProvider: 'openai' }), {
      fetch: async () => { throw new DOMException('The operation timed out.', 'TimeoutError') },
    })

    const result = await gateway.chatVision({
      nodeName: 'vision-timeout-regression',
      model: 'gpt-5.4-nano',
      messages: [{ role: 'user', content: 'Read this page.' }],
    })

    expect(result.errorCode).toBe('timeout')
    expect(result.errorMessage).toContain('request_timeout')
    expect(result.errorMessage).not.toContain('fetch_failed')
  })

  it('sends the jsonSchema-based response_format even when responseFormat is explicitly "omit" (hardening regression)', async () => {
    const calls: Array<{ init: TauriFetchOptions }> = []
    const gateway = createAiGateway(settings({
      translationProvider: 'local_openai',
      openaiCompatibleBaseUrl: 'http://127.0.0.1:1234/v1',
    }), {
      fetch: async (_url, init) => {
        calls.push({ init: init ?? {} })
        return new Response(JSON.stringify({
          choices: [{ finish_reason: 'stop', message: { content: '{"terms":[]}', refusal: null } }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      },
    })

    await gateway.chatVision({
      nodeName: 'vision-omit-jsonschema-regression',
      model: 'google/gemma-4-12b',
      messages: [{ role: 'user', content: 'Read this page.' }],
      maxTokens: 512,
      responseFormat: 'omit',
      jsonSchema: {
        name: 'terms_response',
        schema: { type: 'object', properties: { terms: { type: 'array' } }, required: ['terms'], additionalProperties: false },
      },
    })

    const body = JSON.parse(String(calls[0].init.body))
    expect(body.response_format).toEqual({
      type: 'json_schema',
      json_schema: {
        name: 'terms_response',
        strict: true,
        schema: { type: 'object', properties: { terms: { type: 'array' } }, required: ['terms'], additionalProperties: false },
      },
    })
  })

  describe('LLM activity tracking (inFlight must return to 0 on every exit path)', () => {
    it('clears inFlight after a successful response', async () => {
      resetLlmActivity()
      const gateway = createAiGateway(settings({ translationProvider: 'openai' }), {
        fetch: async () => new Response(JSON.stringify({
          choices: [{ finish_reason: 'stop', message: { content: 'ok', refusal: null } }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
      })

      await gateway.chatVision({
        nodeName: 'vision-activity-success-regression',
        model: 'gpt-5.4-nano',
        messages: [{ role: 'user', content: 'Read this page.' }],
      })

      expect(getLlmActivitySnapshot().inFlight).toBe(0)
      expect(getLlmActivitySnapshot().totalCompleted).toBe(1)
    })

    it('clears inFlight after an HTTP error response', async () => {
      resetLlmActivity()
      const gateway = createAiGateway(settings({ translationProvider: 'openai' }), {
        fetch: async () => new Response('server error', { status: 500 }),
      })

      const result = await gateway.chatVision({
        nodeName: 'vision-activity-http-error-regression',
        model: 'gpt-5.4-nano',
        messages: [{ role: 'user', content: 'Read this page.' }],
      })

      expect(result.errorCode).toBe('http_error')
      expect(getLlmActivitySnapshot().inFlight).toBe(0)
      expect(getLlmActivitySnapshot().totalCompleted).toBe(1)
    })

    it('clears inFlight after a timeout', async () => {
      resetLlmActivity()
      const gateway = createAiGateway(settings({ translationProvider: 'openai' }), {
        fetch: async () => { throw new DOMException('The operation timed out.', 'TimeoutError') },
      })

      const result = await gateway.chatVision({
        nodeName: 'vision-activity-timeout-regression',
        model: 'gpt-5.4-nano',
        messages: [{ role: 'user', content: 'Read this page.' }],
      })

      expect(result.errorCode).toBe('timeout')
      expect(getLlmActivitySnapshot().inFlight).toBe(0)
      expect(getLlmActivitySnapshot().totalCompleted).toBe(1)
    })

    it('clears inFlight when fetch throws an unexpected exception', async () => {
      resetLlmActivity()
      const gateway = createAiGateway(settings({ translationProvider: 'openai' }), {
        fetch: async () => { throw new Error('network down') },
      })

      const result = await gateway.chatVision({
        nodeName: 'vision-activity-exception-regression',
        model: 'gpt-5.4-nano',
        messages: [{ role: 'user', content: 'Read this page.' }],
      })

      expect(result.errorCode).toBe('fetch_failed')
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
      const gateway = createAiGateway(settings({ translationProvider: 'openai' }), {
        fetch: async () => new Response(JSON.stringify({
          choices: [{ finish_reason: 'stop', message: { content: 'ok', refusal: null } }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
      })

      await gateway.chatVision({
        nodeName: 'vision-concurrency-success-regression',
        model: 'gpt-5.4-nano',
        messages: [{ role: 'user', content: 'Read this page.' }],
      })

      expect(getLlmConcurrencyState().active).toBe(0)
    })

    it('releases the concurrency slot when fetch throws an unexpected exception, unblocking the next queued call', async () => {
      resetLlmConcurrency()
      setLlmConcurrencyLimit(1)
      const gateway = createAiGateway(settings({ translationProvider: 'openai' }), {
        fetch: async () => { throw new Error('network down') },
      })

      await gateway.chatVision({
        nodeName: 'vision-concurrency-exception-regression-1',
        model: 'gpt-5.4-nano',
        messages: [{ role: 'user', content: 'Read this page.' }],
      })
      expect(getLlmConcurrencyState().active).toBe(0)

      // 解放漏れがあれば limit=1 のこの2回目呼出が永久にスロット待ちになりテストがタイムアウトする。
      await gateway.chatVision({
        nodeName: 'vision-concurrency-exception-regression-2',
        model: 'gpt-5.4-nano',
        messages: [{ role: 'user', content: 'Read this page.' }],
      })
      expect(getLlmConcurrencyState().active).toBe(0)
    })
  })

  describe('llmErrorLog / paramCompat wiring', () => {
    afterEach(() => {
      resetLlmErrorLog()
      resetParamCompat()
    })

    it('records the full raw provider response body to the debug-only error log on an HTTP error, without leaking it into errorCode', async () => {
      resetLlmErrorLog()
      const gateway = createAiGateway(settings({ translationProvider: 'openai' }), {
        fetch: async () => new Response('server exploded: secret-detail-xyz', { status: 500 }),
      })

      const result = await gateway.chatVision({
        nodeName: 'vision-error-log-regression',
        model: 'gpt-5.4-nano',
        messages: [{ role: 'user', content: 'Read this page.' }],
      })

      expect(result.errorCode).toBe('http_error')
      const records = getLlmErrorLog()
      expect(records).toHaveLength(1)
      expect(records[0].detail).toContain('secret-detail-xyz')
      expect(result.errorCode).not.toContain('secret-detail-xyz')
    })

    it('removes a learned unsupported parameter and retries once, succeeding', async () => {
      resetParamCompat()
      const bodies: Array<Record<string, unknown>> = []
      const gateway = createAiGateway(settings({ translationProvider: 'openai' }), {
        fetch: async (_url, init) => {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>
          bodies.push(body)
          if ('temperature' in body) {
            return new Response(JSON.stringify({
              error: { message: "Unsupported value: 'temperature'", param: 'temperature', code: 'unsupported_value' },
            }), { status: 400, headers: { 'Content-Type': 'application/json' } })
          }
          return new Response(JSON.stringify({
            choices: [{ finish_reason: 'stop', message: { content: 'ok', refusal: null } }],
          }), { status: 200, headers: { 'Content-Type': 'application/json' } })
        },
      })

      // model はあえて gpt-5 / o3 / o4 系以外を使う（chatText.test.ts の同種のテストと同じ理由:
      // openaiSamplingParams.ts の事前抑制対象だと temperature がそもそも送られず、
      // このテストが検証したい適応学習（paramCompat）の経路を通らなくなる）。
      const result = await gateway.chatVision({
        nodeName: 'vision-param-compat-regression',
        model: 'gpt-4.1-nano',
        temperature: 0.0,
        messages: [{ role: 'user', content: 'Read this page.' }],
      })

      expect(result.content).toBe('ok')
      expect(bodies).toHaveLength(2)
      expect(bodies[0]).toHaveProperty('temperature', 0)
      expect(bodies[1]).not.toHaveProperty('temperature')
    })
  })
})
