import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultAdminSettings } from '@/api/adminSettings'
import type { AdminSettings } from '@/types/adminSettings'
import type { TranscriptSegment } from './types'
import { correctSegments } from './correct'

/**
 * 本番事故の再現テスト群。
 *
 * 事故: 4.2時間のパイプライン実行で書き起こし補正が 333 件中 332 件失敗した。内訳は
 * http_400 (context_size_exceeded) が 260 件。しかも `correctionRetryAttempts` が全件 2
 * ＝「同一内容のまま 2 回試して 2 回とも同じ 400 で失敗」という盲リトライだった。
 * context_exceeded は決定的エラーであり、同一内容の再送では絶対に回復しない。
 * ここでは correctSegments() を fetch のスタブ経由でエンドツーエンドに動かし、
 * 「同一内容を盲リトライせず、複数セグメントなら分割・単一セグメントなら即座に諦める」
 * ことを確認する。
 */

function settings(overrides: Partial<AdminSettings> = {}): AdminSettings {
  return {
    ...getDefaultAdminSettings(),
    translationProvider: 'openai',
    openaiApiKey: 'sk-test',
    ...overrides,
  }
}

function makeSegment(id: number, text: string): TranscriptSegment {
  return { id, start: id * 2, end: id * 2 + 2, text }
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } })
}

/** chat/completions の成功レスポンス（content は呼出元が組み立てた JSON 文字列）。 */
function chatSuccessResponse(content: unknown): Response {
  return jsonResponse({
    choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(content), refusal: null } }],
  })
}

/** LM Studio 等が返す典型的な context_size_exceeded の HTTP 400 レスポンス。 */
function contextExceededResponse(): Response {
  return jsonResponse({ error: 'Context size has been exceeded.' }, 400)
}

interface RecordedCall {
  url: string
  body: Record<string, unknown>
}

/** リクエストボディの最後の user メッセージ（few-shot 例より後）から segments を取り出す。 */
function extractSegments(body: Record<string, unknown>): Array<{ id: number; text: string }> {
  const messages = body.messages as Array<{ role: string; content: string }>
  const userMessages = messages.filter(m => m.role === 'user')
  const last = userMessages[userMessages.length - 1]
  const parsed = JSON.parse(last.content) as { segments?: Array<{ id: number; text: string }> }
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
})

describe('correctSegments — context_exceeded (最重要: 事故の再現テスト)', () => {
  it('単一セグメントで context_exceeded になった場合、同一内容を盲リトライせず1回で諦めて理由を記録する', async () => {
    const { calls } = stubFetch(() => contextExceededResponse())

    const segments = [makeSegment(1, 'テストの文章です。')]
    const result = await correctSegments(segments, {}, settings(), [])

    expect(result).toHaveLength(1)
    // フォールバック: 補正前の原文（normalizeSpaces 済み）がそのまま採用される
    expect(result[0].correctedText).toBe('テストの文章です。')
    // correctionFailureReason はプロバイダの生応答本文を含めない短い分類コードのみを持つ
    // （buildLlmFailureCode 参照。生の HTTP エラー本文をそのまま保持していた旧実装は
    // 組織ID等が漏洩する事故の原因だったため、'context_size_exceeded' という詳細文言ではなく
    // errorCode そのままの 'context_exceeded' になる）。
    expect(result[0].correctionFailureReason).toContain('context_exceeded')
    expect(result[0].correctionRetryAttempts).toBe(1)
    // 最重要の検証: 同一内容を PER_LEAF_RETRY_MAX_ATTEMPTS(2) 回試すのではなく、1回で諦める。
    // (本番事故では correctionRetryAttempts が全件2＝同一内容の盲リトライで2回とも同じ400だった)
    expect(calls).toHaveLength(1)
  })

  it('複数セグメントのバッチで context_exceeded になった場合、同一バッチを盲リトライせず半分に分割して再試行する', async () => {
    const { calls } = stubFetch((call) => {
      const segments = extractSegments(call.body)
      if (segments.length > 1) {
        // バッチのままでは常に context_exceeded（プロンプトが大きすぎる状況を模す）
        return contextExceededResponse()
      }
      // 単一セグメントまで縮退すれば成功する
      return chatSuccessResponse({
        corrections: segments.map((s) => ({ id: s.id, text: `${s.text}(corrected)` })),
      })
    })

    const segments = [0, 1, 2, 3].map((i) => makeSegment(i, `文${i}です。`))
    const result = await correctSegments(segments, {}, settings(), [])

    expect(result.map((r) => r.correctedText)).toEqual([
      '文0です。(corrected)',
      '文1です。(corrected)',
      '文2です。(corrected)',
      '文3です。(corrected)',
    ])
    expect(result.every((r) => r.correctionFailureReason === undefined)).toBe(true)
    // 4件バッチ(1回失敗) → 2件×2(それぞれ1回失敗) → 1件×4(それぞれ1回で成功) = 7 コール。
    // バッチサイズを変えずに同一内容を繰り返し送っていたら永遠に失敗し続けるはずの状況で、
    // 分割によって最終的に全件成功することを確認する。
    expect(calls).toHaveLength(7)
  })

  it('単一セグメントまで分割しても context_exceeded が続く場合はそれ以上分割できないため諦める', async () => {
    const { calls } = stubFetch(() => contextExceededResponse())

    const segments = [0, 1].map((i) => makeSegment(i, `長い文章${i}です。`))
    const result = await correctSegments(segments, {}, settings(), [])

    expect(result.every((r) => r.correctionFailureReason?.includes('context_exceeded'))).toBe(true)
    expect(result.every((r) => r.correctionRetryAttempts === 1)).toBe(true)
    // 2件バッチ(1回失敗) → 1件×2(それぞれ1回で諦め、盲リトライしない) = 3 コール
    // （盲リトライしていれば 2 + 2*2 = 6 コールになるはず）。
    expect(calls).toHaveLength(3)
  })
})

