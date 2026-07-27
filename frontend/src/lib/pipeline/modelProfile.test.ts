import { describe, expect, it } from 'vitest'
import type { AdminSettings } from '@/types/adminSettings'
import type { ModelProfile } from '@/types/modelProfile'
import { getDefaultAdminSettings } from '@/api/adminSettings'
import {
  adaptChatCompletionRequest,
  CONSERVATIVE_CONTEXT_LENGTH_CEILING_TOKENS,
  MIN_REASONING_HEADROOM_TOKENS,
  MODEL_PROFILE_PRESETS,
  normalizeChatCompletionContent,
  REASONING_BUDGET_TOKENS,
  resolveModelProfile,
  stripDelimitedReasoning,
  withReasoningHeadroom,
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

  it('clamps max_tokens against a conservative context ceiling for a long prompt, without going below the floor (context_size_exceeded regression)', () => {
    // gemma プリセットの contextLength は 128000 だが、実機の JIT ロード既定値は 8192。
    // 長いプロンプトでは CONSERVATIVE_CONTEXT_LENGTH_CEILING_TOKENS を基準にクランプが効き、
    // かつ床(256)を割り込まないことを確認する。
    const longContent = 'あ'.repeat(20000)
    const adapted = adaptChatCompletionRequest({
      body: { model: 'gemma-4-e4b-it', max_tokens: 32768 },
      messages: [{ role: 'user', content: longContent }],
      settings: settings({ translationProvider: 'local_openai' }),
      model: 'gemma-4-e4b-it',
      reasoningMode: 'nonThinking',
    })
    expect(adapted.body.max_tokens).toBeLessThan(32768)
    expect(adapted.body.max_tokens as number).toBeGreaterThanOrEqual(256)
    expect(adapted.maxTokensClamp?.wasClamped).toBe(true)
    expect(adapted.maxTokensClamp?.requested).toBe(32768)
  })

  it('does not report a clamp when the requested max_tokens already fits comfortably', () => {
    const adapted = adaptChatCompletionRequest({
      body: { model: 'gemma-4-e4b-it', max_tokens: 512 },
      messages: [{ role: 'user', content: 'short prompt' }],
      settings: settings({ translationProvider: 'local_openai' }),
      model: 'gemma-4-e4b-it',
      reasoningMode: 'nonThinking',
    })
    expect(adapted.body.max_tokens).toBe(512)
    expect(adapted.maxTokensClamp).toBeUndefined()
  })

  it('caps the effective context length used for clamping at CONSERVATIVE_CONTEXT_LENGTH_CEILING_TOKENS even though the gemma preset declares a much larger contextLength', () => {
    expect(MODEL_PROFILE_PRESETS.gemma.contextLength).toBeGreaterThan(CONSERVATIVE_CONTEXT_LENGTH_CEILING_TOKENS)
  })

  it('uses runtimeContextLengthTokens (e.g. LM Studio loaded_context_length) instead of the fixed 8192 ceiling when provided', () => {
    // 中程度の長さのプロンプト。CONSERVATIVE_CONTEXT_LENGTH_CEILING_TOKENS(8192) を基準にすると
    // 実質クランプされるが、実測の 32768 を渡せばクランプされない・より大きい max_tokens が
    // 許容されるはずである（8192 固定のままでは反映されないことの回帰防止）。
    const content = 'あ'.repeat(8000)
    const withoutRuntimeLength = adaptChatCompletionRequest({
      body: { model: 'gemma-4-e4b-it', max_tokens: 4096 },
      messages: [{ role: 'user', content }],
      settings: settings({ translationProvider: 'local_openai' }),
      model: 'gemma-4-e4b-it',
      reasoningMode: 'nonThinking',
    })
    const withRuntimeLength = adaptChatCompletionRequest({
      body: { model: 'gemma-4-e4b-it', max_tokens: 4096 },
      messages: [{ role: 'user', content }],
      settings: settings({ translationProvider: 'local_openai' }),
      model: 'gemma-4-e4b-it',
      reasoningMode: 'nonThinking',
      runtimeContextLengthTokens: 32768,
    })

    expect(withoutRuntimeLength.maxTokensClamp?.wasClamped).toBe(true)
    expect(withRuntimeLength.maxTokensClamp).toBeUndefined()
    expect(withRuntimeLength.body.max_tokens).toBe(4096)
    expect(withRuntimeLength.body.max_tokens as number).toBeGreaterThan(withoutRuntimeLength.body.max_tokens as number)
  })

  it('ignores an invalid runtimeContextLengthTokens (non-finite or <= 0) and falls back to CONSERVATIVE_CONTEXT_LENGTH_CEILING_TOKENS', () => {
    const content = 'あ'.repeat(20000)
    const baseline = adaptChatCompletionRequest({
      body: { model: 'gemma-4-e4b-it', max_tokens: 32768 },
      messages: [{ role: 'user', content }],
      settings: settings({ translationProvider: 'local_openai' }),
      model: 'gemma-4-e4b-it',
      reasoningMode: 'nonThinking',
    })
    for (const invalid of [0, -100, Number.NaN, Number.POSITIVE_INFINITY]) {
      const adapted = adaptChatCompletionRequest({
        body: { model: 'gemma-4-e4b-it', max_tokens: 32768 },
        messages: [{ role: 'user', content }],
        settings: settings({ translationProvider: 'local_openai' }),
        model: 'gemma-4-e4b-it',
        reasoningMode: 'nonThinking',
        runtimeContextLengthTokens: invalid,
      })
      expect(adapted.body.max_tokens).toBe(baseline.body.max_tokens)
    }
  })
})

