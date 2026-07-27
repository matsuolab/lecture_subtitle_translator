import { beginLlmCall } from './llmActivity'
import { acquireLlmSlot, reportLlmCallSucceeded, reportLlmRateLimitEncountered } from './llmConcurrency'
import type { AiGatewayContext } from './connection'
import { requireGatewayConnection } from './connection'
import { getCurrentPipelineAbortSignal } from '@/lib/pipeline/pipelineAbort'
import { classifyHttpErrorCode } from './errors'
import { RATE_LIMIT_MAX_ATTEMPTS, delayRespectingAbort, resolveRateLimitDelayMs } from './rateLimitRetry'
import { pushLlmError } from './llmErrorLog'
import { isTimeoutError } from './timeoutError'

interface EmbeddingResponse {
  data?: Array<{ embedding?: number[] }>
}

export interface EmbeddingsOptions {
  nodeName?: string
  model: string
  input: string[]
}

export async function embeddings(
  context: AiGatewayContext,
  options: EmbeddingsOptions,
): Promise<number[][] | null> {
  if (options.input.length === 0) return []
  const nodeName = options.nodeName ?? 'embeddings'
  const connection = (() => {
    try {
      return requireGatewayConnection(context, nodeName)
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })()
  if ('error' in connection) {
    pushLlmError({ nodeName, model: options.model, errorCode: 'connection_failed', detail: connection.error })
    return null
  }

  // レート制限（429）・サーバ過負荷（503/529）をバックオフ付きで自動リトライするループ。
  // 役割・デッドロック回避の理由は chatText.ts の同じループを参照。
  for (let attempt = 1; ; attempt += 1) {
    // gateway 層の全体同時実行数セマフォ。役割は chatText.ts の同じ分岐（llmConcurrency.ts の
    // コメント）を参照。デッドロックしない理由も同所を参照。
    const releaseLlmSlot = await acquireLlmSlot()
    // beginLlmCall/endLlmCall の役割は chatText.ts の同じ分岐を参照。この関数は fetch から
    // 戻り値確定までを単一の try/catch で扱っているため、finally を1箇所追加するだけで
    // どの経路で終わっても endLlmCall / releaseLlmSlot が必ず呼ばれる。
    const endLlmCall = beginLlmCall()
    let response: Awaited<ReturnType<AiGatewayContext['fetch']>>
    try {
      response = await context.fetch(`${connection.baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(connection.apiKey ? { Authorization: `Bearer ${connection.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: options.model,
          input: options.input,
        }),
        timeoutMs: context.settings.llmRequestTimeoutSec * 1000,
        // 中断シグナル。Tauri 経路では無視されるため、実際の停止は協調的キャンセルで担保する。
        signal: getCurrentPipelineAbortSignal() ?? undefined,
      })
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      pushLlmError({ nodeName, model: options.model, errorCode: isTimeoutError(err) ? 'timeout' : 'fetch_failed', detail })
      return null
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
      pushLlmError({ nodeName, model: options.model, httpStatus: response.status, errorCode, detail })
      // errorCode === 'quota_exhausted'（HTTP 429 のうち insufficient_quota）はここに乗らず
      // 下の return へ直行する。同じ 429 でも課金設定を直さない限り絶対に回復しない決定的エラー
      // であり、バックオフリトライは無駄になるだけのため（chatText.ts の同じ分岐・errors.ts の
      // classifyHttpErrorCode 参照）。従来は isRateLimitedHttpStatus(response.status) で直接
      // ステータスだけを見ていたため、quota_exhausted も 429 である以上ここに乗ってしまっていた。
      if (errorCode === 'rate_limited') {
        reportLlmRateLimitEncountered()
        const abortSignal = getCurrentPipelineAbortSignal()
        if (attempt < RATE_LIMIT_MAX_ATTEMPTS && !abortSignal?.aborted) {
          const delayMs = resolveRateLimitDelayMs(response, attempt)
          await delayRespectingAbort(delayMs, abortSignal)
          if (!abortSignal?.aborted) continue
        }
      }
      return null
    }

    reportLlmCallSucceeded()

    try {
      const payload = await response.json() as EmbeddingResponse
      const data = payload.data ?? []
      if (data.length !== options.input.length) {
        pushLlmError({
          nodeName,
          model: options.model,
          errorCode: 'invalid_response_shape',
          detail: `expected ${options.input.length} embeddings, received ${data.length}`,
        })
        return null
      }
      const vectors: number[][] = []
      for (const item of data) {
        const vector = item.embedding
        if (!Array.isArray(vector) || vector.length === 0) {
          pushLlmError({ nodeName, model: options.model, errorCode: 'invalid_response_shape', detail: 'embedding vector missing or empty' })
          return null
        }
        vectors.push(vector)
      }
      return vectors
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      pushLlmError({ nodeName, model: options.model, errorCode: 'response_json_parse_failed', detail })
      return null
    }
  }
}
