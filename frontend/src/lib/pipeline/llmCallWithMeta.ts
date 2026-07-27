import type { AdminSettings } from '@/types/adminSettings'
import { createAiGateway } from '@/lib/aiGateway'
import type { JsonSchemaSpec, LlmErrorCode } from '@/lib/aiGateway'
import { type LlmUsageSink } from './llmUsageSink'

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
 *   - finish_reason='length' → finishReason + errorMessage='truncated_at_length_limit (content_preview=...)'（呼出元でリトライ判定）
 *   - 空 content → errorMessage='empty_response (payload_keys=...)'
 *   - 正常完了 → content + finishReason + usage tokens
 *
 * 重要: errorMessage は表示・ログ用の自由文字列であり、gateway 側で診断情報の suffix
 * （content_preview= / payload_keys= 等）が付与されるため完全一致比較の対象にしてはならない。
 * 呼出元が分岐判定に使うのは必ず errorCode（LlmErrorCode）の方。
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
  /** 分岐判定に使う構造化エラーコード。errorMessage は表示用のため判定には使わないこと */
  errorCode?: LlmErrorCode
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
  /**
   * Structured Outputs 用の JSON Schema。指定するとプロファイル解決を優先する
   * （json_schema 非対応プロファイルでは自動的に json_object / text へフォールバックする）。
   */
  jsonSchema?: JsonSchemaSpec
  /** ノード名（エラーメッセージ用識別子）*/
  nodeName: string
  /**
   * usage 収集 sink。指定すれば本 API 呼出の usage が 1 件 push される。
   * pipeline 全体のコスト・トークン集計に使う。未指定なら no-op（テストや単体実行から呼べる）。
   */
  usageSink?: LlmUsageSink
  /**
   * chatText.ts の ChatTextOptions.resolveRuntimeContextLength をそのまま透過する。
   * true にすると LM Studio 系プロファイルで実際の loaded_context_length を取得し、
   * max_tokens クランプに反映する。既定 false（余計なネットワーク呼出をしない）。
   * 実際の LLM 呼出を行うノード（correctJa 等）でのみ true にすること。
   */
  resolveRuntimeContextLength?: boolean
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
  const messages: Array<{ role: string; content: string }> = [
    { role: 'system', content: options.systemPrompt },
  ]
  if (options.fewShotMessages) {
    for (const msg of options.fewShotMessages) messages.push(msg)
  }
  messages.push({ role: 'user', content: options.userContent })
  return createAiGateway(settings).chatText({
    nodeName: options.nodeName,
    model: options.model,
    messages,
    temperature: options.temperature,
    reasoningEffort: options.reasoningEffort,
    maxTokens: options.maxTokens,
    responseFormat: options.responseFormat,
    jsonSchema: options.jsonSchema,
    usageSink: options.usageSink,
    resolveRuntimeContextLength: options.resolveRuntimeContextLength,
  })
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