describe('withReasoningHeadroom', () => {
  const nonThinkingProfile: ModelProfile = {
    id: 'no-reasoning',
    label: 'No reasoning',
    contextLength: 8192,
    maxOutputTokens: 4096,
    supportsSystemRole: true,
    reasoning: {
      capability: 'none',
      enable: { method: 'none' },
      output: { style: 'reasoning_content_field' },
    },
    sampling: {},
  }

  it('returns the desired token count unchanged when the profile is undefined', () => {
    expect(withReasoningHeadroom(1000, undefined)).toBe(1000)
  })

  it('returns the desired token count unchanged for a non-reasoning capable profile', () => {
    expect(withReasoningHeadroom(1000, nonThinkingProfile)).toBe(1000)
  })

  it('adds REASONING_BUDGET_TOKENS for a toggleable reasoning profile', () => {
    const profile = { ...MODEL_PROFILE_PRESETS.gemma, maxOutputTokens: 1_000_000 }
    expect(withReasoningHeadroom(1000, profile)).toBe(1000 + REASONING_BUDGET_TOKENS)
  })

  it('adds REASONING_BUDGET_TOKENS for an always_on reasoning profile', () => {
    const alwaysOnProfile: ModelProfile = {
      ...MODEL_PROFILE_PRESETS.qwen,
      maxOutputTokens: 1_000_000,
      reasoning: { ...MODEL_PROFILE_PRESETS.qwen.reasoning, capability: 'always_on' },
    }
    expect(withReasoningHeadroom(500, alwaysOnProfile)).toBe(500 + REASONING_BUDGET_TOKENS)
  })

  it('adds enough headroom for a small batch estimate to exceed the measured 5-item detection reasoning consumption (regression for the 96% detection-failure incident)', () => {
    // detectIncompleteEnds.ts の 8件バッチ見積り相当（8*12+16=112）。旧実装は 6倍しても 672 にしか
    // ならず、実測の reasoning 消費（565）に対してほぼ余裕がなく毎回切り詰められていた。
    const profile = { ...MODEL_PROFILE_PRESETS.gemma, maxOutputTokens: 1_000_000 }
    const measuredReasoningTokensFor5ItemBatch = 565
    expect(withReasoningHeadroom(112, profile)).toBeGreaterThan(measuredReasoningTokensFor5ItemBatch)
  })

  it('does not blow up to a multiplier-scale value for a larger desired output (regression for the context_size_exceeded incident)', () => {
    // 旧実装（6倍）なら 4000 は 24000 になっていた。加算方式では desired + 固定予算に留まる。
    const profile = { ...MODEL_PROFILE_PRESETS.gemma, maxOutputTokens: 1_000_000 }
    const desired = 4000
    const result = withReasoningHeadroom(desired, profile)
    expect(result).toBe(desired + REASONING_BUDGET_TOKENS)
    expect(result).toBeLessThan(desired * 6)
  })

  it('clamps the result to profile.maxOutputTokens', () => {
    const smallCapProfile = { ...MODEL_PROFILE_PRESETS.gemma, maxOutputTokens: 2000 }
    expect(withReasoningHeadroom(1000, smallCapProfile)).toBe(2000)
  })

  it('never clamps below MIN_REASONING_HEADROOM_TOKENS even for an extremely small maxOutputTokens', () => {
    const tinyCapProfile = { ...MODEL_PROFILE_PRESETS.gemma, maxOutputTokens: 10 }
    expect(withReasoningHeadroom(1, tinyCapProfile)).toBe(MIN_REASONING_HEADROOM_TOKENS)
  })

  it('returns MIN_REASONING_HEADROOM_TOKENS (never 0 or NaN) for invalid input values', () => {
    expect(withReasoningHeadroom(Number.NaN, MODEL_PROFILE_PRESETS.gemma)).toBe(MIN_REASONING_HEADROOM_TOKENS)
    expect(withReasoningHeadroom(-5, MODEL_PROFILE_PRESETS.gemma)).toBe(MIN_REASONING_HEADROOM_TOKENS)
    expect(withReasoningHeadroom(0, MODEL_PROFILE_PRESETS.gemma)).toBe(MIN_REASONING_HEADROOM_TOKENS)
    expect(withReasoningHeadroom(Number.POSITIVE_INFINITY, MODEL_PROFILE_PRESETS.gemma)).toBe(MIN_REASONING_HEADROOM_TOKENS)
    expect(withReasoningHeadroom(Number.NaN, undefined)).toBe(MIN_REASONING_HEADROOM_TOKENS)
    expect(Number.isNaN(withReasoningHeadroom(Number.NaN, MODEL_PROFILE_PRESETS.gemma))).toBe(false)
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
