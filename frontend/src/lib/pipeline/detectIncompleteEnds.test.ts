import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultAdminSettings } from '@/api/adminSettings'
import type { AdminSettings } from '@/types/adminSettings'
import { detectIncompleteEnds } from './detectIncompleteEnds'

/**
 * detectIncompleteEnds は llmCallWithMeta 経由で createAiGateway(settings).chatText() を呼び、
 * 最終的に tauriFetch → ブラウザ/Node の native fetch に到達する（isTauri() が false の場合）。
 * llmCallWithMeta 自体は fetch 差し替えの口を持たないため、chatText.test.ts に倣い
 * リクエスト/レスポンスの実体（global fetch）をスタブして、gateway 層を含めた一気通貫で検証する。
 */

interface ChatCompletionRequestBody {
  model: string
  messages: Array<{ role: string; content: string }>
  temperature?: number
  max_tokens?: number
  max_completion_tokens?: number
  response_format?: unknown
}

interface BatchRequestItem {
  i: number
  t: string
}

type FetchHandler = (body: ChatCompletionRequestBody) => Response

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } })
}

function batchItemsFromRequestBody(body: ChatCompletionRequestBody): BatchRequestItem[] {
  const userMessage = body.messages[body.messages.length - 1]
  return JSON.parse(userMessage.content) as BatchRequestItem[]
}

/**
 * システムプロンプトおよび languageProfileConfig.ts の DEFAULT_LANGUAGE_PROFILE_CONFIG.transcript と
 * 同じ基準（文末が全角句点/感嘆符/疑問符、または半角 !? で終わっていなければ未完結）で機械的に応答する既定ハンドラ。
 * ！(！) ？(？) はソースファイルのエンコーディング事故を避けるためコードポイントで明示する。
 */
const SENTENCE_END_PATTERN = /[。！？!?]$/
const echoHandler: FetchHandler = (body) => {
  const items = batchItemsFromRequestBody(body)
  const r = items.map(({ i, t }) => ({ i, x: !SENTENCE_END_PATTERN.test(t.trim()) }))
  return jsonResponse({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ r }), refusal: null } }] })
}

const truncatedHandler: FetchHandler = () =>
  jsonResponse({ choices: [{ finish_reason: 'length', message: { content: 'partial', refusal: null } }] })

/** HTTP 400 + context_size_exceeded 相当の本文。errors.ts の classifyHttpErrorCode 参照。 */
const contextExceededHandler: FetchHandler = () =>
  jsonResponse({ error: 'Context size has been exceeded.' }, 400)

const contentFilterHandler: FetchHandler = () =>
  jsonResponse({ choices: [{ finish_reason: 'content_filter', message: { content: '', refusal: null } }] })

function httpErrorHandler(status: number): FetchHandler {
  return () => jsonResponse({ error: 'unauthorized' }, status)
}

/** HTTP 429 + insufficient_quota 相当の本文。errors.ts の isInsufficientQuotaHttpError 参照。 */
const quotaExhaustedHandler: FetchHandler = () =>
  jsonResponse({
    error: { message: 'You exceeded your current quota, please check your plan and billing details.', type: 'insufficient_quota', code: 'insufficient_quota' },
  }, 429)

/** fetch 実行中の例外（一時的なネットワーク断）を模す。connection_failed とは区別される。 */
const networkThrowHandler: FetchHandler = () => { throw new Error('network down') }

function createGatewayFetchMock(options: { queue?: FetchHandler[]; fallback?: FetchHandler } = {}): {
  fn: (url: string, init?: { body?: string }) => Promise<Response>
  calls: Array<{ url: string; body: ChatCompletionRequestBody }>
} {
  const calls: Array<{ url: string; body: ChatCompletionRequestBody }> = []
  const queue = [...(options.queue ?? [])]
  const fallback = options.fallback ?? echoHandler
  const fn = vi.fn(async (url: string, init?: { body?: string }) => {
    const body = init?.body ? (JSON.parse(init.body) as ChatCompletionRequestBody) : ({} as ChatCompletionRequestBody)
    calls.push({ url, body })
    const handler = queue.shift() ?? fallback
    return handler(body)
  })
  return { fn, calls }
}

