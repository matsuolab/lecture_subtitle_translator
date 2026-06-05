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

describe('AI Gateway chatVision', () => {
  it('sends mixed text and image_url content through Chat Completions', async () => {
    const calls: Array<{ url: string; init: TauriFetchOptions }> = []
    const gateway = createAiGateway(settings({ translationProvider: 'openai' }), {
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} })
        return new Response(JSON.stringify({
          choices: [
            {
              finish_reason: 'stop',
              message: { content: '{"terms":[]}', refusal: null },
            },
          ],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      },
    })

    const result = await gateway.chatVision({
      nodeName: 'vision-regression',
      model: 'gpt-5.4-nano',
      messages: [
        { role: 'system', content: 'Return JSON only.' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Read this PDF page.' },
            { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,abc', detail: 'high' } },
          ],
        },
      ],
      maxTokens: 4096,
      responseFormat: 'json_object',
    })

    expect(result.content).toBe('{"terms":[]}')
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://api.openai.com/v1/chat/completions')
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      model: 'gpt-5.4-nano',
      messages: [
        { role: 'system', content: 'Return JSON only.' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Read this PDF page.' },
            { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,abc', detail: 'high' } },
          ],
        },
      ],
      max_tokens: 4096,
      response_format: { type: 'json_object' },
    })
  })
})
