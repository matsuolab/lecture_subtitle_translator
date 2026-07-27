import { normalizeChatCompletionContent, resolveModelProfile } from '@/lib/pipeline/modelProfile'
import { beginLlmCall } from './llmActivity'
import { acquireLlmSlot, reportLlmCallSucceeded, reportLlmRateLimitEncountered } from './llmConcurrency'
import type { AiGatewayContext } from './connection'
import { requireGatewayConnection } from './connection'
import type { ChatTextResult } from './chatText'
import {
  applyChatRequestDialect,
  type JsonSchemaSpec,
  resolveApiCompatibilityProfile,
  resolveChatResponseFormatForDialect,
} from './apiCompatibilityProfile'
import { classifyHttpErrorCode, formatAiGatewayHttpError } from './errors'
import { getCurrentPipelineAbortSignal } from '@/lib/pipeline/pipelineAbort'
import { isTimeoutError } from './timeoutError'
import { RATE_LIMIT_MAX_ATTEMPTS, delayRespectingAbort, resolveRateLimitDelayMs } from './rateLimitRetry'
import { pushLlmError } from './llmErrorLog'
import { learnUnsupportedParam, stripLearnedUnsupportedParams } from './paramCompat'
import { shouldSuppressOpenAiSamplingParams, stripOpenAiSamplingParams } from './openaiSamplingParams'

export type ChatVisionContent = string | Array<
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' | 'auto' } }
>

export interface ChatVisionMessage {
  role: string
  content: ChatVisionContent
}

export interface ChatVisionOptions {
  nodeName: string
  model: string
  messages: ChatVisionMessage[]
  maxTokens?: number
  temperature?: number
  responseFormat?: 'json_object' | 'text' | 'omit'
  /**
   * Structured Outputs 用の JSON Schema。指定するとプロファイル解決を優先する
   * （json_schema 非対応プロファイルでは自動的に json_object / text へフォールバックする）。
   */
  jsonSchema?: JsonSchemaSpec
}

