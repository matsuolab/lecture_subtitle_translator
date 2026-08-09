import { adaptChatCompletionRequest, type LlmReasoningMode, normalizeChatCompletionContent } from '@/lib/pipeline/modelProfile'
import type { LlmUsageSink } from '@/lib/pipeline/llmUsageSink'
import { getCurrentLlmUsageSink, safePush } from '@/lib/pipeline/llmUsageSink'
import { beginLlmCall } from './llmActivity'
import { acquireLlmSlot, reportLlmCallSucceeded, reportLlmRateLimitEncountered } from './llmConcurrency'
import type { AiGatewayContext } from './connection'
import { requireGatewayConnection } from './connection'
import {
  applyChatRequestDialect,
  type JsonSchemaSpec,
  resolveApiCompatibilityProfile,
  resolveChatResponseFormatForDialect,
} from './apiCompatibilityProfile'
import { classifyHttpErrorCode, formatAiGatewayHttpError } from './errors'
import { formatTruncatedMessage } from './truncatedMessage'
import { getCurrentPipelineAbortSignal } from '@/lib/pipeline/pipelineAbort'
import { isTimeoutError } from './timeoutError'
import { resolveLmStudioLoadedContextLength } from './lmStudioContextLength'
import { RATE_LIMIT_MAX_ATTEMPTS, delayRespectingAbort, resolveRateLimitDelayMs } from './rateLimitRetry'
import { pushLlmError } from './llmErrorLog'
import { learnUnsupportedParam, stripLearnedUnsupportedParams } from './paramCompat'
import { shouldSuppressOpenAiSamplingParams, stripOpenAiSamplingParams } from './openaiSamplingParams'

/**
 * errorMessage は表示・ログ用の自由文字列（suffix 付きで内容が変わりうる）。
 * 呼出元が分岐判定に使うのは必ず errorCode の方。errorMessage との完全一致比較は禁止
 * （suffix 付与により判定が壊れた過去の事故を踏まえた制約）。
 */
export type LlmErrorCode =
  | 'connection_failed'
  | 'fetch_failed'
  | 'timeout'
  | 'http_error'
  /**
   * HTTP 400 + コンテキスト長超過を示す本文（errors.ts の classifyHttpErrorCode 参照）。
   * 決定的エラー: 同一内容の再試行では回復しない。呼出元は入力を小さくして再試行するか、
   * これ以上小さくできなければ諦めて理由を記録すること。
   */
  | 'context_exceeded'
  /**
   * HTTP 429（レート制限）/ 503 / 529（サーバ過負荷。errors.ts の isRateLimitedHttpStatus 参照）。
   * gateway 層（chatText.ts 等）がバックオフ付きで自動リトライ済みであり、このコードが呼出元まで
   * 返るのは RATE_LIMIT_MAX_ATTEMPTS 回のリトライを尽くしても解消しなかった場合のみ。
   * 一時的失敗ではあるが、gateway 側で既に相応の待機・再試行を行っているため、呼出元
   * （translateEn.ts / correct.ts 等）は他の一般的な http_error と同様に「諦めて理由を記録する」
   * 扱いで良い（盲目的に即時再送しない。二重にリトライすると再び 429 を誘発するため）。
   */
  | 'rate_limited'
  /**
   * HTTP 429 のうち、OpenAI 公式仕様で `error.code`/`error.type` が `insufficient_quota`
   * のもの（errors.ts の isInsufficientQuotaHttpError 参照）。同じ 429 でも 'rate_limited' とは
   * 意味が全く異なる決定的エラー: 課金設定（支払い方法・利用枠）を直さない限り絶対に回復しない。
   * gateway 層はこのコードに対してバックオフリトライを一切行わず即座に返す
   * （'rate_limited' 用の RATE_LIMIT_MAX_ATTEMPTS=6 回のバックオフを空費しても無駄に終わるため）。
   * 呼出元（translateEn.ts / correct.ts / detectIncompleteEnds.ts）は 401/403/404 等の設定起因の
   * 致命エラーと同格に扱い、同一原因での失敗を繰り返さず早期に停止すること。
   */
  | 'quota_exhausted'
  | 'response_json_parse_failed'
  | 'content_filter'
  | 'model_refusal'
  | 'truncated'
  | 'empty_response'

