import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultAdminSettings } from '@/api/adminSettings'
import type { AdminSettings } from '@/types/adminSettings'
import { resetLmStudioContextLengthCache } from '@/lib/aiGateway/lmStudioContextLength'
import type { AlignConf, JaBlock } from './blockTypes'
import { translateEn, __testing } from './translateEn'

const { rescuePlainTextTranslation } = __testing

/**
 * 本番事故の再現テスト群。
 *
 * 事故: 72分走ったパイプラインが翻訳ノードで落ち、成果0件で全損した。
 * 原因: ローカルLLM（LM Studio + gemma-4-e4b-it-qat）が JSON ラッパー無しの
 * 素の訳文を返し、parseJsonObjectFromLlmContent が失敗 → リトライ → 1入力まで
 * 縮退した時点で throw → パイプライン全体が死んだ。
 *
 * ここでは translateEn() を fetch のスタブ経由でエンドツーエンドに動かし、
 * 「1ブロックの翻訳が壊れても例外が外へ漏れない」ことを確認する。
 */

function settings(overrides: Partial<AdminSettings> = {}): AdminSettings {
  return {
    ...getDefaultAdminSettings(),
    openaiApiKey: 'sk-test',
    ...overrides,
  }
}

function makeBlock(id: number, jaText: string, overrides: Partial<JaBlock> = {}): JaBlock {
  const alignConf: AlignConf = 'exact'
  return {
    id,
    start: id * 2,
    end: id * 2 + 2,
    jaText,
    jaChars: jaText.length,
    alignConf,
    ...overrides,
  }
}

