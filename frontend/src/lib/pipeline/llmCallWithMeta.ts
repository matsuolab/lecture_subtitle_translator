import type { AdminSettings } from '@/types/adminSettings'
import { requireAiConnection, resolveJsonResponseFormatForProvider } from './aiProvider'
import { tauriFetch } from '@/lib/tauriFetch'
import { type LlmUsageSink, safePush, getCurrentLlmUsageSink } from './llmUsageSink'

/**
 * Chat Completions API へ 1 リクエスト送り、構造化された結果を返す共通ヘルパー。
 *
 * 目的:
 *   - 各ノード（correctJa / compress 系 / splitBlock / expandEn / contextMerge / semanticSplitJa / translateEn）
 *     が個別に実装していた fetch + finish_reason 判定 + parse をまとめ DRY 化。
 *   - throw せず、必ず構造化された LlmCallResult を返却する（呼出元が原因に応じて分岐判断できる）。
 *   - 将来の OSS / ローカル OpenAI 互換モデル対応（#110）の差異吸収ポイントとして機能させる。
 *
 * 失敗時の挙動:
 *   - HTTP エラー / ネットワーク失敗 → errorMessage
 *   - finish_reason='content_filter' → finishReason + errorMessage='content_filter'（呼出元で即諦め判定）
 *   - message.refusal !== null → refusal + errorMessage='model_refusal:...'（呼出元で即諦め判定）
 *   - finish_reason='length' → finishReason + errorMessage='truncated_at_length_limit'（呼出元でリトライ判定）
 *   - 空 content → errorMessage='empty_response'
 *   - 正常完了 → content + finishReason + usage tokens
 *
 * OpenAI API 仕様参照:
 *   https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create
 */
export interface LlmCallResult {
  /** message.content。失敗時は空文字 */
  content: string
  /** finish_reason: 'stop' | 'length' | 'content_filter' | 'tool_calls' | 'function_call' */
  finishReason?: string
  /** message.refusal（Structured Outputs で拒否時に入る） */
  refusal?: string | null
  /** 失敗理由（HTTP / refusal / content_filter / length / empty）*/
  errorMessage?: string
  /** HTTP ステータス（エラー時のみ）*/
  httpStatus?: number
  /** prompt tokens (usage.prompt_tokens) */
  promptTokens?: number
  /** completion tokens (usage.completion_tokens) */
  completionTokens?: number
  /** reasoning tokens (usage.completion_tokens_details.reasoning_tokens) — 推論モデル時のみ */
  reasoningTokens?: number
  /** cached input tokens (usage.prompt_tokens_details.cached_tokens) — OpenAI prompt caching */
  cachedInputTokens?: number
  /** API 呼出にかかった時間 (ms) */
  durationMs?: number
}

/**
 * Chat Completions API 呼出オプション。
 */
export interface LlmCallOptions {
  /** モデル ID（既に requireChatModelForProvider で解決済みの値）*/
  model: string
  /** system プロンプト */
  systemPrompt: string
  /** user メッセージ（典型的には JSON.stringify(...) 等）*/
  userContent: string
  /** 任意の few-shot メッセージ（user/assistant ペア）。systemPrompt と最終 userContent の間に挿入される */
  fewShotMessages?: Array<{ role: 'user' | 'assistant'; content: string }>
  /** 非推論モデル用。reasoning_effort と排他（同時指定時は reasoning_effort 優先）*/
  temperature?: number
  /** 推論モデル（gpt-5 系）用 */
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high'
  /** 出力長上限。応答が length truncate されないよう余裕を持たせる */
  maxTokens?: number
  /**
   * response_format を明示指定したい場合（通常は省略すれば provider 適切値が自動選択される）。
   * `'omit'` を指定すると response_format フィールド自体を付けない。
   */
  responseFormat?: 'json_object' | 'text' | 'omit'
  /** ノード名（エラーメッセージ用識別子）*/
  nodeName: string
  /**
   * usage 収集 sink。指定すれば本 API 呼出の usage が 1 件 push される。
   * pipeline 全体のコスト・トークン集計に使う。未指定なら no-op（テストや単体実行から呼べる）。
   */
  usageSink?: LlmUsageSink
}

/**
 * Chat Completions API へ 1 リクエスト送る。throw せず構造化結果を返す。
 *
 * connection は呼出元が `requireAiConnection(settings, nodeName)` 等で取得して渡す。
 * （nodeName を connection 取得段階でも使うため、ヘルパー外で取得した方が責務が明確）
 */
