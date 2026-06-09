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
  it('applies the OpenAI request dialect to Chat Text requests', async () => {
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
      max_completion_tokens: 2048,
      response_format: { type: 'json_object' },
    })
  })

  it('classifies local context size errors with an actionable hint', async () => {
    const gateway = createAiGateway(settings({
      translationProvider: 'local_openai',
      openaiCompatibleBaseUrl: 'http://127.0.0.1:1234/v1',
      translationModel: 'google/gemma-4-12b',
    }), {
      fetch: async () => new Response(JSON.stringify({
        error: 'Context size has been exceeded.',
      }), { status: 400, headers: { 'Content-Type': 'application/json' } }),
    })

    const result = await gateway.chatText({
      nodeName: 'local-context-regression',
      model: 'google/gemma-4-12b',
      messages: [{ role: 'user', content: 'Translate this.' }],
      maxTokens: 2048,
    })

    expect(result.httpStatus).toBe(400)
    expect(result.errorMessage).toContain('context_size_exceeded')
    expect(result.errorMessage).toContain('LM Studio')
    expect(result.errorMessage).toContain('context length')
  })
})
