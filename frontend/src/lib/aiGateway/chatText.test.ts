import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultAdminSettings } from '@/api/adminSettings'
import type { AdminSettings } from '@/types/adminSettings'
import type { TauriFetchOptions } from '@/lib/tauriFetch'
import { setCurrentPipelineAbortController } from '@/lib/pipeline/pipelineAbort'
import { createAiGateway } from './index'
import { BUILTIN_API_COMPATIBILITY_PROFILES } from './apiCompatibilityProfile'
import { getLlmActivitySnapshot, resetLlmActivity } from './llmActivity'
import { getLlmConcurrencyState, resetLlmConcurrency, setLlmConcurrencyLimit } from './llmConcurrency'
import { resetLmStudioContextLengthCache } from './lmStudioContextLength'
import { RATE_LIMIT_MAX_ATTEMPTS } from './rateLimitRetry'
import { getLlmErrorLog, resetLlmErrorLog } from './llmErrorLog'
import { resetParamCompat } from './paramCompat'

/** fake timers 有効時でも Promise の microtask queue はそのまま流れるので、これで進行を待つ。 */
async function flushMicrotasks(times = 20): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve()
  }
}

function settings(overrides: Partial<AdminSettings> = {}): AdminSettings {
  return {
    ...getDefaultAdminSettings(),
    openaiApiKey: 'sk-test',
    ...overrides,
  }
}