export async function chatVision(
  context: AiGatewayContext,
  options: ChatVisionOptions,
): Promise<ChatTextResult> {
  const connection = (() => {
    try {
      return requireGatewayConnection(context, options.nodeName)
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) } as const
    }
  })()
  // 接続情報の解決自体に失敗したケース（API key 未設定など、実際に fetch すら発行していない設定不備）。
  // 一時的なネットワーク断で発生する fetch_failed とは原因も対処も異なるため別の errorCode で区別する
  // （chatText.ts の同じ分岐を参照。両者を同一コードに統一していたことによる退行の経緯もそちらに記載）。
  if ('error' in connection) {
    pushLlmError({ nodeName: options.nodeName, model: options.model, errorCode: 'connection_failed', detail: connection.error })
    return { content: '', errorMessage: `connection_failed: ${connection.error}`, errorCode: 'connection_failed' }
  }

  let body: Record<string, unknown> = {
    model: options.model,
    messages: options.messages,
  }
  if (typeof options.temperature === 'number') body.temperature = options.temperature
  const apiCompatibilityProfile = resolveApiCompatibilityProfile(context.settings)
  // 事前抑制: chatText.ts の同じ分岐・openaiSamplingParams.ts の JSDoc 参照。
  if (shouldSuppressOpenAiSamplingParams(apiCompatibilityProfile, options.model)) {
    body = stripOpenAiSamplingParams(body)
  }
  body = applyChatRequestDialect(body, apiCompatibilityProfile, { maxOutputTokens: options.maxTokens })
  // jsonSchema が指定されている場合は responseFormat: 'omit' より優先する（chatText.ts の同じ
  // 分岐を参照。'omit' と jsonSchema が同時指定されてもスキーマが黙って消えないようにするため）。
  if (options.jsonSchema || options.responseFormat !== 'omit') {
    const dialectFormat = resolveChatResponseFormatForDialect(apiCompatibilityProfile, options.jsonSchema)
    // jsonSchema が指定されていればプロファイル解決を優先する（スキーマ非対応プロファイルでは
    // 自動的に json_object / text へ落ちる）。未指定なら従来どおり呼出元の明示指定を尊重する。
    const explicit = options.responseFormat === 'json_object' || options.responseFormat === 'text'
      ? { type: options.responseFormat }
      : undefined
    const responseFormat = options.jsonSchema ? dialectFormat : (explicit ?? dialectFormat)
    if (responseFormat) body.response_format = responseFormat
  }
  const profile = resolveModelProfile(context.settings, options.model, 'chatVision')

  // これまでに学習済みの非対応パラメータ（paramCompat.ts）を事前に除去する（chatText.ts の
  // 同じ分岐・paramCompat.ts の JSDoc 参照）。
  body = stripLearnedUnsupportedParams(connection.baseUrl, options.model, body)
  // HTTP 400 + 非対応パラメータ検知時、同一リクエストからそのパラメータを外して1回だけ即時
  // 再試行するためのフラグ（chatText.ts の同じ分岐を参照）。
  let paramRetryUsed = false

  let payload: Record<string, unknown>

  // レート制限（429）・サーバ過負荷（503/529）をバックオフ付きで自動リトライするループ。
  // 役割・デッドロック回避の理由は chatText.ts の同じループを参照。
  for (let attempt = 1; ; attempt += 1) {
    // gateway 層の全体同時実行数セマフォ。役割は chatText.ts の同じ分岐（llmConcurrency.ts の
    // コメント）を参照。デッドロックしない理由も同所を参照。
    const releaseLlmSlot = await acquireLlmSlot()
    let response: Awaited<ReturnType<AiGatewayContext['fetch']>>
    // beginLlmCall/endLlmCall の役割は chatText.ts の同じ分岐を参照。fetch 呼び出し全体を
    // try/finally で囲み、どの経路で終わっても endLlmCall / releaseLlmSlot が必ず呼ばれるようにする。
    const endLlmCall = beginLlmCall()
    try {
      response = await context.fetch(`${connection.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(connection.apiKey ? { Authorization: `Bearer ${connection.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        timeoutMs: context.settings.llmRequestTimeoutSec * 1000,
        // 中断シグナル。ブラウザ経路では実際に接続が切れるが、Tauri 経路では無視される
        // （tauriFetch のコメント参照。Rust 側にあるのはタイムアウトでキャンセルではない）。
        // そのため中断は「新しい処理を始めない」協調的キャンセルで担保している。
        signal: getCurrentPipelineAbortSignal() ?? undefined,
      })
    } catch (err) {
      // タイムアウト由来の失敗は fetch_failed とは別の errorCode で区別する（chatText.ts の同じ分岐を参照）。
      if (isTimeoutError(err)) {
        const detail = err instanceof Error ? err.message : String(err)
        pushLlmError({ nodeName: options.nodeName, model: options.model, errorCode: 'timeout', detail })
        return { content: '', errorMessage: `request_timeout: ${detail}`, errorCode: 'timeout' }
      }
      const detail = err instanceof Error ? err.message : String(err)
      pushLlmError({ nodeName: options.nodeName, model: options.model, errorCode: 'fetch_failed', detail })
      return { content: '', errorMessage: `fetch_failed: ${detail}`, errorCode: 'fetch_failed' }
    } finally {
      endLlmCall()
      // 重要: バックオフ待機に入る「前」に必ずスロットを解放する（chatText.ts の同じ分岐・
      // rateLimitRetry.ts のコメント参照。デッドロック事故の再発防止）。
      releaseLlmSlot()
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      const errorCode = classifyHttpErrorCode(response.status, detail)
      // デバッグ専用領域（llmErrorLog.ts）へ生応答本文を記録する（chatText.ts の同じ分岐を参照）。
      pushLlmError({ nodeName: options.nodeName, model: options.model, httpStatus: response.status, errorCode, detail })

      // 非対応パラメータの適応的除去（paramCompat.ts）。chatText.ts の同じ分岐を参照。
      if (response.status === 400 && !paramRetryUsed) {
        const learnedParam = learnUnsupportedParam(connection.baseUrl, options.model, detail)
        if (learnedParam && learnedParam in body) {
          paramRetryUsed = true
          const nextBody = { ...body }
          delete nextBody[learnedParam]
          body = nextBody
          pushLlmError({
            nodeName: options.nodeName,
            model: options.model,
            httpStatus: response.status,
            errorCode: 'param_compat_retry',
            detail: `removed unsupported parameter "${learnedParam}" learned from a 400 response and retrying once`,
          })
          continue
        }
      }
      // quota_exhausted（HTTP 429 のうち insufficient_quota）はここに乗らず下の return へ直行する。
      // 課金設定を直さない限り絶対に回復しない決定的エラーのため（chatText.ts の同じ分岐・
      // errors.ts の classifyHttpErrorCode 参照）。
      if (errorCode === 'rate_limited') {
        reportLlmRateLimitEncountered()
        const abortSignal = getCurrentPipelineAbortSignal()
        if (attempt < RATE_LIMIT_MAX_ATTEMPTS && !abortSignal?.aborted) {
          const delayMs = resolveRateLimitDelayMs(response, attempt)
          await delayRespectingAbort(delayMs, abortSignal)
          if (!abortSignal?.aborted) continue
        }
      }
      return { content: '', httpStatus: response.status, errorMessage: formatAiGatewayHttpError({ context, status: response.status, detail }), errorCode }
    }

    reportLlmCallSucceeded()

    try {
      payload = await response.json() as Record<string, unknown>
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      pushLlmError({ nodeName: options.nodeName, model: options.model, errorCode: 'response_json_parse_failed', detail })
      return { content: '', errorMessage: `response_json_parse_failed: ${detail}`, errorCode: 'response_json_parse_failed' }
    }
    break
  }

  const choices = Array.isArray(payload.choices) ? payload.choices : []
  const firstChoice = choices[0] as Record<string, unknown> | undefined
  const finishReason = typeof firstChoice?.finish_reason === 'string' ? firstChoice.finish_reason : undefined
  const message = firstChoice?.message as Record<string, unknown> | undefined
  const refusal = typeof message?.refusal === 'string' ? message.refusal : null
  const rawContent = typeof message?.content === 'string' ? message.content : ''
  const content = normalizeChatCompletionContent(rawContent, profile)

  if (finishReason === 'content_filter') {
    pushLlmError({ nodeName: options.nodeName, model: options.model, errorCode: 'content_filter', detail: 'content_filter' })
    return { content: '', finishReason, refusal, errorMessage: 'content_filter', errorCode: 'content_filter' }
  }
  if (refusal) {
    pushLlmError({ nodeName: options.nodeName, model: options.model, errorCode: 'model_refusal', detail: refusal })
    return { content: '', finishReason, refusal, errorMessage: `model_refusal: ${refusal.slice(0, 200)}`, errorCode: 'model_refusal' }
  }
  if (finishReason === 'length') {
    pushLlmError({ nodeName: options.nodeName, model: options.model, errorCode: 'truncated', detail: `content_preview=${content}` })
    return { content, finishReason, errorMessage: `truncated_at_length_limit (content_preview=${content.slice(0, 100)})`, errorCode: 'truncated' }
  }
  if (!content.trim()) {
    pushLlmError({ nodeName: options.nodeName, model: options.model, errorCode: 'empty_response', detail: `payload_keys=${Object.keys(payload).join(',')}` })
    return { content: '', finishReason, errorMessage: `empty_response (payload_keys=${Object.keys(payload).join(',')})`, errorCode: 'empty_response' }
  }
  return { content, finishReason, refusal }
}
