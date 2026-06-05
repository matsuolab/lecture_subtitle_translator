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

describe('AI Gateway chatText', () => {
  it('keeps the OpenAI Chat Completions request shape unchanged', async () => {
    const calls: Array<{ url: string; init: TauriFetchOptions }> = []
    const gateway = createAiGateway(settings({ translationProvider: 'openai' }), {
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} })
        return new Response(JSON.stringify({
          choices: [
            {
              finish_reason: 'stop',
              message: { content: '{"ok":true}', refusal: null },
            },
          ],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 4,
            completion_tokens_details: { reasoning_tokens: 0 },
            prompt_tokens_details: { cached_tokens: 0 },
          },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      },
    })

    const result = await gateway.chatText({
      nodeName: 'openai-regression',
      model: 'gpt-5.4-mini',
      messages: [
        { role: 'system', content: 'Return JSON only.' },
        { role: 'user', content: 'Say ok.' },
      ],
      temperature: 0.2,
      maxTokens: 2048,
      responseFormat: 'json_object',
    })

    expect(result.content).toBe('{"ok":true}')
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://api.openai.com/v1/chat/completions')
    expect(calls[0].init.headers).toMatchObject({
      'Content-Type': 'application/json',
      Authorization: 'Bearer sk-test',
    })
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      model: 'gpt-5.4-mini',
      messages: [
        { role: 'system', content: 'Return JSON only.' },
        { role: 'user', content: 'Say ok.' },
      ],
      temperature: 0.2,
      max_tokens: 2048,
      response_format: { type: 'json_object' },
    })
  })
})
