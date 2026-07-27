import { requireChatModelForProvider, resolveChatModelForProvider } from '@/lib/pipeline/aiProvider'
import { CONSERVATIVE_CONTEXT_LENGTH_CEILING_TOKENS } from '@/lib/pipeline/modelProfile'
import type { AiGatewayContext } from './connection'
import { requireGatewayConnection } from './connection'
import { chatText } from './chatText'
import { chatVision } from './chatVision'
import { embeddings } from './embeddings'
import { resolveLmStudioLoadedContextLength } from './lmStudioContextLength'

const PROBE_IMAGE_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAASSURBVBhXY/jPwPAfBCAkkAEAcKEN8wkSEoIAAAAASUVORK5CYII='

export type AiGatewayProbeName = 'Connection' | 'Chat Text' | 'Embeddings' | 'Chat Vision'
export type AiGatewayProbeStatus = 'success' | 'error'

export interface AiGatewayProbeResult {
  name: AiGatewayProbeName
  status: AiGatewayProbeStatus
  message: string
}

function ok(name: AiGatewayProbeName, message: string): AiGatewayProbeResult {
  return { name, status: 'success', message }
}

function error(name: AiGatewayProbeName, err: unknown): AiGatewayProbeResult {
  return { name, status: 'error', message: err instanceof Error ? err.message : String(err) }
}

/**
 * 接続テストの「Connection」項目に付記する、実際にロードされているコンテキスト長の注記を組み立てる。
 * LM Studio 系プロファイル以外・取得失敗時（resolveLmStudioLoadedContextLength が undefined を
 * 返す場合）は何も付けない。8192（実機確認済みの JIT ロード既定値）以下の場合は、
 * ユーザーが `lms load -c 32768` 等で対処できるよう、その手段を含めた警告を付ける。
 */
async function buildLmStudioContextLengthNote(context: AiGatewayContext): Promise<string | undefined> {
  const model = resolveChatModelForProvider(context.settings, context.settings.translationModel)
  if (!model.trim()) return undefined
  const loaded = await resolveLmStudioLoadedContextLength(context, model)
  if (loaded === undefined) return undefined
  if (loaded <= CONSERVATIVE_CONTEXT_LENGTH_CEILING_TOKENS) {
    return `loaded_context_length=${loaded} WARNING: this is small and may cause context_size_exceeded errors. ` +
      'Reload the model with a larger context (e.g. `lms load -c 32768` in LM Studio), then rerun the connection check.'
  }
  return `loaded_context_length=${loaded}`
}

export async function probeAll(context: AiGatewayContext): Promise<AiGatewayProbeResult[]> {
  const results: AiGatewayProbeResult[] = []
  let connection
  try {
    connection = requireGatewayConnection(context, 'AI Gateway connection probe')
    const response = await context.fetch(`${connection.baseUrl}/models`, {
      headers: connection.apiKey ? { Authorization: `Bearer ${connection.apiKey}` } : {},
    })
    if (!response.ok) {
      results.push({ name: 'Connection', status: 'error', message: `HTTP ${response.status}` })
    } else {
      const contextLengthNote = await buildLmStudioContextLengthNote(context)
      results.push(ok('Connection', `OK /models (${response.status})${contextLengthNote ? ` ${contextLengthNote}` : ''}`))
    }
  } catch (err) {
    results.push(error('Connection', err))
  }

  try {
    const model = requireChatModelForProvider(context.settings, context.settings.translationModel, 'AI Gateway Chat Text probe')
    const result = await chatText(context, {
      nodeName: 'ai_gateway_probe.chat_text',
      model,
      messages: [{ role: 'user', content: 'Return JSON only: {"ok":true}' }],
      temperature: 0,
      maxTokens: 32,
    })
    results.push(result.errorMessage ? { name: 'Chat Text', status: 'error', message: result.errorMessage } : ok('Chat Text', `OK finish=${result.finishReason ?? 'unknown'}`))
  } catch (err) {
    results.push(error('Chat Text', err))
  }

  try {
    const vectors = await embeddings(context, {
      nodeName: 'ai_gateway_probe.embeddings',
      model: context.settings.embeddingModel.trim() || 'text-embedding-3-small',
      input: ['AI Gateway connection check'],
    })
    results.push(vectors ? ok('Embeddings', `OK vectors=${vectors.length}`) : { name: 'Embeddings', status: 'error', message: 'Embedding response was empty' })
  } catch (err) {
    results.push(error('Embeddings', err))
  }

  try {
    const model = requireChatModelForProvider(context.settings, context.settings.pdfExtractionVisionModel, 'AI Gateway Chat Vision probe')
    const result = await chatVision(context, {
      nodeName: 'ai_gateway_probe.chat_vision',
      model,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'Return JSON only: {"ok":true}. The image content is irrelevant for this connection check.' },
          { type: 'image_url', image_url: { url: PROBE_IMAGE_DATA_URL, detail: 'low' } },
        ],
      }],
      temperature: 0,
      maxTokens: 256,
    })
    results.push(result.errorMessage ? { name: 'Chat Vision', status: 'error', message: result.errorMessage } : ok('Chat Vision', `OK finish=${result.finishReason ?? 'unknown'}`))
  } catch (err) {
    results.push(error('Chat Vision', err))
  }

  return results
}
