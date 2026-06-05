import { resolveJsonResponseFormatForProvider } from '@/lib/pipeline/aiProvider'
import { normalizeChatCompletionContent, resolveModelProfile } from '@/lib/pipeline/modelProfile'
import type { AiGatewayContext } from './connection'
import { requireGatewayConnection } from './connection'
import type { ChatTextResult } from './chatText'

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
  if ('error' in connection) return { content: '', errorMessage: `connection_failed: ${connection.error}` }

  const body: Record<string, unknown> = {
    model: options.model,
    messages: options.messages,
  }
  if (typeof options.temperature === 'number') body.temperature = options.temperature
  if (typeof options.maxTokens === 'number') body.max_tokens = options.maxTokens
  if (options.responseFormat !== 'omit') {
    body.response_format = options.responseFormat === 'json_object' || options.responseFormat === 'text'
      ? { type: options.responseFormat }
      : resolveJsonResponseFormatForProvider(context.settings)
  }
  const profile = resolveModelProfile(context.settings, options.model, 'chatVision')

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
    return { content: '', errorMessage: `fetch_failed: ${err instanceof Error ? err.message : String(err)}` }
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    return { content: '', httpStatus: response.status, errorMessage: `http_${response.status}: ${detail.slice(0, 200)}` }
  }

  let payload: Record<string, unknown>
  try {
    payload = await response.json() as Record<string, unknown>
  } catch (err) {
    return { content: '', errorMessage: `response_json_parse_failed: ${err instanceof Error ? err.message : String(err)}` }
  }

  const choices = Array.isArray(payload.choices) ? payload.choices : []
  const firstChoice = choices[0] as Record<string, unknown> | undefined
  const finishReason = typeof firstChoice?.finish_reason === 'string' ? firstChoice.finish_reason : undefined
  const message = firstChoice?.message as Record<string, unknown> | undefined
  const refusal = typeof message?.refusal === 'string' ? message.refusal : null
  const rawContent = typeof message?.content === 'string' ? message.content : ''
  const content = normalizeChatCompletionContent(rawContent, profile)

  if (finishReason === 'content_filter') return { content: '', finishReason, refusal, errorMessage: 'content_filter' }
  if (refusal) return { content: '', finishReason, refusal, errorMessage: `model_refusal: ${refusal.slice(0, 200)}` }
  if (finishReason === 'length') return { content, finishReason, errorMessage: `truncated_at_length_limit (content_preview=${content.slice(0, 100)})` }
  if (!content.trim()) return { content: '', finishReason, errorMessage: `empty_response (payload_keys=${Object.keys(payload).join(',')})` }
  return { content, finishReason, refusal }
}