describe('correctSegments — quota_exhausted (HTTP 429 insufficient_quota) は 401/403/404 と同格の致命エラーとして即座に諦める', () => {
  function quotaExhaustedResponse(): Response {
    return jsonResponse({
      error: { message: 'You exceeded your current quota, please check your plan and billing details.', type: 'insufficient_quota', code: 'insufficient_quota' },
    }, 429)
  }

  it('単一セグメントで quota_exhausted になった場合、盲リトライせず1回で諦めて理由を記録する', async () => {
    const { calls } = stubFetch(() => quotaExhaustedResponse())

    const segments = [makeSegment(1, 'テストの文章です。')]
    const result = await correctSegments(segments, {}, settings(), [])

    expect(result).toHaveLength(1)
    expect(result[0].correctedText).toBe('テストの文章です。')
    expect(result[0].correctionFailureReason).toContain('quota_exhausted')
    expect(result[0].correctionRetryAttempts).toBe(1)
    // content_filter/refusal と同様、abortable 経路に乗るためリトライは一切発生しない。
    expect(calls).toHaveLength(1)
  })

  it('複数セグメントのバッチで quota_exhausted になった場合も、バッチ全体が即座に諦める（各セグメントへの分割リトライをしない）', async () => {
    const { calls } = stubFetch(() => quotaExhaustedResponse())

    const segments = [0, 1].map((i) => makeSegment(i, `長い文章${i}です。`))
    const result = await correctSegments(segments, {}, settings(), [])

    expect(result.every((r) => r.correctionFailureReason?.includes('quota_exhausted'))).toBe(true)
    // abortable 判定はバッチ分割より前に効くため、半割リトライへは進まず1コールのみで終わる。
    expect(calls).toHaveLength(1)
  })
})

describe('correctSegments — context_exceeded 以外のエラーは既存の挙動を維持する（回帰防止）', () => {
  it('一時的な HTTP 500 は従来どおり単一セグメントで PER_LEAF_RETRY_MAX_ATTEMPTS 回まで同一内容をリトライする', async () => {
    const { calls } = stubFetch(() => jsonResponse({ error: 'internal server error' }, 500))

    const segments = [makeSegment(1, 'テストの文章です。')]
    const result = await correctSegments(segments, {}, settings(), [])

    expect(result[0].correctionFailureReason).toBeDefined()
    expect(result[0].correctionFailureReason).not.toContain('context_size_exceeded')
    expect(result[0].correctionRetryAttempts).toBe(2)
    expect(calls).toHaveLength(2)
  })

  it('正常応答時は成功として補正済みテキストを返す（サニティチェック）', async () => {
    stubFetch((call) => {
      const segments = extractSegments(call.body)
      return chatSuccessResponse({
        corrections: segments.map((s) => ({ id: s.id, text: `${s.text}(corrected)` })),
      })
    })

    const segments = [makeSegment(1, 'テストの文章です。')]
    const result = await correctSegments(segments, {}, settings(), [])

    expect(result[0].correctedText).toBe('テストの文章です。(corrected)')
    expect(result[0].correctionFailureReason).toBeUndefined()
    expect(result[0].correctionRetryAttempts).toBe(1)
  })
})