function settings(overrides: Partial<AdminSettings> = {}): AdminSettings {
  return {
    ...getDefaultAdminSettings(),
    translationProvider: 'openai',
    openaiApiKey: 'sk-test',
    apiRequestConcurrency: 4,
    ...overrides,
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('detectIncompleteEnds', () => {
  it('splits the batch in half when the gateway reports errorCode=truncated (regression: the old string-equality branch never fired)', async () => {
    const texts = ['一つ目の文。', '二つ目の文。', '三つ目の文。', '四つ目の文。']
    const { fn, calls } = createGatewayFetchMock({ queue: [truncatedHandler] })
    vi.stubGlobal('fetch', fn)

    const result = await detectIncompleteEnds(texts, settings({ incompleteEndDetectionBatchSize: 4 }))

    // 1回目: 4件バッチが truncated。2・3回目: 半割された2件ずつのバッチが成功。
    expect(calls).toHaveLength(3)
    const splitSizes = calls.slice(1).map(c => batchItemsFromRequestBody(c.body).length).sort()
    expect(splitSizes).toEqual([2, 2])
    expect(result.success).toBe(4)
    expect(result.failed).toBe(0)
    expect(result.flags).toEqual([false, false, false, false])
  })

  it('splits the batch in half when the gateway reports errorCode=context_exceeded (same split-then-retry treatment as truncated)', async () => {
    const texts = ['一つ目の文。', '二つ目の文。', '三つ目の文。', '四つ目の文。']
    const { fn, calls } = createGatewayFetchMock({ queue: [contextExceededHandler] })
    vi.stubGlobal('fetch', fn)

    const result = await detectIncompleteEnds(texts, settings({ incompleteEndDetectionBatchSize: 4 }))

    // 1回目: 4件バッチが context_exceeded（決定的エラーだが、バッチを半分に割ればプロンプトが
    // 縮むため truncated と同じ分割トリガーとして扱われる）。2・3回目: 半割された2件ずつが成功。
    expect(calls).toHaveLength(3)
    const splitSizes = calls.slice(1).map(c => batchItemsFromRequestBody(c.body).length).sort()
    expect(splitSizes).toEqual([2, 2])
    expect(result.success).toBe(4)
    expect(result.failed).toBe(0)
    expect(result.flags).toEqual([false, false, false, false])
  })

  it('does not recurse past MAX_TRUNCATION_SPLIT_DEPTH and gives up with the deterministic fallback', async () => {
    const texts = ['一つ目の文。', '二つ目の文。', '三つ目の文。', '四つ目の文。']
    const { fn, calls } = createGatewayFetchMock({ fallback: truncatedHandler })
    vi.stubGlobal('fetch', fn)

    const result = await detectIncompleteEnds(texts, settings({ incompleteEndDetectionBatchSize: 4 }))

    // depth0: 4件 x1 → depth1: 2件 x2 → depth2: 1件 x4 で打ち止め（depth3 は発生しない）= 7 コール
    expect(calls).toHaveLength(7)
    expect(result.success).toBe(0)
    expect(result.failed).toBe(4)
    expect(result.deterministicFallbackCount).toBe(4)
    // 全て「。」終わりなので決定的フォールバックでも incomplete=false
    expect(result.flags).toEqual([false, false, false, false])
  })

  it('aborts immediately on a config-origin failure (HTTP 401) and never calls the remaining batches', async () => {
    const texts = ['一つ目。', '二つ目。', '三つ目。', '四つ目。', '五つ目。', '六つ目。']
    const { fn, calls } = createGatewayFetchMock({
      queue: [httpErrorHandler(401)],
      fallback: () => { throw new Error('remaining batches must not be called after a config_error abort') },
    })
    vi.stubGlobal('fetch', fn)

    const result = await detectIncompleteEnds(
      texts,
      settings({ incompleteEndDetectionBatchSize: 3, apiRequestConcurrency: 3 }),
    )

    expect(calls).toHaveLength(1)
    expect(result.abortReason).toBeDefined()
    expect(result.abortReason).toContain('401')
    expect(result.failed).toBe(6)
  })

  it('aborts immediately on quota_exhausted (HTTP 429 insufficient_quota) and never calls the remaining batches or retries with backoff', async () => {
    const texts = ['一つ目。', '二つ目。', '三つ目。', '四つ目。', '五つ目。', '六つ目。']
    const { fn, calls } = createGatewayFetchMock({
      queue: [quotaExhaustedHandler],
      fallback: () => { throw new Error('remaining batches must not be called after a config_error abort') },
    })
    vi.stubGlobal('fetch', fn)

    const result = await detectIncompleteEnds(
      texts,
      settings({ incompleteEndDetectionBatchSize: 3, apiRequestConcurrency: 3 }),
    )

    // config_error と同格の早期 abort のため、gateway 層のバックオフリトライを一切経由せず
    // 1コールのみで即座に終わる（rate_limited であれば RATE_LIMIT_MAX_ATTEMPTS 回リトライするはず）。
    expect(calls).toHaveLength(1)
    expect(result.abortReason).toBeDefined()
    expect(result.abortReason).toContain('quota_exhausted')
    // buildLlmFailureCode() の短い分類コードのみで、プロバイダの生応答本文（billing 文言等）は含まない。
    expect(result.abortReason).not.toContain('billing')
    expect(result.failed).toBe(6)
  })

  it('aborts immediately on connection_failed (missing API key) and never calls fetch at all', async () => {
    const texts = ['一つ目。', '二つ目。', '三つ目。', '四つ目。', '五つ目。', '六つ目。']
    const { fn, calls } = createGatewayFetchMock({
      fallback: () => { throw new Error('fetch must not be called when connection resolution itself fails') },
    })
    vi.stubGlobal('fetch', fn)

    const result = await detectIncompleteEnds(
      texts,
      // openaiApiKey を空にすることで、fetch 発行前の requireGatewayConnection 段階で
      // errorCode='connection_failed' を発生させる（HTTP 401 とは異なる abort 経路）。
      settings({ openaiApiKey: '', incompleteEndDetectionBatchSize: 3, apiRequestConcurrency: 3 }),
    )

    // 接続情報の解決自体に失敗しているため、そもそも fetch は一度も呼ばれない。
    expect(calls).toHaveLength(0)
    expect(result.abortReason).toBeDefined()
    expect(result.failed).toBe(6)
  })

  it('does not abort early on a transient fetch failure (errorCode=fetch_failed) and continues to remaining batches', async () => {
    const texts = ['一つ目。', '二つ目。', '三つ目。', '四つ目。', '五つ目。', '六つ目。']
    // 最初の 1 コールだけ fetch が throw する（一時的なネットワーク断を模す）。
    // それ以外（リトライおよび 2 バッチ目）は echoHandler で正常応答する。
    const { fn, calls } = createGatewayFetchMock({ queue: [networkThrowHandler] })
    vi.stubGlobal('fetch', fn)

    const result = await detectIncompleteEnds(
      texts,
      settings({ incompleteEndDetectionBatchSize: 3, apiRequestConcurrency: 3 }),
    )

    // 1コール目: throw → fetch_failed → retryable。2コール目: 同一バッチのリトライが成功。
    // 3コール目: 2バッチ目（config_error による早期 abort であれば発行されないはずのコール）。
    expect(calls).toHaveLength(3)
    expect(result.success).toBe(6)
    expect(result.failed).toBe(0)
    expect(result.abortReason).toBeUndefined()
    expect(result.flags).toEqual([false, false, false, false, false, false])
  })

  it('falls back to the deterministic sentence-end check when the LLM call is abortable, flagging a comma-ending fragment as incomplete', async () => {
    const texts = ['今日はとても天気が良くて、', '公園へ散歩に行きました。']
    const { fn } = createGatewayFetchMock({ fallback: contentFilterHandler })
    vi.stubGlobal('fetch', fn)

    const result = await detectIncompleteEnds(texts, settings({ incompleteEndDetectionBatchSize: 2 }))

    expect(result.flags).toEqual([true, false])
    expect(result.failed).toBe(2)
    expect(result.deterministicFallbackCount).toBe(2)
    // content_filter は abortable であり config_error ではないため、全体 abort はしない
    expect(result.abortReason).toBeUndefined()
  })

  it('never throws when languageProfileConfigJson contains an invalid regex, and defaults to incomplete=true', async () => {
    const texts = ['文章の断片']
    const { fn } = createGatewayFetchMock({ fallback: contentFilterHandler })
    vi.stubGlobal('fetch', fn)

    const invalidRegexProfileJson = JSON.stringify({
      transcript: { label: 'Japanese', script: 'japanese', sentenceEndPattern: '[', continuationEndPattern: '(' },
    })

    await expect(detectIncompleteEnds(texts, settings({
      incompleteEndDetectionBatchSize: 1,
      languageProfileConfigJson: invalidRegexProfileJson,
    }))).resolves.toMatchObject({ flags: [true], failed: 1, deterministicFallbackCount: 1 })
  })

  it('never throws when languageProfileConfigJson itself is invalid JSON', async () => {
    const texts = ['文章の断片']
    const { fn } = createGatewayFetchMock({ fallback: contentFilterHandler })
    vi.stubGlobal('fetch', fn)

    await expect(detectIncompleteEnds(texts, settings({
      incompleteEndDetectionBatchSize: 1,
      languageProfileConfigJson: '{ not valid json',
    }))).resolves.toMatchObject({ failed: 1, deterministicFallbackCount: 1 })
  })

  it('sends Structured Outputs jsonSchema and an explicit maxTokens on every batch request', async () => {
    const texts = ['一つ目。', '二つ目。', '三つ目。']
    const { fn, calls } = createGatewayFetchMock()
    vi.stubGlobal('fetch', fn)

    await detectIncompleteEnds(texts, settings({
      translationProvider: 'local_openai',
      openaiCompatibleBaseUrl: 'http://127.0.0.1:1234/v1',
      incompleteEndDetectionModel: 'local-detector-model',
      incompleteEndDetectionBatchSize: 3,
    }))

    expect(calls).toHaveLength(1)
    const body = calls[0].body
    expect(body.response_format).toEqual({
      type: 'json_schema',
      json_schema: {
        name: 'detect_incomplete_ends',
        strict: true,
        schema: expect.objectContaining({ type: 'object', required: ['r'] }),
      },
    })
    // 3件 * 12 + 16 = 52。ローカル汎用モデル名（gemma/qwen を含まない）なので
    // reasoning headroom の倍率はかからず、見積もり値がそのまま maxTokens になる。
    expect(body.max_tokens).toBe(52)
  })

  it('preserves the length and order of the input texts in the output flags across multiple concurrent batches', async () => {
    const texts = Array.from({ length: 9 }, (_, i) => (i % 2 === 0 ? `文${i}。` : `文${i}、`))
    const { fn } = createGatewayFetchMock()
    vi.stubGlobal('fetch', fn)

    const result = await detectIncompleteEnds(texts, settings({ incompleteEndDetectionBatchSize: 4, apiRequestConcurrency: 2 }))

    expect(result.flags).toHaveLength(texts.length)
    expect(result.flags).toEqual(texts.map(t => !SENTENCE_END_PATTERN.test(t.trim())))
    expect(result.success).toBe(texts.length)
    expect(result.failed).toBe(0)
  })

  it('clamps the batch size to 8 for thinking-capable model profiles instead of using the configured batch size', async () => {
    const texts = Array.from({ length: 20 }, (_, i) => `文${i}。`)
    const { fn, calls } = createGatewayFetchMock()
    vi.stubGlobal('fetch', fn)

    await detectIncompleteEnds(texts, settings({
      chatTextProfilePreset: 'gemma',
      incompleteEndDetectionBatchSize: 30,
      apiRequestConcurrency: 3,
    }))

    const batchSizes = calls.map(c => batchItemsFromRequestBody(c.body).length).sort((a, b) => b - a)
    expect(batchSizes).toEqual([8, 8, 4])
    expect(batchSizes.every(n => n <= 8)).toBe(true)
  })
})