export async function llmCallWithMeta(
  options: LlmCallOptions,
  settings: AdminSettings,
): Promise<LlmCallResult> {
  const connection = (() => {
    try {
      return requireAiConnection(settings, options.nodeName)
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) } as const
    }
  })()
  if ('error' in connection) {
    return { content: '', errorMessage: `connection_failed: ${connection.error}` }
  }

  const messages: Array<{ role: string; content: string }> = [
    { role: 'system', content: options.systemPrompt },
  ]
  if (options.fewShotMessages) {
    for (const msg of options.fewShotMessages) messages.push(msg)
  }
  messages.push({ role: 'user', content: options.userContent })

  // body 構築
  const body: Record<string, unknown> = {
    model: options.model,
    messages,
  }
  if (options.reasoningEffort) {
    body.reasoning_effort = options.reasoningEffort
  } else if (typeof options.temperature === 'number') {
    body.temperature = options.temperature
  }
  if (typeof options.maxTokens === 'number') {
    body.max_tokens = options.maxTokens
  }
  if (options.responseFormat !== 'omit') {
    if (options.responseFormat === 'json_object' || options.responseFormat === 'text') {
      body.response_format = { type: options.responseFormat }
    } else {
      // provider 既定（OpenAI なら json_object、ローカルは text 等）に従う
      body.response_format = resolveJsonResponseFormatForProvider(settings)
    }
  }

  const callStartedAt = Date.now()
  let response: Awaited<ReturnType<typeof tauriFetch>>
  try {
    response = await tauriFetch(`${connection.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(connection.apiKey ? { Authorization: `Bearer ${connection.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
    })
  } catch (err) {
    return {
      content: '',
      errorMessage: `fetch_failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    return {
      content: '',
      httpStatus: response.status,
      errorMessage: `http_${response.status}: ${detail.slice(0, 200)}`,
    }
  }

  let payload: Record<string, unknown>
  try {
    payload = (await response.json()) as Record<string, unknown>
  } catch (err) {
    return {
      content: '',
      errorMessage: `response_json_parse_failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  const choices = Array.isArray(payload.choices) ? payload.choices : []
  const firstChoice = choices[0] as Record<string, unknown> | undefined
  const finishReason = typeof firstChoice?.finish_reason === 'string' ? firstChoice.finish_reason : undefined
  const message = firstChoice?.message as Record<string, unknown> | undefined
  const refusal = typeof message?.refusal === 'string' ? message.refusal : null
  const content: string = typeof message?.content === 'string' ? message.content : ''

  // usage 抽出
  const usage = payload.usage as Record<string, unknown> | undefined
  const promptTokens = typeof usage?.prompt_tokens === 'number' ? usage.prompt_tokens : undefined
  const completionTokens = typeof usage?.completion_tokens === 'number' ? usage.completion_tokens : undefined
  const completionDetails = usage?.completion_tokens_details as Record<string, unknown> | undefined
  const reasoningTokens = typeof completionDetails?.reasoning_tokens === 'number' ? completionDetails.reasoning_tokens : undefined
  const promptDetails = usage?.prompt_tokens_details as Record<string, unknown> | undefined
  const cachedInputTokens = typeof promptDetails?.cached_tokens === 'number' ? promptDetails.cached_tokens : undefined
  const durationMs = Date.now() - callStartedAt

  // sink への push（API 失敗時は 0/0 で safePush 側がスキップする）。
  // options.usageSink 明示指定が優先、未指定なら module-level の current sink を使う。
  safePush(options.usageSink ?? getCurrentLlmUsageSink(), {
    nodeId: options.nodeName,
    model: options.model,
    promptTokens: promptTokens ?? 0,
    completionTokens: completionTokens ?? 0,
    reasoningTokens,
    cachedInputTokens,
    durationMs,
  })

  // 即諦め分岐: content_filter / refusal
  if (finishReason === 'content_filter') {
    return {
      content: '',
      finishReason,
      refusal,
      errorMessage: 'content_filter',
      promptTokens,
      completionTokens,
      reasoningTokens,
      cachedInputTokens,
      durationMs,
    }
  }
  if (refusal) {
    return {
      content: '',
      finishReason,
      refusal,
      errorMessage: `model_refusal: ${refusal.slice(0, 200)}`,
      promptTokens,
      completionTokens,
      reasoningTokens,
      cachedInputTokens,
      durationMs,
    }
  }
  // リトライ可能エラー: length / empty
  if (finishReason === 'length') {
    return {
      content,
      finishReason,
      errorMessage: `truncated_at_length_limit (content_preview=${content.slice(0, 100)})`,
      promptTokens,
      completionTokens,
      reasoningTokens,
      cachedInputTokens,
      durationMs,
    }
  }
  if (!content.trim()) {
    return {
      content: '',
      finishReason,
      errorMessage: `empty_response (payload_keys=${Object.keys(payload).join(',')})`,
      promptTokens,
      completionTokens,
      reasoningTokens,
      cachedInputTokens,
      durationMs,
    }
  }

  // 成功
  return {
    content,
    finishReason,
    refusal,
    promptTokens,
    completionTokens,
    reasoningTokens,
    cachedInputTokens,
    durationMs,
  }
}

/**
 * LlmCallResult が「即諦めるべき失敗」か判定。
 * content_filter / model_refusal の場合はリトライしても同じ結果になるため早期 break 用。
 */
export function isAbortableFailure(result: LlmCallResult): boolean {
  if (result.finishReason === 'content_filter') return true
  if (result.refusal !== null && result.refusal !== undefined) return true
  return false
}

/**
 * LlmCallResult が「リトライで救えるかもしれない失敗」か判定。
 */
export function isRetryableFailure(result: LlmCallResult): boolean {
  if (!result.errorMessage) return false
  if (isAbortableFailure(result)) return false
  return true
}