export type ChatTextContent = string | Array<
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' | 'auto' } }
>

export interface ChatTextMessage {
  role: string
  content: ChatTextContent
}

export interface ChatTextOptions {
  nodeName: string
  model: string
  messages: ChatTextMessage[]
  temperature?: number
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high'
  maxTokens?: number
  maxCompletionTokens?: number
  responseFormat?: 'json_object' | 'text' | 'omit'
  /**
   * Structured Outputs 用の JSON Schema。指定するとプロファイル解決を優先する
   * （json_schema 非対応プロファイルでは自動的に json_object / text へフォールバックする）。
   */
  jsonSchema?: JsonSchemaSpec
  usageSink?: LlmUsageSink
  /**
   * true の場合、fetch 前に LM Studio 拡張 API (`/api/v0/models`) から実際に
   * ロードされているコンテキスト長 (loaded_context_length) を取得し、max_tokens クランプ計算に
   * 反映する（lmStudioContextLength.ts 参照）。LM Studio 系プロファイル以外・取得失敗時は
   * 何も起きず、既存のフォールバック上限（CONSERVATIVE_CONTEXT_LENGTH_CEILING_TOKENS）を使う。
   * 既定は false: 呼出元が明示的に有効化しない限り、余分なネットワーク呼出は発生しない
   * （プローブ・テスト等の軽量呼出を不必要に遅くしないため）。実際のパイプライン処理
   * （correctJa / translateEn 等、モデルプロファイルに基づく max_tokens クランプが効く経路）でのみ
   * true にすること。
   */
  resolveRuntimeContextLength?: boolean
}

export interface ChatTextResult {
  content: string
  finishReason?: string
  refusal?: string | null
  errorMessage?: string
  /** 分岐判定に使う構造化エラーコード。errorMessage は表示用のため判定には使わないこと */
  errorCode?: LlmErrorCode
  httpStatus?: number
  promptTokens?: number
  completionTokens?: number
  reasoningTokens?: number
  cachedInputTokens?: number
  durationMs?: number
  /**
   * max_tokens がコンテキスト長クランプによって削られた場合の requested 値
   * （modelProfile.ts の MaxTokensClampResult.requested）。削られていなければ undefined。
   * デバッグ可視化用（「なぜ出力が短く切られたか」を呼出元が判別できるようにする）。
   */
  maxTokensClampedFromRequested?: number
}

function buildChatTextBody(
  context: AiGatewayContext,
  options: ChatTextOptions,
  runtimeContextLengthTokens?: number,
): {
  body: Record<string, unknown>
  profile: ReturnType<typeof adaptChatCompletionRequest>['profile']
  maxTokensClamp?: ReturnType<typeof adaptChatCompletionRequest>['maxTokensClamp']
} {
  let body: Record<string, unknown> = {
    model: options.model,
    messages: options.messages,
  }
  if (options.reasoningEffort) {
    body.reasoning_effort = options.reasoningEffort
  } else if (typeof options.temperature === 'number') {
    body.temperature = options.temperature
  }
  const apiCompatibilityProfile = resolveApiCompatibilityProfile(context.settings)
  // 事前抑制: OpenAI の GPT-5 系・推論系モデルは temperature 等のサンプリング系パラメータの
  // 非既定値を 400 で拒否することが公式に確認されている（openaiSamplingParams.ts 参照）。
  // paramCompat.ts の適応学習（実際に 400 を受けてから学習）を待たず、既知のモデル群については
  // 最初から送らない。LM Studio / Ollama / Gemini プロファイルには一切影響しない。
  if (shouldSuppressOpenAiSamplingParams(apiCompatibilityProfile, options.model)) {
    body = stripOpenAiSamplingParams(body)
  }
  body = applyChatRequestDialect(body, apiCompatibilityProfile, { maxOutputTokens: options.maxTokens })
  if (typeof options.maxCompletionTokens === 'number') body.max_completion_tokens = options.maxCompletionTokens
  // jsonSchema が指定されている場合は responseFormat: 'omit' より優先する。
  // 'omit' は「response_format を付けない」という指定だが、jsonSchema 付きで 'omit' も
  // 同時に指定された場合まで丸ごとスキップすると Structured Outputs スキーマが黙って
  // 消えてしまう（呼出元が誤って両方渡した場合の事故防止）。
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

  if (!options.messages.every((message): message is { role: string; content: string } => typeof message.content === 'string')) {
    return { body, profile: undefined }
  }

  const reasoningMode: LlmReasoningMode = options.reasoningEffort ? 'thinking' : 'nonThinking'
  const adapted = adaptChatCompletionRequest({
    body,
    messages: options.messages,
    settings: context.settings,
    model: options.model,
    reasoningMode,
    runtimeContextLengthTokens,
  })
  body = {
    ...adapted.body,
    messages: adapted.messages,
  }
  return { body, profile: adapted.profile, maxTokensClamp: adapted.maxTokensClamp }
}

