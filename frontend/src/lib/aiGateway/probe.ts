import { requireChatModelForProvider } from '@/lib/pipeline/aiProvider'
import type { AiGatewayContext } from './connection'
import { requireGatewayConnection } from './connection'
import { chatText } from './chatText'
import { chatVision } from './chatVision'
import { embeddings } from './embeddings'

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

export async function probeAll(context: AiGatewayContext): Promise<AiGatewayProbeResult[]> {
  const results: AiGatewayProbeResult[] = []
  let connection
  try {
    connection = requireGatewayConnection(context, 'AI Gateway connection probe')
    const response = await context.fetch(`${connection.baseUrl}/models`, {
      headers: connection.apiKey ? { Authorization: `Bearer ${connection.apiKey}` } : {},
    })
    results.push(response.ok ? ok('Connection', `OK /models (${response.status})`) : { name: 'Connection', status: 'error', message: `HTTP ${response.status}` })
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
          { type: 'text', text: 'Reply with exactly: OK' },
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