describe('AI Gateway chatText', () => {
  afterEach(() => {
    resetLlmActivity()
  })

  it('applies the OpenAI request dialect to Chat Text requests', async () => {
    const calls: Array<{ url: string; init: TauriFetchOptions }> = []
    const gateway = createAiGateway(settings({ translationProvider: 'openai' }), {
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} })
        return new Response(JSON.stringify({
          choices: [
            {
              finish_reason: 'stop',
              message: { content: '{"ok":true}', refusal: null },
            },
          ],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 4,
            completion_tokens_details: { reasoning_tokens: 0 },
            prompt_tokens_details: { cached_tokens: 0 },
          },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      },
    })

    // model はあえて gpt-5 / o3 / o4 系以外を使う（openaiSamplingParams.ts の事前抑制対象外にして、
    // このテストの本来の主旨である「OpenAI dialect の適用」だけを検証するため。事前抑制自体の
    // 検証は openaiSamplingParams.test.ts / 下の専用テストで行う）。
    const result = await gateway.chatText({
      nodeName: 'openai-regression',
      model: 'gpt-4.1-mini',
      messages: [
        { role: 'system', content: 'Return JSON only.' },
        { role: 'user', content: 'Say ok.' },
      ],
      temperature: 0.2,
      maxTokens: 2048,
      responseFormat: 'json_object',
    })

    expect(result.content).toBe('{"ok":true}')
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://api.openai.com/v1/chat/completions')
    expect(calls[0].init.headers).toMatchObject({
      'Content-Type': 'application/json',
      Authorization: 'Bearer sk-test',
    })
    // max_completion_tokens は送らない: openai / gemini では、上限を送っても消費量は変わらず
    // 成功可否だけが左右される実測結果を受けて、adaptChatCompletionRequest がトークン上限
    // フィールドを丸ごと取り除くようになった（modelProfile.ts の stripTokenLimitFields 参照）。
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      model: 'gpt-4.1-mini',
      messages: [
        { role: 'system', content: 'Return JSON only.' },
        { role: 'user', content: 'Say ok.' },
      ],
      temperature: 0.2,
      response_format: { type: 'json_object' },
    })
  })

  describe('openai sampling param pre-suppression (gpt-5 / o3 / o4 は temperature/top_p を最初から送らない)', () => {
    it('omits temperature for an OpenAI gpt-5 model even when the caller requests it', async () => {
      const calls: Array<{ init: TauriFetchOptions }> = []
      const gateway = createAiGateway(settings({ translationProvider: 'openai' }), {
        fetch: async (_url, init) => {
          calls.push({ init: init ?? {} })
          return new Response(JSON.stringify({
            choices: [{ finish_reason: 'stop', message: { content: 'ok', refusal: null } }],
          }), { status: 200, headers: { 'Content-Type': 'application/json' } })
        },
      })

      await gateway.chatText({
        nodeName: 'openai-gpt5-suppression',
        model: 'gpt-5.4-mini',
        temperature: 0.0,
        messages: [{ role: 'user', content: 'Say ok.' }],
      })

      expect(calls).toHaveLength(1)
      const body = JSON.parse(String(calls[0].init.body))
      expect(body).not.toHaveProperty('temperature')
      expect(body).not.toHaveProperty('top_p')
    })

    it('keeps temperature for a local LM Studio model (gemma) so determinism is preserved (regression guard)', async () => {
      const calls: Array<{ init: TauriFetchOptions }> = []
      const gateway = createAiGateway(settings({
        translationProvider: 'local_openai',
        openaiCompatibleBaseUrl: 'http://127.0.0.1:1234/v1',
        translationModel: 'google/gemma-4-12b',
      }), {
        fetch: async (_url, init) => {
          calls.push({ init: init ?? {} })
          return new Response(JSON.stringify({
            choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}', refusal: null } }],
          }), { status: 200, headers: { 'Content-Type': 'application/json' } })
        },
      })

      await gateway.chatText({
        nodeName: 'lmstudio-gemma-no-suppression',
        model: 'google/gemma-4-12b',
        temperature: 0.0,
        maxTokens: 512,
        messages: [{ role: 'user', content: 'Say ok.' }],
      })

      expect(calls).toHaveLength(1)
      const body = JSON.parse(String(calls[0].init.body))
      expect(body).toHaveProperty('temperature', 0)
    })
  })

  it('classifies local context size errors with an actionable hint', async () => {
    const gateway = createAiGateway(settings({
      translationProvider: 'local_openai',
      openaiCompatibleBaseUrl: 'http://127.0.0.1:1234/v1',
      translationModel: 'google/gemma-4-12b',
    }), {
      fetch: async () => new Response(JSON.stringify({
        error: 'Context size has been exceeded.',
      }), { status: 400, headers: { 'Content-Type': 'application/json' } }),
    })

    const result = await gateway.chatText({
      nodeName: 'local-context-regression',
      model: 'google/gemma-4-12b',
      messages: [{ role: 'user', content: 'Translate this.' }],
      maxTokens: 2048,
    })

    expect(result.httpStatus).toBe(400)
    expect(result.errorMessage).toContain('context_size_exceeded')
    expect(result.errorMessage).toContain('LM Studio')
    expect(result.errorMessage).toContain('context length')
    // HTTP 400 + コンテキスト長超過の本文は決定的エラーとして分類される（errors.ts の
    // classifyHttpErrorCode 参照）。呼出元（correct.ts 等）はこのコードを「同一内容の
    // 盲リトライ禁止・入力を小さくして再試行」の分岐トリガーに使う。
    expect(result.errorCode).toBe('context_exceeded')
  })

  it('sends a Structured Outputs response_format when jsonSchema is provided for LM Studio', async () => {
    const calls: Array<{ init: TauriFetchOptions }> = []
    const gateway = createAiGateway(settings({
      translationProvider: 'local_openai',
      openaiCompatibleBaseUrl: 'http://127.0.0.1:1234/v1',
      translationModel: 'google/gemma-4-12b',
    }), {
      fetch: async (_url, init) => {
        calls.push({ init: init ?? {} })
        return new Response(JSON.stringify({
          choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}', refusal: null } }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      },
    })

    await gateway.chatText({
      nodeName: 'lmstudio-json-schema',
      model: 'google/gemma-4-12b',
      messages: [{ role: 'user', content: 'Say ok.' }],
      maxTokens: 512,
      jsonSchema: {
        name: 'ok_response',
        schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },
      },
    })

    expect(calls).toHaveLength(1)
    const body = JSON.parse(String(calls[0].init.body))
    expect(body.response_format).toEqual({
      type: 'json_schema',
      json_schema: {
        name: 'ok_response',
        strict: true,
        schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },
      },
    })
  })

  it('keeps the existing response_format behavior when jsonSchema is not provided', async () => {
    const calls: Array<{ init: TauriFetchOptions }> = []
    const gateway = createAiGateway(settings({
      translationProvider: 'local_openai',
      openaiCompatibleBaseUrl: 'http://127.0.0.1:1234/v1',
      translationModel: 'google/gemma-4-12b',
    }), {
      fetch: async (_url, init) => {
        calls.push({ init: init ?? {} })
        return new Response(JSON.stringify({
          choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}', refusal: null } }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      },
    })

    await gateway.chatText({
      nodeName: 'lmstudio-no-schema',
      model: 'google/gemma-4-12b',
      messages: [{ role: 'user', content: 'Say ok.' }],
      maxTokens: 512,
    })

    expect(calls).toHaveLength(1)
    const body = JSON.parse(String(calls[0].init.body))
    expect(body.response_format).toEqual({ type: 'text' })
  })

  it('reports errorCode=truncated on finish_reason=length while keeping the legacy errorMessage prefix', async () => {
    const gateway = createAiGateway(settings({ translationProvider: 'openai' }), {
      fetch: async () => new Response(JSON.stringify({
        choices: [{ finish_reason: 'length', message: { content: 'partial output', refusal: null } }],
        usage: { prompt_tokens: 10, completion_tokens: 16, completion_tokens_details: { reasoning_tokens: 16 } },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    })

    const result = await gateway.chatText({
      nodeName: 'truncated-regression',
      model: 'gpt-5.4-mini',
      messages: [{ role: 'user', content: 'Say ok.' }],
      maxTokens: 16,
    })

    expect(result.errorCode).toBe('truncated')
    // 分岐判定には使われない表示用メッセージだが（errorCode で分岐すること。detectIncompleteEnds.ts
    // 冒頭 JSDoc 参照）、原因究明に必要な情報（上限の有無・消費内訳・本文長）を含んでいることを確認する。
    // provider が openai のため、maxTokens: 16 を渡しても実際には上限を送らない
    // （modelProfile.ts の stripTokenLimitFields 参照）。
    expect(result.errorMessage?.startsWith('truncated_at_length_limit:')).toBe(true)
    expect(result.errorMessage).toContain('上限は送っていない')
    expect(result.errorMessage).toContain('消費 completion=16（うち推論16）')
    expect(result.errorMessage).toContain(`本文${'partial output'.length}文字`)
  })

  it('includes the actual sent token limit param/value in the truncated errorMessage for the local_openai path', async () => {
    const gateway = createAiGateway(settings({
      translationProvider: 'local_openai',
      openaiCompatibleBaseUrl: 'http://127.0.0.1:1234/v1',
    }), {
      fetch: async () => new Response(JSON.stringify({
        choices: [{ finish_reason: 'length', message: { content: 'partial output', refusal: null } }],
        usage: { prompt_tokens: 10, completion_tokens: 376, completion_tokens_details: { reasoning_tokens: 376 } },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    })

    const result = await gateway.chatText({
      nodeName: 'truncated-local-regression',
      model: 'google/gemma-4-12b',
      messages: [{ role: 'user', content: 'Say ok.' }],
      maxTokens: 376,
    })

    expect(result.errorCode).toBe('truncated')
    expect(result.errorMessage).toContain('max_tokens')
    expect(result.errorMessage).toContain('消費 completion=376（うち推論376）')
    // 上限を送っていた場合は、確認すべき設定名のヒントを含む。
    expect(result.errorMessage).toContain('llmReasoningBudgetTokens')
  })

  it('reports the custom tokenLimitParam name in the truncated errorMessage for user-defined profiles', async () => {
    // ユーザー定義プロファイルは任意のパラメータ名を指定できる。メッセージ側が組み込みの
    // 2つに決め打ちしていると、上限を送っているのに「送っていない」と報告してしまい、
    // このメッセージの目的（切断原因が一目で分かること）そのものが壊れる。
    const gateway = createAiGateway(settings({
      translationProvider: 'local_openai',
      openaiCompatibleBaseUrl: 'http://127.0.0.1:1234/v1',
      apiCompatibilityProfilePreset: 'user',
      apiCompatibilityProfileJson: JSON.stringify({
        ...BUILTIN_API_COMPATIBILITY_PROFILES.lmStudio,
        id: 'custom-runtime',
        label: 'Custom runtime',
        requestDialect: {
          ...BUILTIN_API_COMPATIBILITY_PROFILES.lmStudio.requestDialect,
          chat: {
            ...BUILTIN_API_COMPATIBILITY_PROFILES.lmStudio.requestDialect.chat,
            tokenLimitParam: 'num_predict',
          },
        },
      }),
    }), {
      fetch: async () => new Response(JSON.stringify({
        choices: [{ finish_reason: 'length', message: { content: '', refusal: null } }],
        usage: { prompt_tokens: 10, completion_tokens: 999, completion_tokens_details: { reasoning_tokens: 900 } },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    })

    const result = await gateway.chatText({
      nodeName: 'truncated-custom-param-regression',
      model: 'some-local-model',
      messages: [{ role: 'user', content: 'Say ok.' }],
      maxTokens: 999,
    })

    expect(result.errorCode).toBe('truncated')
    expect(result.errorMessage).toContain('num_predict')
    expect(result.errorMessage).not.toContain('上限は送っていない')
    expect(result.errorMessage).toContain('llmReasoningBudgetTokens')
  })

  it('reports errorCode=fetch_failed when the network request throws', async () => {
    const gateway = createAiGateway(settings({ translationProvider: 'openai' }), {
      fetch: async () => { throw new Error('network down') },
    })

    const result = await gateway.chatText({
      nodeName: 'fetch-failure-regression',
      model: 'gpt-5.4-mini',
      messages: [{ role: 'user', content: 'Say ok.' }],
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

    const result = await gateway.chatText({
      nodeName: 'connection-failure-regression',
      model: 'gpt-5.4-mini',
      messages: [{ role: 'user', content: 'Say ok.' }],
    })

    expect(fetchCalled).toBe(false)
    expect(result.errorCode).toBe('connection_failed')
    expect(result.errorMessage).toContain('connection_failed')
  })

  it('reports errorCode=empty_response for blank content', async () => {
    const gateway = createAiGateway(settings({ translationProvider: 'openai' }), {
      fetch: async () => new Response(JSON.stringify({
        choices: [{ finish_reason: 'stop', message: { content: '', refusal: null } }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    })

    const result = await gateway.chatText({
      nodeName: 'empty-response-regression',
      model: 'gpt-5.4-mini',
      messages: [{ role: 'user', content: 'Say ok.' }],
    })

    expect(result.errorCode).toBe('empty_response')
  })

  it('reports errorCode=content_filter for finish_reason=content_filter', async () => {
    const gateway = createAiGateway(settings({ translationProvider: 'openai' }), {
      fetch: async () => new Response(JSON.stringify({
        choices: [{ finish_reason: 'content_filter', message: { content: '', refusal: null } }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    })

    const result = await gateway.chatText({
      nodeName: 'content-filter-regression',
      model: 'gpt-5.4-mini',
      messages: [{ role: 'user', content: 'Say ok.' }],
    })

    expect(result.errorCode).toBe('content_filter')
  })

  it('passes llmRequestTimeoutSec converted to milliseconds as fetch timeoutMs', async () => {
    const calls: Array<{ init: TauriFetchOptions }> = []
    const gateway = createAiGateway(settings({ translationProvider: 'openai', llmRequestTimeoutSec: 600 }), {
      fetch: async (_url, init) => {
        calls.push({ init: init ?? {} })
        return new Response(JSON.stringify({
          choices: [{ finish_reason: 'stop', message: { content: 'ok', refusal: null } }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      },
    })

    await gateway.chatText({
      nodeName: 'timeout-ms-regression',
      model: 'gpt-5.4-mini',
      messages: [{ role: 'user', content: 'Say ok.' }],
    })

    expect(calls).toHaveLength(1)
    expect(calls[0].init.timeoutMs).toBe(600_000)
  })

  it('reports errorCode=timeout with a distinct errorMessage when the browser fetch path aborts via timeout', async () => {
    const gateway = createAiGateway(settings({ translationProvider: 'openai' }), {
      fetch: async () => { throw new DOMException('The operation timed out.', 'TimeoutError') },
    })

    const result = await gateway.chatText({
      nodeName: 'timeout-regression',
      model: 'gpt-5.4-mini',
      messages: [{ role: 'user', content: 'Say ok.' }],
    })

    expect(result.errorCode).toBe('timeout')
    expect(result.errorMessage).toContain('request_timeout')
    expect(result.errorMessage).not.toContain('fetch_failed')
  })

  it('reports errorCode=timeout when the Rust http_request command reports its dedicated timeout message', async () => {
    const gateway = createAiGateway(settings({
      translationProvider: 'local_openai',
      openaiCompatibleBaseUrl: 'http://127.0.0.1:1234/v1',
      translationModel: 'google/gemma-4-12b',
    }), {
      fetch: async () => { throw new Error('HTTP request to http://127.0.0.1:1234/v1/chat/completions timed out after 600000ms') },
    })

    const result = await gateway.chatText({
      nodeName: 'rust-timeout-regression',
      model: 'google/gemma-4-12b',
      messages: [{ role: 'user', content: 'Say ok.' }],
    })

    expect(result.errorCode).toBe('timeout')
    expect(result.errorMessage).toContain('request_timeout')
  })

  it('sends the jsonSchema-based response_format even when responseFormat is explicitly "omit" (hardening regression)', async () => {
    const calls: Array<{ init: TauriFetchOptions }> = []
    const gateway = createAiGateway(settings({
      translationProvider: 'local_openai',
      openaiCompatibleBaseUrl: 'http://127.0.0.1:1234/v1',
      translationModel: 'google/gemma-4-12b',
    }), {
      fetch: async (_url, init) => {
        calls.push({ init: init ?? {} })
        return new Response(JSON.stringify({
          choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}', refusal: null } }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      },
    })

    await gateway.chatText({
      nodeName: 'omit-jsonschema-regression',
      model: 'google/gemma-4-12b',
      messages: [{ role: 'user', content: 'Say ok.' }],
      maxTokens: 512,
      responseFormat: 'omit',
      jsonSchema: {
        name: 'ok_response',
        schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },
      },
    })

    expect(calls).toHaveLength(1)
    const body = JSON.parse(String(calls[0].init.body))
    expect(body.response_format).toEqual({
      type: 'json_schema',
      json_schema: {
        name: 'ok_response',
        strict: true,
        schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },
      },
    })
  })

  it('omits response_format entirely when responseFormat is "omit" and no jsonSchema is provided', async () => {
    const calls: Array<{ init: TauriFetchOptions }> = []
    const gateway = createAiGateway(settings({ translationProvider: 'openai' }), {
      fetch: async (_url, init) => {
        calls.push({ init: init ?? {} })
        return new Response(JSON.stringify({
          choices: [{ finish_reason: 'stop', message: { content: 'ok', refusal: null } }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      },
    })

    await gateway.chatText({
      nodeName: 'omit-no-schema-regression',
      model: 'gpt-5.4-mini',
      messages: [{ role: 'user', content: 'Say ok.' }],
      responseFormat: 'omit',
    })

    expect(calls).toHaveLength(1)
    const body = JSON.parse(String(calls[0].init.body))
    expect(body.response_format).toBeUndefined()
  })

  describe('LLM activity tracking (inFlight must return to 0 on every exit path)', () => {
    it('clears inFlight after a successful response', async () => {
      resetLlmActivity()
      const gateway = createAiGateway(settings({ translationProvider: 'openai' }), {
        fetch: async () => new Response(JSON.stringify({
          choices: [{ finish_reason: 'stop', message: { content: 'ok', refusal: null } }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
      })

      await gateway.chatText({
        nodeName: 'activity-success-regression',
        model: 'gpt-5.4-mini',
        messages: [{ role: 'user', content: 'Say ok.' }],
      })

      expect(getLlmActivitySnapshot().inFlight).toBe(0)
      expect(getLlmActivitySnapshot().totalCompleted).toBe(1)
    })

    it('clears inFlight after an HTTP error response', async () => {
      resetLlmActivity()
      const gateway = createAiGateway(settings({ translationProvider: 'openai' }), {
        fetch: async () => new Response('server error', { status: 500 }),
      })

      const result = await gateway.chatText({
        nodeName: 'activity-http-error-regression',
        model: 'gpt-5.4-mini',
        messages: [{ role: 'user', content: 'Say ok.' }],
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

      const result = await gateway.chatText({
        nodeName: 'activity-timeout-regression',
        model: 'gpt-5.4-mini',
        messages: [{ role: 'user', content: 'Say ok.' }],
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

      const result = await gateway.chatText({
        nodeName: 'activity-exception-regression',
        model: 'gpt-5.4-mini',
        messages: [{ role: 'user', content: 'Say ok.' }],
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

      await gateway.chatText({
        nodeName: 'concurrency-success-regression',
        model: 'gpt-5.4-mini',
        messages: [{ role: 'user', content: 'Say ok.' }],
      })

      expect(getLlmConcurrencyState().active).toBe(0)
    })

    it('releases the concurrency slot after an HTTP error response', async () => {
      resetLlmConcurrency()
      setLlmConcurrencyLimit(1)
      const gateway = createAiGateway(settings({ translationProvider: 'openai' }), {
        fetch: async () => new Response('server error', { status: 500 }),
      })

      await gateway.chatText({
        nodeName: 'concurrency-http-error-regression',
        model: 'gpt-5.4-mini',
        messages: [{ role: 'user', content: 'Say ok.' }],
      })

      expect(getLlmConcurrencyState().active).toBe(0)
    })

    it('releases the concurrency slot after a timeout', async () => {
      resetLlmConcurrency()
      setLlmConcurrencyLimit(1)
      const gateway = createAiGateway(settings({ translationProvider: 'openai' }), {
        fetch: async () => { throw new DOMException('The operation timed out.', 'TimeoutError') },
      })

      await gateway.chatText({
        nodeName: 'concurrency-timeout-regression',
        model: 'gpt-5.4-mini',
        messages: [{ role: 'user', content: 'Say ok.' }],
      })

      expect(getLlmConcurrencyState().active).toBe(0)
    })

    it('releases the concurrency slot when fetch throws an unexpected exception, unblocking the next queued call', async () => {
      resetLlmConcurrency()
      setLlmConcurrencyLimit(1)
      const gateway = createAiGateway(settings({ translationProvider: 'openai' }), {
        fetch: async () => { throw new Error('network down') },
      })

      await gateway.chatText({
        nodeName: 'concurrency-exception-regression-1',
        model: 'gpt-5.4-mini',
        messages: [{ role: 'user', content: 'Say ok.' }],
      })
      expect(getLlmConcurrencyState().active).toBe(0)

      // 解放漏れがあれば limit=1 のこの2回目呼出が永久にスロット待ちになりテストがタイムアウトする。
      await gateway.chatText({
        nodeName: 'concurrency-exception-regression-2',
        model: 'gpt-5.4-mini',
        messages: [{ role: 'user', content: 'Say ok.' }],
      })
      expect(getLlmConcurrencyState().active).toBe(0)
    })
  })

  describe('resolveRuntimeContextLength (LM Studio 実コンテキスト長のオプトイン取得)', () => {
    afterEach(() => {
      resetLmStudioContextLengthCache()
    })

    it('does not fetch /api/v0/models when resolveRuntimeContextLength is not set (default off)', async () => {
      const calls: string[] = []
      const gateway = createAiGateway(settings({
        translationProvider: 'local_openai',
        openaiCompatibleBaseUrl: 'http://127.0.0.1:1234/v1',
        translationModel: 'google/gemma-4-12b',
      }), {
        fetch: async (url) => {
          calls.push(String(url))
          return new Response(JSON.stringify({
            choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}', refusal: null } }],
          }), { status: 200 })
        },
      })

      await gateway.chatText({
        nodeName: 'no-runtime-context-length',
        model: 'google/gemma-4-12b',
        messages: [{ role: 'user', content: 'あ'.repeat(8000) }],
        maxTokens: 4096,
      })

      expect(calls).toEqual(['http://127.0.0.1:1234/v1/chat/completions'])
    })

    it('fetches /api/v0/models before chat/completions when resolveRuntimeContextLength is true, and uses it to relax the max_tokens clamp', async () => {
      const calls: string[] = []
      const gateway = createAiGateway(settings({
        translationProvider: 'local_openai',
        openaiCompatibleBaseUrl: 'http://127.0.0.1:1234/v1',
        translationModel: 'google/gemma-4-12b',
      }), {
        fetch: async (url) => {
          calls.push(String(url))
          if (String(url).endsWith('/api/v0/models')) {
            return new Response(JSON.stringify({
              data: [{ id: 'google/gemma-4-12b', state: 'loaded', loaded_context_length: 32768 }],
            }), { status: 200 })
          }
          return new Response(JSON.stringify({
            choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}', refusal: null } }],
          }), { status: 200 })
        },
      })

      const longContent = 'あ'.repeat(8000)
      const result = await gateway.chatText({
        nodeName: 'runtime-context-length',
        model: 'google/gemma-4-12b',
        messages: [{ role: 'user', content: longContent }],
        maxTokens: 4096,
        resolveRuntimeContextLength: true,
      })

      expect(calls).toEqual([
        'http://127.0.0.1:1234/api/v0/models',
        'http://127.0.0.1:1234/v1/chat/completions',
      ])
      // 8192 固定のフォールバックならクランプされる長さのプロンプトだが、実測 32768 を
      // 使うためクランプされずに要求どおりの max_tokens が送られる
      // （modelProfile.test.ts の同様の回帰テストと対の検証）。
      expect(result.maxTokensClampedFromRequested).toBeUndefined()
    })
  })

  describe('rate limit (429) backoff retry — 本番事故の再現テスト群', () => {
    afterEach(() => {
      resetLlmConcurrency()
      setCurrentPipelineAbortController(null)
      vi.useRealTimers()
    })

    it('retries after repeated HTTP 429 responses with backoff and eventually succeeds (production incident reproduction: gpt-5.4-mini, concurrency 7, 668/1053 blocks failed with attempt_2_http_429)', async () => {
      vi.useFakeTimers()
      let callCount = 0
      const gateway = createAiGateway(settings({ translationProvider: 'openai' }), {
        fetch: async () => {
          callCount += 1
          if (callCount < 3) {
            return new Response(JSON.stringify({
              error: { message: 'Rate limit reached for gpt-5.4-mini in organization org-fakeTestOrg0' },
            }), { status: 429, headers: { 'Content-Type': 'application/json' } })
          }
          return new Response(JSON.stringify({
            choices: [{ finish_reason: 'stop', message: { content: 'recovered', refusal: null } }],
          }), { status: 200, headers: { 'Content-Type': 'application/json' } })
        },
      })

      const resultPromise = gateway.chatText({
        nodeName: 'rate-limit-recovery-regression',
        model: 'gpt-5.4-mini',
        messages: [{ role: 'user', content: 'Say ok.' }],
      })

      await vi.runAllTimersAsync()
      const result = await resultPromise

      expect(result.content).toBe('recovered')
      expect(result.errorCode).toBeUndefined()
      expect(callCount).toBe(3)
    })

    it('honors the Retry-After header (seconds format) instead of the exponential backoff default', async () => {
      vi.useFakeTimers()
      let callCount = 0
      const gateway = createAiGateway(settings({ translationProvider: 'openai' }), {
        fetch: async () => {
          callCount += 1
          if (callCount === 1) {
            return new Response('{"error":"slow down"}', { status: 429, headers: { 'Retry-After': '5' } })
          }
          return new Response(JSON.stringify({
            choices: [{ finish_reason: 'stop', message: { content: 'ok-after-wait', refusal: null } }],
          }), { status: 200, headers: { 'Content-Type': 'application/json' } })
        },
      })

      const resultPromise = gateway.chatText({
        nodeName: 'retry-after-regression',
        model: 'gpt-5.4-mini',
        messages: [{ role: 'user', content: 'Say ok.' }],
      })

      // Retry-After (5秒) 未満ではまだ再送されていない
      await vi.advanceTimersByTimeAsync(4900)
      expect(callCount).toBe(1)

      // 5秒経過後に再送される
      await vi.advanceTimersByTimeAsync(200)
      expect(callCount).toBe(2)

      const result = await resultPromise
      expect(result.content).toBe('ok-after-wait')
    })

    it('returns errorCode=rate_limited with the original httpStatus after exhausting all retry attempts', async () => {
      vi.useFakeTimers()
      let callCount = 0
      const gateway = createAiGateway(settings({ translationProvider: 'openai' }), {
        fetch: async () => {
          callCount += 1
          return new Response('{"error":"still limited"}', { status: 429 })
        },
      })

      const resultPromise = gateway.chatText({
        nodeName: 'rate-limit-exhausted-regression',
        model: 'gpt-5.4-mini',
        messages: [{ role: 'user', content: 'Say ok.' }],
      })

      await vi.runAllTimersAsync()
      const result = await resultPromise

      expect(result.errorCode).toBe('rate_limited')
      expect(result.httpStatus).toBe(429)
      expect(callCount).toBe(RATE_LIMIT_MAX_ATTEMPTS)
    })

    it('returns errorCode=quota_exhausted immediately without any backoff retry (insufficient_quota 429 is unrecoverable, unlike a plain rate limit)', async () => {
      vi.useFakeTimers()
      let callCount = 0
      const gateway = createAiGateway(settings({ translationProvider: 'openai' }), {
        fetch: async () => {
          callCount += 1
          return new Response(JSON.stringify({
            error: { message: 'You exceeded your current quota, please check your plan and billing details.', type: 'insufficient_quota', code: 'insufficient_quota' },
          }), { status: 429, headers: { 'Content-Type': 'application/json' } })
        },
      })

      const resultPromise = gateway.chatText({
        nodeName: 'quota-exhausted-regression',
        model: 'gpt-5.4-mini',
        messages: [{ role: 'user', content: 'Say ok.' }],
      })

      // バックオフ待機が一切発生しないことを保証するため、タイマーを進めずに即座に resolve するはず。
      const result = await resultPromise

      expect(result.errorCode).toBe('quota_exhausted')
      expect(result.httpStatus).toBe(429)
      // rate_limited と異なり、1回しか呼ばれない（バックオフリトライが一度も走らない）。
      expect(callCount).toBe(1)
    })

    it('never leaks the provider raw response body (organization id etc.) into the returned errorMessage/errorCode', async () => {
      vi.useFakeTimers()
      const gateway = createAiGateway(settings({ translationProvider: 'openai' }), {
        fetch: async () => new Response(JSON.stringify({
          error: { message: 'Rate limit reached for gpt-5.4-mini in organization org-fakeTestOrg0] some secret detail' },
        }), { status: 429, headers: { 'Content-Type': 'application/json' } }),
      })

      const resultPromise = gateway.chatText({
        nodeName: 'rate-limit-no-leak-regression',
        model: 'gpt-5.4-mini',
        messages: [{ role: 'user', content: 'Say ok.' }],
      })

      await vi.runAllTimersAsync()
      const result = await resultPromise

      expect(result.errorCode).toBe('rate_limited')
      // errorMessage は診断用に残してよいが（gateway 層自体はまだ UI 直結ではない）、
      // errorCode 自体は常に短い分類コードのみであることを確認する
      // （呼出元がここから安全なマーカーを組み立てられる、という契約の根拠）。
      expect(result.errorCode).not.toContain('organization')
    })

    it('releases the concurrency slot before the backoff wait, so a second call is not blocked during the wait (deadlock regression: the most critical guarantee in this task)', async () => {
      resetLlmConcurrency()
      setLlmConcurrencyLimit(1)
      vi.useFakeTimers()

      let firstResolveFetch: ((response: Response) => void) | undefined
      const firstFetchGate = new Promise<Response>((resolve) => { firstResolveFetch = resolve })
      let firstCallCount = 0
      const gatewayFirst = createAiGateway(settings({ translationProvider: 'openai' }), {
        fetch: async () => {
          firstCallCount += 1
          if (firstCallCount === 1) return firstFetchGate
          return new Response(JSON.stringify({
            choices: [{ finish_reason: 'stop', message: { content: 'first-ok', refusal: null } }],
          }), { status: 200, headers: { 'Content-Type': 'application/json' } })
        },
      })

      const firstPromise = gatewayFirst.chatText({
        nodeName: 'slot-release-first',
        model: 'gpt-5.4-mini',
        messages: [{ role: 'user', content: 'first' }],
      })

      // 1件目の fetch がまだ pending の間は、スロットを保持しているはず。
      await flushMicrotasks()
      expect(getLlmConcurrencyState().active).toBe(1)

      // 429 を返して fetch を解決させる → finally でスロットを解放し、その後バックオフ待機に入る。
      firstResolveFetch?.(new Response('{"error":"limited"}', { status: 429 }))
      await flushMicrotasks()

      // 重要な検証: バックオフ待機中であっても、スロットは既に解放されている
      // （保持したまま待つと、limit=1 の下で他の呼出が永久にブロックされ、パイプライン全体が
      //  停止する。本タスクの最重要事故ポイント）。
      expect(getLlmConcurrencyState().active).toBe(0)

      // 2件目の呼出が同じ limit=1 の下でも即座にスロットを取得できることを確認する
      // （解放漏れがあれば、この呼出は1件目の待機完了までブロックされ続けてしまう）。
      let secondFetchCalled = false
      const gatewaySecond = createAiGateway(settings({ translationProvider: 'openai' }), {
        fetch: async () => {
          secondFetchCalled = true
          return new Response(JSON.stringify({
            choices: [{ finish_reason: 'stop', message: { content: 'second-ok', refusal: null } }],
          }), { status: 200, headers: { 'Content-Type': 'application/json' } })
        },
      })
      const secondResult = await gatewaySecond.chatText({
        nodeName: 'slot-release-second',
        model: 'gpt-5.4-mini',
        messages: [{ role: 'user', content: 'second' }],
      })
      expect(secondFetchCalled).toBe(true)
      expect(secondResult.content).toBe('second-ok')

      // 1件目もバックオフ後にリトライして成功する。
      await vi.runAllTimersAsync()
      const firstResult = await firstPromise
      expect(firstResult.content).toBe('first-ok')
    })

    it('stops retrying immediately once the pipeline abort signal fires during the backoff wait (must not keep waiting while an abort is pending)', async () => {
      vi.useFakeTimers()
      let callCount = 0
      const gateway = createAiGateway(settings({ translationProvider: 'openai' }), {
        fetch: async () => {
          callCount += 1
          return new Response('{"error":"limited"}', { status: 429 })
        },
      })

      const controller = new AbortController()
      setCurrentPipelineAbortController(controller)

      const resultPromise = gateway.chatText({
        nodeName: 'abort-during-backoff-regression',
        model: 'gpt-5.4-mini',
        messages: [{ role: 'user', content: 'x' }],
      })

      // 最初の 429 を受けてバックオフ待機に入るまで進める。
      await flushMicrotasks()
      expect(callCount).toBe(1)

      // 待機中に中断要求を出す。
      controller.abort()

      await vi.runAllTimersAsync()
      const result = await resultPromise

      expect(result.errorCode).toBe('rate_limited')
      // 中断後は追加の再送を行わない（待ち続けてはならない、という要件）。
      expect(callCount).toBe(1)
    })
  })

  describe('llmErrorLog wiring (debug 専用領域への記録と、字幕向け返り値への非漏洩の両立)', () => {
    afterEach(() => {
      resetLlmErrorLog()
      resetLlmConcurrency()
      vi.useRealTimers()
    })

    it('records the full raw provider response body in the debug-only error log on an HTTP error, while the returned errorMessage stays a short, size-capped preview', async () => {
      resetLlmErrorLog()
      vi.useFakeTimers()
      const rawBody = JSON.stringify({
        error: { message: `Rate limit reached for gpt-5.4-mini in organization org-secret-${'x'.repeat(300)}` },
      })
      const gateway = createAiGateway(settings({ translationProvider: 'openai' }), {
        fetch: async () => new Response(rawBody, { status: 429, headers: { 'Content-Type': 'application/json' } }),
      })

      const resultPromise = gateway.chatText({
        nodeName: 'error-log-http-regression',
        model: 'gpt-5.4-mini',
        messages: [{ role: 'user', content: 'x' }],
      })
      await vi.runAllTimersAsync()
      const result = await resultPromise

      expect(result.errorCode).toBe('rate_limited')

      const records = getLlmErrorLog()
      expect(records.length).toBeGreaterThan(0)
      const record = records[records.length - 1]
      expect(record.nodeName).toBe('error-log-http-regression')
      expect(record.model).toBe('gpt-5.4-mini')
      expect(record.httpStatus).toBe(429)
      // デバッグ専用領域には生の応答本文（組織IDを含む文字列）がそのまま入っている
      expect(record.detail).toContain('org-secret-')

      // 一方、呼出元へ返す errorCode には生の応答本文の痕跡が一切含まれない
      // （buildLlmFailureCode 等が短い分類コードのみを組み立てられる、という契約の根拠）。
      expect(result.errorCode).not.toContain('org-secret-')
    })

    it('records connection_failed, timeout, and fetch_failed errors to the debug log', async () => {
      resetLlmErrorLog()
      const timeoutGateway = createAiGateway(settings({ translationProvider: 'openai' }), {
        fetch: async () => { throw new DOMException('The operation timed out.', 'TimeoutError') },
      })
      await timeoutGateway.chatText({ nodeName: 'log-timeout', model: 'gpt-5.4-mini', messages: [{ role: 'user', content: 'x' }] })
      expect(getLlmErrorLog().some((r) => r.nodeName === 'log-timeout' && r.errorCode === 'timeout')).toBe(true)

      const fetchFailedGateway = createAiGateway(settings({ translationProvider: 'openai' }), {
        fetch: async () => { throw new Error('network down') },
      })
      await fetchFailedGateway.chatText({ nodeName: 'log-fetch-failed', model: 'gpt-5.4-mini', messages: [{ role: 'user', content: 'x' }] })
      expect(getLlmErrorLog().some((r) => r.nodeName === 'log-fetch-failed' && r.errorCode === 'fetch_failed')).toBe(true)

      const connectionFailedGateway = createAiGateway({ ...getDefaultAdminSettings(), translationProvider: 'openai', openaiApiKey: '' }, {
        fetch: async () => { throw new Error('should not be called') },
      })
      await connectionFailedGateway.chatText({ nodeName: 'log-connection-failed', model: 'gpt-5.4-mini', messages: [{ role: 'user', content: 'x' }] })
      expect(getLlmErrorLog().some((r) => r.nodeName === 'log-connection-failed' && r.errorCode === 'connection_failed')).toBe(true)
    })

    it('does not record anything to the debug log on a successful response', async () => {
      resetLlmErrorLog()
      const gateway = createAiGateway(settings({ translationProvider: 'openai' }), {
        fetch: async () => new Response(JSON.stringify({
          choices: [{ finish_reason: 'stop', message: { content: 'ok', refusal: null } }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
      })

      await gateway.chatText({ nodeName: 'log-success', model: 'gpt-5.4-mini', messages: [{ role: 'user', content: 'x' }] })

      expect(getLlmErrorLog()).toHaveLength(0)
    })
  })

  describe('paramCompat wiring (非対応パラメータの適応的除去と即時再試行)', () => {
    afterEach(() => {
      resetParamCompat()
      resetLlmErrorLog()
    })

    it('reproduces the hypothesized incident: a 400 with unsupported_value for temperature triggers an immediate retry without temperature, which then succeeds', async () => {
      resetParamCompat()
      const bodies: Array<Record<string, unknown>> = []
      const gateway = createAiGateway(settings({ translationProvider: 'openai' }), {
        fetch: async (_url, init) => {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>
          bodies.push(body)
          if ('temperature' in body) {
            return new Response(JSON.stringify({
              error: { message: "Unsupported value: 'temperature' does not support 0 with this model.", param: 'temperature', code: 'unsupported_value' },
            }), { status: 400, headers: { 'Content-Type': 'application/json' } })
          }
          return new Response(JSON.stringify({
            choices: [{ finish_reason: 'stop', message: { content: 'ok-without-temperature', refusal: null } }],
          }), { status: 200, headers: { 'Content-Type': 'application/json' } })
        },
      })

      // model はあえて gpt-5 / o3 / o4 系以外を使う。この事前抑制リストに載っているモデルは
      // openaiSamplingParams.ts が最初から temperature を送らなくなるため、
      // このテストが検証したい「適応学習（paramCompat）」の経路（事前リストに無いモデル・
      // プロバイダへの保険）を通らなくなってしまう。
      const result = await gateway.chatText({
        nodeName: 'param-compat-regression',
        model: 'gpt-4.1-mini',
        temperature: 0.0,
        messages: [{ role: 'user', content: 'x' }],
      })

      expect(result.content).toBe('ok-without-temperature')
      expect(result.errorCode).toBeUndefined()
      // 1回目は temperature 付きで失敗し、2回目（即時再試行）は temperature 抜きで成功した。
      expect(bodies).toHaveLength(2)
      expect(bodies[0]).toHaveProperty('temperature', 0)
      expect(bodies[1]).not.toHaveProperty('temperature')
    })

    it('sends subsequent requests to the same baseUrl+model without temperature from the very first attempt, once learned', async () => {
      resetParamCompat()
      const bodies: Array<Record<string, unknown>> = []
      let call = 0
      const gateway = createAiGateway(settings({ translationProvider: 'openai' }), {
        fetch: async (_url, init) => {
          call += 1
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>
          bodies.push(body)
          if (call === 1) {
            return new Response(JSON.stringify({
              error: { message: "Unsupported value: 'temperature'", param: 'temperature', code: 'unsupported_value' },
            }), { status: 400, headers: { 'Content-Type': 'application/json' } })
          }
          return new Response(JSON.stringify({
            choices: [{ finish_reason: 'stop', message: { content: 'ok', refusal: null } }],
          }), { status: 200, headers: { 'Content-Type': 'application/json' } })
        },
      })

      // model はあえて gpt-5 / o3 / o4 系以外を使う（上のテストと同じ理由）。
      await gateway.chatText({ nodeName: 'learn-once-1', model: 'gpt-4.1-mini', temperature: 0.0, messages: [{ role: 'user', content: 'x' }] })
      // 学習後の2回目呼出（新規の chatText 呼出）は最初から temperature を送らない
      await gateway.chatText({ nodeName: 'learn-once-2', model: 'gpt-4.1-mini', temperature: 0.0, messages: [{ role: 'user', content: 'x' }] })

      expect(bodies).toHaveLength(3) // 1回目失敗 + 即時再試行成功 + 2回目呼出（学習済みで最初から成功）
      expect(bodies[2]).not.toHaveProperty('temperature')
    })

    it('does not remove a disallowed parameter (e.g. "model") even if the server reports it as unsupported_value', async () => {
      resetParamCompat()
      let callCount = 0
      const gateway = createAiGateway(settings({ translationProvider: 'openai' }), {
        fetch: async () => {
          callCount += 1
          return new Response(JSON.stringify({
            error: { message: 'model is invalid', param: 'model', code: 'unsupported_value' },
          }), { status: 400, headers: { 'Content-Type': 'application/json' } })
        },
      })

      const result = await gateway.chatText({
        nodeName: 'param-compat-disallowed-regression',
        model: 'gpt-5.4-mini',
        messages: [{ role: 'user', content: 'x' }],
      })

      // "model" は許可リスト外なので学習も再試行も行われず、通常の http_error として1回だけ呼ばれる。
      expect(callCount).toBe(1)
      expect(result.errorCode).toBe('http_error')
      expect(result.httpStatus).toBe(400)
    })
  })

  describe('user-defined tokenLimitParam (implementation 4 integration: stripTokenLimitFields must strip whatever name is actually configured)', () => {
    function userApiCompatibilityProfileJson(tokenLimitParam: string): string {
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

    it('strips a custom tokenLimitParam name for the openai provider (the field must not leak into the request body)', async () => {
      const calls: Array<{ init: TauriFetchOptions }> = []
      const gateway = createAiGateway(settings({
        translationProvider: 'openai',
        apiCompatibilityProfilePreset: 'user',
        apiCompatibilityProfileJson: userApiCompatibilityProfileJson('num_predict'),
      }), {
        fetch: async (_url, init) => {
          calls.push({ init: init ?? {} })
          return new Response(JSON.stringify({
            choices: [{ finish_reason: 'stop', message: { content: 'ok', refusal: null } }],
          }), { status: 200, headers: { 'Content-Type': 'application/json' } })
        },
      })

      await gateway.chatText({
        nodeName: 'custom-token-limit-param-openai-regression',
        model: 'gpt-4.1-mini',
        messages: [{ role: 'user', content: 'hello' }],
        maxTokens: 999,
      })

      const body = JSON.parse(String(calls[0].init.body)) as Record<string, unknown>
      expect('num_predict' in body).toBe(false)
      expect('max_tokens' in body).toBe(false)
      expect('max_completion_tokens' in body).toBe(false)
    })

    it('keeps a custom tokenLimitParam name for the local_openai provider (unaffected by the openai/gemini stripping rule)', async () => {
      const calls: Array<{ init: TauriFetchOptions }> = []
      const gateway = createAiGateway(settings({
        translationProvider: 'local_openai',
        openaiCompatibleBaseUrl: 'http://127.0.0.1:1234/v1',
        apiCompatibilityProfilePreset: 'user',
        apiCompatibilityProfileJson: userApiCompatibilityProfileJson('num_predict'),
      }), {
        fetch: async (_url, init) => {
          calls.push({ init: init ?? {} })
          return new Response(JSON.stringify({
            choices: [{ finish_reason: 'stop', message: { content: 'ok', refusal: null } }],
          }), { status: 200, headers: { 'Content-Type': 'application/json' } })
        },
      })

      await gateway.chatText({
        nodeName: 'custom-token-limit-param-local-regression',
        // gemma/qwen プリセットに一致しないモデル名にする: モデルプロファイルが未解決
        // （adaptChatCompletionRequest の早期 return 分岐）でも custom 名が残ることを確認するため。
        model: 'mistral-small',
        messages: [{ role: 'user', content: 'hello' }],
        maxTokens: 999,
      })

      const body = JSON.parse(String(calls[0].init.body)) as Record<string, unknown>
      expect(body.num_predict).toBe(999)
    })
  })
})
