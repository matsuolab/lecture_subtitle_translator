import { describe, expect, it } from 'vitest'
import { getDefaultAdminSettings } from '@/api/adminSettings'
import type { AdminSettings } from '@/types/adminSettings'
import type { TauriFetchOptions } from '@/lib/tauriFetch'
import { createAiGateway } from './index'

function settings(overrides: Partial<AdminSettings> = {}): AdminSettings {
  return {
    ...getDefaultAdminSettings(),
    openaiApiKey: 'sk-test',
    ...overrides,
  }
}

describe('AI Gateway probeAll', () => {
  it('checks connection, chat text, embeddings, and chat vision from one public call', async () => {
    const calls: Array<{ url: string; init: TauriFetchOptions }> = []
    const gateway = createAiGateway(settings({
      translationProvider: 'openai',
      translationModel: 'gpt-5.4-mini',
      pdfExtractionVisionModel: 'gpt-5.4-nano',
      embeddingModel: 'text-embedding-3-small',
    }), {
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} })
        if (String(url).endsWith('/models')) {
          return new Response(JSON.stringify({ data: [{ id: 'gpt-5.4-mini' }] }), { status: 200 })
        }
        if (String(url).endsWith('/embeddings')) {
          return new Response(JSON.stringify({ data: [{ embedding: [1, 0, 0] }] }), { status: 200 })
        }
        return new Response(JSON.stringify({
          choices: [
            {
              finish_reason: 'stop',
              message: { content: '{"ok":true}', refusal: null },
            },
          ],
        }), { status: 200 })
      },
    })

    const results = await gateway.probeAll()

    expect(results.map(result => [result.name, result.status])).toEqual([
      ['Connection', 'success'],
      ['Chat Text', 'success'],
      ['Embeddings', 'success'],
      ['Chat Vision', 'success'],
    ])
    expect(calls.map(call => call.url)).toEqual([
      'https://api.openai.com/v1/models',
      'https://api.openai.com/v1/chat/completions',
      'https://api.openai.com/v1/embeddings',
      'https://api.openai.com/v1/chat/completions',
    ])

    const visionBody = JSON.parse(String(calls[3].init.body))
    expect(visionBody.messages[0].content[1].type).toBe('image_url')
  })
})