/** chat/completions の成功レスポンス（content は呼出元が組み立てた文字列をそのまま使う）。 */
function chatResponse(content: string, finishReason = 'stop'): Response {
  return new Response(JSON.stringify({
    choices: [{ finish_reason: finishReason, message: { content, refusal: null } }],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

function jsonChatResponse(payload: unknown): Response {
  return chatResponse(JSON.stringify(payload))
}

/** chat/completions の HTTP エラーレスポンス（401/403/404/500 等）を模す。 */
function httpErrorResponse(status: number, body: unknown = { error: 'error' }): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

interface RecordedCall {
  url: string
  body: Record<string, unknown>
}

/** リクエストボディの最後の user メッセージ（few-shot 例より後）から segments を取り出す。 */
function extractSegments(body: Record<string, unknown>): string[] {
  const messages = body.messages as Array<{ role: string; content: string }>
  const userMessages = messages.filter(m => m.role === 'user')
  const last = userMessages[userMessages.length - 1]
  const parsed = JSON.parse(last.content) as { segments?: string[] }
  return parsed.segments ?? []
}

function stubFetch(handler: (call: RecordedCall) => Response | Promise<Response>): { calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { body?: string }) => {
    const call: RecordedCall = { url: String(url), body: JSON.parse(String(init?.body ?? '{}')) }
    calls.push(call)
    return handler(call)
  }))
  return { calls }
}

afterEach(() => {
  vi.unstubAllGlobals()
  // resolveRuntimeContextLength:true (translateEn.ts) が populate する module-level キャッシュを
  // テスト間で持ち越さない（lmStudioContextLength.ts のコメント参照）。
  resetLmStudioContextLengthCache()
})

describe('rescuePlainTextTranslation（F: JSONラッパー無しの素テキスト救済のヘルパー単体テスト）', () => {
  const EN_TARGET = { label: 'English', script: 'latin' as const }
  const JA_TARGET = { label: 'Japanese', script: 'japanese' as const }

  it('1入力かつ訳文としてターゲット言語の体を成していれば採用する', () => {
    const input = [{ text: '今日は良い天気です。', start: 0, end: 2 }]
    expect(rescuePlainTextTranslation(input, 'The weather is nice today.', EN_TARGET)).toBe(
      'The weather is nice today.',
    )
  })

  it('複数入力では救済しない（対応関係が特定できないため）', () => {
    const inputs = [
      { text: '今日は良い天気です。', start: 0, end: 2 },
      { text: '明日も晴れるでしょう。', start: 2, end: 4 },
    ]
    expect(rescuePlainTextTranslation(inputs, 'The weather is nice today.', EN_TARGET)).toBeUndefined()
  })

  it('空文字は救済しない', () => {
    const input = [{ text: '今日は良い天気です。', start: 0, end: 2 }]
    expect(rescuePlainTextTranslation(input, '   ', EN_TARGET)).toBeUndefined()
  })

  it('{ を含む壊れかけJSONは救済せずリトライへ委ねる', () => {
    const input = [{ text: '今日は良い天気です。', start: 0, end: 2 }]
    expect(rescuePlainTextTranslation(input, '{"translations": ["The weather is nice', EN_TARGET)).toBeUndefined()
  })

  it('"translations" を含む場合も救済しない', () => {
    const input = [{ text: '今日は良い天気です。', start: 0, end: 2 }]
    expect(rescuePlainTextTranslation(input, 'here is "translations" mentioned in prose', EN_TARGET)).toBeUndefined()
  })

  it('ソース言語のまま（未翻訳）なら救済しない', () => {
    const input = [{ text: 'I love this library.', start: 0, end: 2 }]
    expect(rescuePlainTextTranslation(input, 'I love this library.', JA_TARGET)).toBeUndefined()
  })
})

describe('translateEn — F: バッチがJSONラッパー無しの素テキストを返すケースの救済（本番事故の再現）', () => {
  it('1入力に対しJSONラッパー無しの完璧な英訳が返ったら throw せず採用する', async () => {
    const plainTranslation =
      "Based on my review of each domain's current state, many architectures share significant similarities."
    const { calls } = stubFetch(() => chatResponse(plainTranslation))

    const blocks = [makeBlock(1, '各ドメインの現状をレビューしたところ、多くのアーキテクチャに大きな類似点があります。')]
    const result = await translateEn(blocks, settings(), [])

    expect(result).toHaveLength(1)
    expect(result[0].violation).toBe('ok')
    expect(result[0].enText).toBe(plainTranslation)
    expect(result[0].translationFailureReason).toBeUndefined()
    // F で救済されたことの印は専用フィールド translationRescued で表す
    // （translationRetryAttempts は「実際にリトライした回数」専用の意味を持ち、
    //  blockTypes.ts の JSDoc どおり 0 は「初回成功」を意味するため、救済理由での設定はしない）
    expect(result[0].translationRescued).toBe(true)
    expect(result[0].translationRetryAttempts).toBeUndefined()
    // 救済が一発で決まるので、リトライは発生しない
    expect(calls).toHaveLength(1)
  })

  it('通常成功（救済経路を通らない）ブロックには translationRescued が付かない', async () => {
    const { calls } = stubFetch(() => jsonChatResponse({ translations: ['The weather is nice today.'] }))

    const blocks = [makeBlock(1, '今日は良い天気です。', {
      sourceRefs: [{ sourceSegmentId: 4, semanticUnitId: 'u4', relation: 'semantic_unit' }],
    })]
    const result = await translateEn(blocks, settings(), [])

    expect(result).toHaveLength(1)
    expect(result[0].violation).toBe('ok')
    expect(result[0].enText).toBe('The weather is nice today.')
    // 正規の JSON ラッパー経由で成功しているため救済フラグは立たない
    expect(result[0].translationRescued).toBeUndefined()
    expect(result[0].translationRetryAttempts).toBeUndefined()
    expect(result[0].sourceRefs).toEqual([
      { sourceSegmentId: 4, semanticUnitId: 'u4', relation: 'semantic_unit' },
    ])
    expect(calls).toHaveLength(1)
  })

  it('素テキストがソース言語（日本語）のままの場合は救済せず、リトライ経路に進む', async () => {
    // 温度0を想定し、毎回同じ「未翻訳のまま」の応答を返すモデルを模す
    const { calls } = stubFetch(() => chatResponse('これは日本語のままの応答です。'))

    const blocks = [makeBlock(1, '翻訳されるべき原文です。')]
    const result = await translateEn(blocks, settings(), [])

    expect(result).toHaveLength(1)
    // 素テキストがそのまま採用されてはいけない
    expect(result[0].enText).not.toBe('これは日本語のままの応答です。')
    expect(result[0].violation).toBe('untranslated')
    expect(result[0].translationFailureReason).toBeDefined()
    // バッチ1回 + 個別リトライ（PER_BLOCK_RETRY_MAX_ATTEMPTS=2）で複数回呼ばれている
    expect(calls.length).toBeGreaterThan(1)
  })

  it('content が壊れかけJSON（閉じ括弧・クオート欠落）の場合は素テキスト救済せずリトライへ委ねる', async () => {
    // 閉じクオート・閉じ括弧が無いため parseJsonObjectFromLlmContent の修復ヒューリスティックでも
    // 復元できない壊れ方（jsonResponse.test.ts の修復対象とは異なるパターン）
    const brokenJson = '{"translations": ["abc'
    const { calls } = stubFetch(() => chatResponse(brokenJson))

    const blocks = [makeBlock(1, '翻訳されるべき原文です。')]
    const result = await translateEn(blocks, settings(), [])

    expect(result).toHaveLength(1)
    // 素テキストとしてそのまま採用されてはいけない（救済スキップの確認）
    expect(result[0].enText).not.toBe(brokenJson)
    expect(result[0].violation).toBe('untranslated')
    // JSONパース失敗としてリトライ経路に乗ったことが reason から分かる
    expect(result[0].translationFailureReason).toContain('json_parse_failed')
    expect(calls.length).toBeGreaterThan(1)
  })
})

describe('translateEn — G/H: 1ブロックの翻訳失敗でパイプライン全体を落とさない', () => {
  it('全リトライを尽くしても翻訳できない1ブロックは、例外を投げずに translationFailureReason 付きで返る', async () => {
    stubFetch(() => chatResponse('これは日本語のままの応答です。'))

    const blocks = [makeBlock(1, '翻訳されるべき原文です。')]

    const promise = translateEn(blocks, settings(), [])
    await expect(promise).resolves.toBeDefined()
    const result = await promise
    expect(result[0].violation).toBe('untranslated')
    expect(typeof result[0].translationFailureReason).toBe('string')
    // 呼出元との契約（EnBlock）を壊さず、空文字ではなく識別可能な理由込みのテキストが入る
    expect(result[0].enText).toContain('UNTRANSLATED')
    expect(result[0].enText).toContain('翻訳されるべき原文です。')
  })

  it('複数入力バッチの失敗時は従来どおり半分割リトライが働く（既存挙動の非回帰）', async () => {
    const { calls } = stubFetch((call) => {
      const segments = extractSegments(call.body)
      if (segments.length > 1) {
        // わざと1件少ない translations を返し、件数不一致で半割リトライを誘発する
        return jsonChatResponse({ translations: segments.slice(0, segments.length - 1).map((_, i) => `dummy ${i}`) })
      }
      const match = segments[0].match(/文(\d+)です。/)
      const idx = match ? match[1] : '?'
      return jsonChatResponse({ translations: [`Segment ${idx} translated.`] })
    })

    const blocks = [
      makeBlock(0, '文0です。'),
      makeBlock(1, '文1です。'),
      makeBlock(2, '文2です。'),
    ]
    const result = await translateEn(blocks, settings(), [])

    expect(result.map(b => b.enText)).toEqual([
      'Segment 0 translated.',
      'Segment 1 translated.',
      'Segment 2 translated.',
    ])
    expect(result.every(b => b.violation === 'ok')).toBe(true)
    // 3件一括 → 半割 → ... と複数回のリクエストに分かれているはず
    expect(calls.length).toBeGreaterThan(1)
  })
})

describe('translateEn — jsonSchema が chatText へ正しく渡っている', () => {
  it('LM Studio 向けに Structured Outputs (json_schema) の response_format が送られる', async () => {
    const { calls } = stubFetch(() => jsonChatResponse({ translations: ['Hello.'] }))

    const blocks = [makeBlock(1, 'こんにちは。')]
    await translateEn(blocks, settings({
      translationProvider: 'local_openai',
      openaiCompatibleBaseUrl: 'http://127.0.0.1:1234/v1',
      translationModel: 'google/gemma-4-12b',
    }), [])

    // translateEn は resolveRuntimeContextLength:true で chatText を呼ぶため、LM Studio
    // プロファイルでは実コンテキスト長取得 (`/api/v0/models`) が chat/completions の前に
    // 1回挟まる（lmStudioContextLength.ts 参照）。このスタブは全 URL に同じ chat-completion
    // 形状のレスポンスを返すため、そちらの呼出も data 配列を持たず undefined にフォールバックし
    // 実処理には影響しない。
    expect(calls).toHaveLength(2)
    const chatCall = calls[calls.length - 1]
    const responseFormat = chatCall.body.response_format as Record<string, unknown>
    expect(responseFormat.type).toBe('json_schema')
    const jsonSchema = responseFormat.json_schema as Record<string, unknown>
    expect(jsonSchema.name).toBe('translation')
    expect(jsonSchema.strict).toBe(true)
    expect(jsonSchema.schema).toEqual({
      type: 'object',
      properties: { translations: { type: 'array', items: { type: 'string' } } },
      required: ['translations'],
      additionalProperties: false,
    })
    // thinking系モデル対策の出力上限見積り（withReasoningHeadroom）が明示的に指定されている
    expect(typeof chatCall.body.max_tokens).toBe('number')
    expect(chatCall.body.max_tokens).toBeGreaterThan(0)
  })
})

describe('translateEn — OpenAI response_format:json_object の "JSON" 語要件 (公式仕様: system/user いずれかに語 "JSON" が無いと 400)', () => {
  it('OpenAI プロファイルでバッチ翻訳する際、system message に語 "JSON" が含まれる', async () => {
    const { calls } = stubFetch(() => jsonChatResponse({ translations: ['Hello.'] }))

    const blocks = [makeBlock(1, 'こんにちは。')]
    await translateEn(blocks, settings({ translationProvider: 'openai' }), [])

    expect(calls).toHaveLength(1)
    const messages = calls[0].body.messages as Array<{ role: string; content: string }>
    const systemMessage = messages.find(m => m.role === 'system')
    expect(systemMessage?.content).toContain('JSON')
  })
})

describe('translateEn — errorCode に基づく分岐', () => {
  it('errorCode=content_filter は即座にリトライを諦める', async () => {
    const { calls } = stubFetch(() => chatResponse('', 'content_filter'))

    const blocks = [makeBlock(1, '翻訳されるべき原文です。')]
    const result = await translateEn(blocks, settings(), [])

    expect(result[0].violation).toBe('untranslated')
    expect(result[0].translationFailureReason).toContain('content_filter')
    // バッチ1回 + 個別リトライ1回（即諦めのため2回目のリトライは発生しない）
    expect(calls).toHaveLength(2)
  })

  it('errorCode=model_refusal は即座にリトライを諦める', async () => {
    const { calls } = stubFetch(() => new Response(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: '', refusal: 'I cannot help with that.' } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    const blocks = [makeBlock(1, '翻訳されるべき原文です。')]
    const result = await translateEn(blocks, settings(), [])

    expect(result[0].violation).toBe('untranslated')
    expect(result[0].translationFailureReason).toContain('model_refusal')
    expect(calls).toHaveLength(2)
  })

  it('errorCode=truncated は transient 扱いで上限までリトライしてから諦める', async () => {
    const { calls } = stubFetch(() => chatResponse('partial output', 'length'))

    const blocks = [makeBlock(1, '翻訳されるべき原文です。')]
    const result = await translateEn(blocks, settings(), [])

    expect(result[0].violation).toBe('untranslated')
    expect(result[0].translationFailureReason).toContain('truncated_at_length_limit')
    // content_filter/model_refusal と異なり即諦めしないため、個別リトライの上限まで試行する
    // (バッチ1回 + 個別リトライ 2回 = 3回)
    expect(calls).toHaveLength(3)
  })
})

describe('translateEn — context_exceeded (決定的エラー: 盲リトライ禁止の再現テスト)', () => {
  it('単一ブロックの context_exceeded は個別リトライで盲リトライせず1回で諦める', async () => {
    const { calls } = stubFetch(() => httpErrorResponse(400, { error: 'Context size has been exceeded.' }))

    const blocks = [makeBlock(1, '翻訳されるべき原文です。')]
    const result = await translateEn(blocks, settings(), [])

    expect(result[0].violation).toBe('untranslated')
    expect(result[0].translationFailureReason).toContain('context_exceeded')
    // バッチ1回 + 個別リトライ1回（context_exceeded は決定的エラーのため、同一内容での
    // 2回目のリトライは発生しない。ここが本番事故の再発防止ポイント）
    expect(calls).toHaveLength(2)
  })

  it('複数ブロックのバッチで context_exceeded になった場合、同一バッチを盲リトライせず半分に分割して再試行する', async () => {
    const { calls } = stubFetch((call) => {
      const segments = extractSegments(call.body)
      if (segments.length > 1) {
        // バッチのままでは常に context_exceeded（プロンプトが大きすぎる状況を模す）
        return httpErrorResponse(400, { error: 'Context size has been exceeded.' })
      }
      const match = segments[0].match(/文(\d+)です。/)
      const idx = match ? match[1] : '?'
      return jsonChatResponse({ translations: [`Segment ${idx} translated.`] })
    })

    const blocks = [
      makeBlock(0, '文0です。'),
      makeBlock(1, '文1です。'),
      makeBlock(2, '文2です。'),
    ]
    const result = await translateEn(blocks, settings(), [])

    expect(result.map(b => b.enText)).toEqual([
      'Segment 0 translated.',
      'Segment 1 translated.',
      'Segment 2 translated.',
    ])
    expect(result.every(b => b.violation === 'ok')).toBe(true)
    // 分割によって最終的に全件成功する（同一バッチを繰り返し送るだけなら永遠に失敗し続けるはず）
    expect(calls.length).toBeGreaterThan(1)
  })
})

describe('translateEn — 設定起因の致命エラー (HTTP 401/403/404) は fail fast する', () => {
  it.each([401, 403, 404])(
    'HTTP %i が返った場合、空文字へ降格させずに例外が translateEn の呼出元まで伝播する',
    async (status) => {
      stubFetch(() => httpErrorResponse(status))

      const blocks = [makeBlock(1, '翻訳されるべき原文です。')]

      // G/H の catch-all（従来は一時的失敗を空文字へ降格していた経路）に握り潰されず、
      // 呼出元まで例外が届くことを確認する。
      let thrown: unknown
      try {
        await translateEn(blocks, settings(), [])
      } catch (err) {
        thrown = err
      }
      expect(thrown).toBeInstanceOf(Error)
      expect((thrown as Error).message).toContain('non-recoverable')
      expect((thrown as Error).message).toContain(`http_${status}`)
    },
  )

  it('HTTP 429 の insufficient_quota (quota_exhausted) は 401/403/404 と同格の致命エラーとして fail fast する（空文字降格やバックオフを一切しない）', async () => {
    let callCount = 0
    const { calls } = stubFetch(() => {
      callCount += 1
      return httpErrorResponse(429, {
        error: { message: 'You exceeded your current quota, please check your plan and billing details.', type: 'insufficient_quota', code: 'insufficient_quota' },
      })
    })

    const blocks = [makeBlock(1, '翻訳されるべき原文です。')]

    let thrown: unknown
    try {
      await translateEn(blocks, settings(), [])
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toContain('non-recoverable')
    expect((thrown as Error).message).toContain('quota_exhausted')
    // gateway 層のバックオフリトライ（RATE_LIMIT_MAX_ATTEMPTS=6）を経由しないため、
    // バッチの初回呼出のみで即座に fail fast する（複数回リトライして空費しない）。
    expect(calls.length).toBe(1)
    expect(callCount).toBe(1)
  })

  it('HTTP 500 は fatal 扱いせず、従来どおり降格して他バッチの完走を妨げない（fail fast にしすぎていないことの確認）', async () => {
    const goodBlockText = '五つ目です。'
    const { calls } = stubFetch((call) => {
      const segments = extractSegments(call.body)
      if (segments.includes(goodBlockText)) {
        return jsonChatResponse({ translations: segments.map(() => 'Translated five.') })
      }
      // それ以外（未回復バッチの初期呼出・半割再帰・個別リトライ全て）は一律 5xx を返し続け、
      // 「認証エラーではない一時的失敗」を模す。
      return httpErrorResponse(500, { error: 'internal server error' })
    })

    const blocks = [
      makeBlock(0, '一つ目です。'),
      makeBlock(1, '二つ目です。'),
      makeBlock(2, '三つ目です。'),
      makeBlock(3, '四つ目です。'),
      makeBlock(4, goodBlockText),
    ]

    // maxSegmentsPerRequest を 4 に固定する local_openai 設定で、
    // 「1〜3個目のブロックを含むバッチ」と「5個目のブロックのみのバッチ」を
    // 独立した top-level バッチとして分離させる。
    const result = await translateEn(blocks, settings({
      translationProvider: 'local_openai',
      openaiCompatibleBaseUrl: 'http://127.0.0.1:1234/v1',
      translationModel: 'local-model',
    }), [])

    // fail fast にはならず、例外を投げずに resolve する
    expect(result).toHaveLength(5)

    // 500 が続いたブロックは降格し、個別リトライも尽きた上で untranslated として返る
    const failedBlocks = result.filter(b => b.id !== 4)
    expect(failedBlocks).toHaveLength(4)
    for (const block of failedBlocks) {
      expect(block.violation).toBe('untranslated')
    }

    // 500 の影響を受けない別バッチ（5件目）は正常に完走している
    const goodResult = result.find(b => b.id === 4)
    expect(goodResult?.violation).toBe('ok')
    expect(goodResult?.enText).toBe('Translated five.')

    // 半割再帰 + 個別リトライで複数回呼ばれているはず
    expect(calls.length).toBeGreaterThan(1)
  })
})

describe('translateEn — 情報漏洩防止（本番事故の再現: 429応答の生JSON本文が字幕テキストに漏洩していた）', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('[UNTRANSLATED: ...] マーカーにプロバイダの生応答本文（organization 等）が含まれない', async () => {
    // gateway 層のバックオフ付きリトライ（chatText.ts）が内部で複数回・複数秒相当の待機を挟むため、
    // 実時間を消費しないよう fake timers を使う（テスト実行時間を伸ばさない要件）。
    vi.useFakeTimers()
    stubFetch(() => new Response(JSON.stringify({
      error: { message: 'Rate limit reached for gpt-5.4-mini in organization org-fakeTestOrg0' },
    }), { status: 429, headers: { 'Content-Type': 'application/json' } }))

    const blocks = [makeBlock(1, '近年はこうしたものが盛んに利用されています。')]

    const resultPromise = translateEn(blocks, settings(), [])
    await vi.runAllTimersAsync()
    const result = await resultPromise

    expect(result[0].violation).toBe('untranslated')
    // 本番事故: [UNTRANSLATED: attempt_2_http_429: { "error": { "message": "Rate limit reached for
    // gpt-5.4-mini in organization org-fakeTestOrg0] ...} のように生の HTTP エラー応答がそのまま
    // 字幕本文に埋め込まれていた。この回帰を防ぐ。
    expect(result[0].enText).not.toContain('organization')
    expect(result[0].enText).not.toContain('org-fakeTestOrg0')
    expect(result[0].enText).not.toContain('{"error"')
    expect(result[0].enText).not.toContain('{ "error"')
    // マーカー自体は残り、原文も引き続き見える（安全な短い分類コードだけになる）。
    expect(result[0].enText).toContain('UNTRANSLATED')
    expect(result[0].enText).toContain('近年はこうしたものが盛んに利用されています。')
    expect(result[0].translationFailureReason).not.toContain('organization')
  })
})
