import { describe, expect, it } from 'vitest'
import type { AdminSettings } from '@/types/adminSettings'
import { getDefaultAdminSettings } from '@/api/adminSettings'
import {
  adaptChatCompletionRequest,
  normalizeChatCompletionContent,
  resolveModelProfile,
  stripDelimitedReasoning,
} from './modelProfile'

function settings(overrides: Partial<AdminSettings> = {}): AdminSettings {
  return {
    ...getDefaultAdminSettings(),
    ...overrides,
  }
}

describe('resolveModelProfile', () => {
  it('infers local Gemma and Qwen presets from model IDs', () => {
    const local = settings({ translationProvider: 'local_openai' })
    expect(resolveModelProfile(local, 'google/gemma-4-e4b-it')?.id).toBe('gemma')
    expect(resolveModelProfile(local, 'qwen3.6-27b-mtp')?.id).toBe('qwen')
  })

  it('uses a valid custom profile JSON before preset inference', () => {
    const custom = {
      id: 'custom-small',
      label: 'Custom Small',
      contextLength: 4096,
      maxOutputTokens: 512,
      supportsSystemRole: false,
      reasoning: {
        capability: 'none',
        enable: { method: 'none' },
        output: { style: 'reasoning_content_field' },
      },
      sampling: {},
    }
    expect(resolveModelProfile(settings({ modelProfileJson: JSON.stringify(custom) }), 'gemma')?.id).toBe('custom-small')
  })

  it('uses capability-specific profile presets before legacy profile settings', () => {
    const configured = settings({
      modelProfilePreset: 'auto',
      chatTextProfilePreset: 'qwen',
      chatVisionProfilePreset: 'gemma',
      embeddingProfilePreset: 'qwen',
    })

    expect(resolveModelProfile(configured, 'local-chat', 'chatText')?.id).toBe('qwen')
    expect(resolveModelProfile(configured, 'local-vision', 'chatVision')?.id).toBe('gemma')
    expect(resolveModelProfile(configured, 'local-embedding', 'embedding')?.id).toBe('qwen')
  })

  it('does not infer model profiles for OpenAI, DeepSeek, or unknown non-reasoning models', () => {
    expect(resolveModelProfile(settings({ translationProvider: 'openai' }), 'gpt-5.4-mini')).toBeUndefined()
    expect(resolveModelProfile(settings({ translationProvider: 'local_openai' }), 'deepseek-v4-pro')).toBeUndefined()
    expect(resolveModelProfile(settings({ translationProvider: 'local_openai' }), 'mistral-small')).toBeUndefined()
  })
})

describe('adaptChatCompletionRequest', () => {
  it('injects Gemma thinking token and clamps max_tokens to the model profile', () => {
    const body: Record<string, unknown> = { model: 'gemma-4-e4b-it', max_tokens: 999999 }
    const messages = [
      { role: 'system', content: 'Return JSON only.' },
      { role: 'user', content: 'Translate this.' },
    ]
    const adapted = adaptChatCompletionRequest({
      body,
      messages,
      settings: settings({ translationProvider: 'local_openai' }),
      model: 'gemma-4-e4b-it',
      reasoningMode: 'thinking',
    })
    expect(adapted.messages[0].content.startsWith('<|think|>')).toBe(true)
    expect(adapted.body.max_tokens).toBeLessThanOrEqual(32768)
  })

  it('does not clamp token limits for the OpenAI API provider', () => {
    const adapted = adaptChatCompletionRequest({
      body: { model: 'gpt-5.4-mini', max_tokens: 999999 },
      messages: [{ role: 'user', content: 'hello' }],
      settings: settings({ translationProvider: 'openai' }),
      model: 'gpt-5.4-mini',
      reasoningMode: 'nonThinking',
    })
    expect(adapted.body.max_tokens).toBe(999999)
  })

  it('adds Qwen chat_template_kwargs and sampling for non-thinking mode', () => {
    const adapted = adaptChatCompletionRequest({
      body: { model: 'qwen3.6-27b-mtp' },
      messages: [{ role: 'user', content: 'hello' }],
      settings: settings({ translationProvider: 'local_openai' }),
      model: 'qwen3.6-27b-mtp',
      reasoningMode: 'nonThinking',
    })
    expect(adapted.body.chat_template_kwargs).toEqual({ enable_thinking: false })
    expect(adapted.body.temperature).toBe(0.7)
    expect(adapted.body.top_p).toBe(0.8)
  })

  it('folds system content into user content when a profile does not support system role', () => {
    const custom = {
      id: 'no-system',
      label: 'No system',
      contextLength: 8192,
      maxOutputTokens: 1024,
      supportsSystemRole: false,
      reasoning: {
        capability: 'none',
        enable: { method: 'none' },
        output: { style: 'reasoning_content_field' },
      },
      sampling: {},
    }
    const adapted = adaptChatCompletionRequest({
      body: { model: 'x' },
      messages: [
        { role: 'system', content: 'System rules' },
        { role: 'user', content: 'User request' },
      ],
      settings: settings({ modelProfileJson: JSON.stringify(custom) }),
      model: 'x',
      reasoningMode: 'nonThinking',
    })
    expect(adapted.messages).toEqual([{ role: 'user', content: 'System rules\n\nUser request' }])
  })
})

describe('stripDelimitedReasoning', () => {
  it('removes closed Gemma thought channels and keeps the final answer', () => {
    expect(stripDelimitedReasoning(
      '<|channel>thought\ninternal steps<channel|>\n{"text":"ok"}',
      '<|channel>thought',
      '<channel|>',
    )).toBe('{"text":"ok"}')
  })

  it('treats an unclosed thought tag as truncated reasoning with no final answer', () => {
    expect(stripDelimitedReasoning('<think>\ninternal only', '<think>', '</think>')).toBe('')
  })

  it('normalizes content only for tag-delimited profiles', () => {
    const profile = resolveModelProfile(settings({ translationProvider: 'local_openai' }), 'gemma-4-e4b-it')
    expect(normalizeChatCompletionContent('<|channel>thought x<channel|> answer', profile)).toBe('answer')
    expect(normalizeChatCompletionContent('answer', undefined)).toBe('answer')
  })
})
