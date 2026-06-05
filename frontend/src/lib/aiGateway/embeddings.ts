import type { AiGatewayContext } from './connection'
import { requireGatewayConnection } from './connection'

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
  const connection = (() => {
    try {
      return requireGatewayConnection(context, options.nodeName ?? 'embeddings')
    } catch {
      return null
    }
  })()
  if (!connection) return null

  try {
    const response = await context.fetch(`${connection.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(connection.apiKey ? { Authorization: `Bearer ${connection.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: options.model,
        input: options.input,
      }),
    })
    if (!response.ok) return null
    const payload = await response.json() as EmbeddingResponse
    const data = payload.data ?? []
    if (data.length !== options.input.length) return null
    const vectors: number[][] = []
    for (const item of data) {
      const vector = item.embedding
      if (!Array.isArray(vector) || vector.length === 0) return null
      vectors.push(vector)
    }
    return vectors
  } catch {
    return null
  }
}
