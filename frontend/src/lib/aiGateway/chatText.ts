import { adaptChatCompletionRequest, type LlmReasoningMode, normalizeChatCompletionContent } from '@/lib/pipeline/modelProfile'
import type { LlmUsageSink } from '@/lib/pipeline/llmUsageSink'
import { getCurrentLlmUsageSink, safePush } from '@/lib/pipeline/llmUsageSink'
import type { AiGatewayContext } from './connection'
import { requireGatewayConnection } from './connection'
import { applyChatRequestDialect, resolveApiCompatibilityProfile, resolveChatResponseFormatForDialect } from './apiCompatibilityProfile'
import { formatAiGatewayHttpError } from './errors'

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
  usageSink?: LlmUsageSink
}

export interface ChatTextResult {
  content: string
  finishReason?: string
  refusal?: string | null
  errorMessage?: string
  httpStatus?: number
  promptTokens?: number
  completionTokens?: number
  reasoningTokens?: number
  cachedInputTokens?: number
  durationMs?: number
}

function buildChatTextBody(
  context: AiGatewayContext,
  options: ChatTextOptions,
): { body: Record<string, unknown>; profile: ReturnType<typeof adaptChatCompletionRequest>['profile'] } {
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
  body = applyChatRequestDialect(body, apiCompatibilityProfile, { maxOutputTokens: options.maxTokens })
  if (typeof options.maxCompletionTokens === 'number') body.max_completion_tokens = options.maxCompletionTokens
  if (options.responseFormat !== 'omit') {
    const responseFormat = options.responseFormat === 'json_object' || options.responseFormat === 'text'
      ? { type: options.responseFormat }
      : resolveChatResponseFormatForDialect(apiCompatibilityProfile)
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
  })
  body = {
    ...adapted.body,
    messages: adapted.messages,
  }
  return { body, profile: adapted.profile }
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
  if ('error' in connection) return { content: '', errorMessage: `connection_failed: ${connection.error}` }

  const { body, profile } = buildChatTextBody(context, options)
  const startedAt = Date.now()
  let response: Awaited<ReturnType<AiGatewayContext['fetch']>>
  try {
    response = await context.fetch(`${connection.baseUrl}/chat/completions`, {
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
      errorMessage: formatAiGatewayHttpError({ context, status: response.status, detail }),
    }
  }

  let payload: Record<string, unknown>
  try {
    payload = await response.json() as Record<string, unknown>
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
    return { content: '', finishReason, refusal, errorMessage: 'content_filter', promptTokens, completionTokens, reasoningTokens, cachedInputTokens, durationMs }
  }
  if (refusal) {
    return { content: '', finishReason, refusal, errorMessage: `model_refusal: ${refusal.slice(0, 200)}`, promptTokens, completionTokens, reasoningTokens, cachedInputTokens, durationMs }
  }
  if (finishReason === 'length') {
    return { content, finishReason, errorMessage: `truncated_at_length_limit (content_preview=${content.slice(0, 100)})`, promptTokens, completionTokens, reasoningTokens, cachedInputTokens, durationMs }
  }
  if (!content.trim()) {
    return { content: '', finishReason, errorMessage: `empty_response (payload_keys=${Object.keys(payload).join(',')})`, promptTokens, completionTokens, reasoningTokens, cachedInputTokens, durationMs }
  }

  return { content, finishReason, refusal, promptTokens, completionTokens, reasoningTokens, cachedInputTokens, durationMs }
}