export async function chatText(
  context: AiGatewayContext,
  options: ChatTextOptions,
): Promise<ChatTextResult> {
  const connection = (() => {
    try {
      return requireGatewayConnection(context, options.nodeName)
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) } as const
    }
  })()
  // 接続情報の解決自体に失敗したケース（API key 未設定など、実際に fetch すら発行していない設定不備）。
  // 一時的なネットワーク断で発生する fetch_failed とは原因も対処も異なる
  // （こちらは設定を直さない限り何度リトライしても失敗し続ける）ため、別の errorCode で区別する。
  // 過去に両者を同じ errorCode に統一していたことで、呼出元 (detectIncompleteEnds.ts の
  // classifyCallError) が一時的な通信断まで config_error 扱いし、検出処理全体を早期 abort
  // させてしまう退行があった。
  if ('error' in connection) {
    pushLlmError({ nodeName: options.nodeName, model: options.model, errorCode: 'connection_failed', detail: connection.error })
    return { content: '', errorMessage: `connection_failed: ${connection.error}`, errorCode: 'connection_failed' }
  }

  // 実行時の実コンテキスト長取得（オプトイン）。既定 false のため、呼出元が明示しない限り
  // 追加のネットワーク呼出は発生しない（ChatTextOptions.resolveRuntimeContextLength の JSDoc参照）。
  const runtimeContextLengthTokens = options.resolveRuntimeContextLength
    ? await resolveLmStudioLoadedContextLength(context, options.model)
    : undefined

  const built = buildChatTextBody(context, options, runtimeContextLengthTokens)
  let body = built.body
  const { profile, maxTokensClamp } = built
  // クランプが効いて max_tokens が削られた場合の requested 値。デバッグ可視化のため
  // 結果に含める（console.log は使わず、呼出元が判別できる形で戻り値に残す）。
  const maxTokensClampedFromRequested = maxTokensClamp?.requested
  // これまでに学習済みの非対応パラメータ（paramCompat.ts）を事前に除去する。
  // モデルの仕様を決め打ちで判定するのではなく、過去に実際に 400 で拒否された経験のみに基づく
  // （paramCompat.ts の JSDoc 参照）。
  body = stripLearnedUnsupportedParams(connection.baseUrl, options.model, body)
  // HTTP 400 + 非対応パラメータ検知時、同一リクエストからそのパラメータを外して1回だけ即時
  // 再試行するためのフラグ。レート制限のバックオフとは別枠（決定的エラーなので待機は不要）。
  let paramRetryUsed = false

  let startedAt = Date.now()
  let payload: Record<string, unknown>

  // レート制限（429）・サーバ過負荷（503/529）をバックオフ付きで自動リトライするループ。
  // attempt は 1 始まり（1 = 初回試行）。RATE_LIMIT_MAX_ATTEMPTS に達するまでリトライする。
  for (let attempt = 1; ; attempt += 1) {
    // gateway 層の全体同時実行数セマフォ。ノード側の並列制御（mapWithConcurrency）とは別に、
    // 再帰的な追加呼出（detectIncompleteEnds.ts / translateEn.ts の半割リトライ等）がノードの
    // 並列枠の外側で増殖するのを防ぐ。上限未設定（0以下）なら待たずに即座に進む。
    // acquireLlmSlot() はここで完結する待機であり、スロットを保持したまま別の LLM 呼出を
    // 待つことはないためデッドロックしない（llmConcurrency.ts のコメント参照）。
    const releaseLlmSlot = await acquireLlmSlot()
    startedAt = Date.now()
    let response: Awaited<ReturnType<AiGatewayContext['fetch']>>
    // beginLlmCall/endLlmCall は「応答待ちの LLM リクエスト数」を追跡する（localPipeline.ts の
    // ハートビートがフリーズ判定に使う）。fetch が例外・タイムアウト・HTTPエラーのどの経路で
    // 終わっても必ず endLlmCall / releaseLlmSlot が呼ばれるよう、fetch 呼び出し全体を
    // try/finally で囲む。
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
      // タイムアウト由来の失敗は fetch_failed とは別の errorCode で区別する。呼出元
      // (detectIncompleteEnds.ts の classifyCallError 等) はどちらも retryable にフォール
      // スルーするため挙動は変わらないが、ログ・診断でタイムアウトかどうかを見分けられるようにする。
      if (isTimeoutError(err)) {
        const detail = err instanceof Error ? err.message : String(err)
        pushLlmError({ nodeName: options.nodeName, model: options.model, errorCode: 'timeout', detail })
        return {
          content: '',
          errorMessage: `request_timeout: ${detail}`,
          errorCode: 'timeout',
        }
      }
      const detail = err instanceof Error ? err.message : String(err)
      pushLlmError({ nodeName: options.nodeName, model: options.model, errorCode: 'fetch_failed', detail })
      return {
        content: '',
        errorMessage: `fetch_failed: ${detail}`,
        errorCode: 'fetch_failed',
      }
    } finally {
      endLlmCall()
      // 重要: バックオフ待機に入る「前」に必ずスロットを解放する。保持したまま待つと、
      // 同時実行枠が「待っているだけのリクエスト」で埋まり、他の待機中リクエストが永久に
      // スロットを獲得できずパイプライン全体が停止する（本タスクの最重要事故ポイント。
      // rateLimitRetry.ts のコメント参照）。
      releaseLlmSlot()
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      const errorCode = classifyHttpErrorCode(response.status, detail)
      // デバッグ専用領域（llmErrorLog.ts）へ生応答本文を記録する。字幕テキストには決して
      // 流れない（llmErrorLog.ts の JSDoc・PipelineLlmErrorRecord の JSDoc 参照）。
      pushLlmError({ nodeName: options.nodeName, model: options.model, httpStatus: response.status, errorCode, detail })

      // 非対応パラメータの適応的除去（paramCompat.ts）。モデルの仕様を決め打ちで判定せず、
      // サーバが実際に 400 で「このパラメータは非対応」と答えた場合にのみ学習し、同一
      // リクエストからそのパラメータを外して1回だけ即時再試行する（待機不要の決定的リトライ）。
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
      // 重要: errorCode === 'quota_exhausted'（HTTP 429 のうち insufficient_quota）はここには
      // 乗らず、意図的に下の return へ直行する。同じ 429 でも課金設定を直さない限り絶対に
      // 回復しない決定的エラーであり、'rate_limited' 用のバックオフリトライ（最大 RATE_LIMIT_MAX_ATTEMPTS
      // 回・約1分）を行っても無駄に終わるだけのため（errors.ts の classifyHttpErrorCode 参照）。
      if (errorCode === 'rate_limited') {
        // 実効同時実行数を下げ、以後の acquireLlmSlot() が同じ轍を踏みにくくする
        // （llmConcurrency.ts の reportLlmRateLimitEncountered 参照）。
        reportLlmRateLimitEncountered()
        const abortSignal = getCurrentPipelineAbortSignal()
        if (attempt < RATE_LIMIT_MAX_ATTEMPTS && !abortSignal?.aborted) {
          const delayMs = resolveRateLimitDelayMs(response, attempt)
          await delayRespectingAbort(delayMs, abortSignal)
          // 待機中に中断要求が出た場合はここでリトライを打ち切り、直近のレート制限エラーを返す
          // （中断要求が出ているのに待ち続けてはならない、という要件を満たすため）。
          if (!abortSignal?.aborted) continue
        }
      }
      return {
        content: '',
        httpStatus: response.status,
        errorMessage: formatAiGatewayHttpError({ context, status: response.status, detail }),
        errorCode,
      }
    }

    // HTTP レベルでは成功。以後の JSON パース・finish_reason 判定に関わらず、レート制限の
    // 実効上限はここで回復対象にしてよい（輸送層の成功であり、コンテンツ側の失敗とは別軸）。
    reportLlmCallSucceeded()

    try {
      payload = await response.json() as Record<string, unknown>
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      pushLlmError({ nodeName: options.nodeName, model: options.model, errorCode: 'response_json_parse_failed', detail })
      return {
        content: '',
        errorMessage: `response_json_parse_failed: ${detail}`,
        errorCode: 'response_json_parse_failed',
      }
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

  const usage = payload.usage as Record<string, unknown> | undefined
  const promptTokens = typeof usage?.prompt_tokens === 'number' ? usage.prompt_tokens : undefined
  const completionTokens = typeof usage?.completion_tokens === 'number' ? usage.completion_tokens : undefined
  const completionDetails = usage?.completion_tokens_details as Record<string, unknown> | undefined
  const reasoningTokens = typeof completionDetails?.reasoning_tokens === 'number' ? completionDetails.reasoning_tokens : undefined
  const promptDetails = usage?.prompt_tokens_details as Record<string, unknown> | undefined
  const cachedInputTokens = typeof promptDetails?.cached_tokens === 'number' ? promptDetails.cached_tokens : undefined
  const durationMs = Date.now() - startedAt

  safePush(options.usageSink ?? getCurrentLlmUsageSink(), {
    nodeId: options.nodeName,
    model: options.model,
    promptTokens: promptTokens ?? 0,
    completionTokens: completionTokens ?? 0,
    reasoningTokens,
    cachedInputTokens,
    durationMs,
  })

  if (finishReason === 'content_filter') {
    pushLlmError({ nodeName: options.nodeName, model: options.model, errorCode: 'content_filter', detail: 'content_filter' })
    return { content: '', finishReason, refusal, errorMessage: 'content_filter', errorCode: 'content_filter', promptTokens, completionTokens, reasoningTokens, cachedInputTokens, durationMs }
  }
  if (refusal) {
    pushLlmError({ nodeName: options.nodeName, model: options.model, errorCode: 'model_refusal', detail: refusal })
    return { content: '', finishReason, refusal, errorMessage: `model_refusal: ${refusal.slice(0, 200)}`, errorCode: 'model_refusal', promptTokens, completionTokens, reasoningTokens, cachedInputTokens, durationMs }
  }
  if (finishReason === 'length') {
    pushLlmError({ nodeName: options.nodeName, model: options.model, errorCode: 'truncated', detail: `content_preview=${content}` })
    // 実際に送った上限・消費内訳・本文長を含めたメッセージを組み立てる（truncatedMessage.ts 参照）。
    // 上限がいくつだったのか・何に消費されたのかが分からないと原因究明ができなかった経緯があるため。
    // 上限のパラメータ名は方言で決まり、ユーザー定義プロファイルでは任意名になりうる。
    // 決め打ちにすると「上限を送っているのに送っていないと報告する」ため、解決済みの値を渡す。
    const errorMessage = formatTruncatedMessage({
      body,
      completionTokens,
      reasoningTokens,
      contentLength: content.length,
      activeTokenLimitParam: resolveApiCompatibilityProfile(context.settings).requestDialect.chat.tokenLimitParam,
    })
    return { content, finishReason, errorMessage, errorCode: 'truncated', promptTokens, completionTokens, reasoningTokens, cachedInputTokens, durationMs, maxTokensClampedFromRequested }
  }
  if (!content.trim()) {
    pushLlmError({ nodeName: options.nodeName, model: options.model, errorCode: 'empty_response', detail: `payload_keys=${Object.keys(payload).join(',')}` })
    return { content: '', finishReason, errorMessage: `empty_response (payload_keys=${Object.keys(payload).join(',')})`, errorCode: 'empty_response', promptTokens, completionTokens, reasoningTokens, cachedInputTokens, durationMs, maxTokensClampedFromRequested }
  }

  return { content, finishReason, refusal, promptTokens, completionTokens, reasoningTokens, cachedInputTokens, durationMs, maxTokensClampedFromRequested }
}
