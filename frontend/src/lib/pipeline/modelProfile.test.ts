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

  it('strips token limit fields for the OpenAI API provider instead of clamping them', () => {
    // 実測: 同一入力でも max_tokens を送るとバッチ見積り値（例: 376）だけが finishReason=length
    // で本文 0 文字のまま切断され、送らなければ 450 前後で安定して完走した。上限は消費量を
    // 左右せず成功可否だけを左右していたため、openai / gemini ではフィールドごと削除する
    // （モデル未一致で profile が undefined でも同じ扱いになることを確認する）。
    const adapted = adaptChatCompletionRequest({
      body: { model: 'gpt-5.4-mini', max_tokens: 999999, max_completion_tokens: 999999 },
      messages: [{ role: 'user', content: 'hello' }],
      settings: settings({ translationProvider: 'openai' }),
      model: 'gpt-5.4-mini',
      reasoningMode: 'nonThinking',
    })
    expect('max_tokens' in adapted.body).toBe(false)
    expect('max_completion_tokens' in adapted.body).toBe(false)
  })

  it('strips token limit fields for the Gemini API provider instead of clamping them', () => {
    // 旧実装は provider !== 'openai' でクランプしていたため gemini はクランプ対象だった。
    // 新方針では openai と同様に「送らない」扱いに変わる。
    const adapted = adaptChatCompletionRequest({
      body: { model: 'gemini-3-flash-preview', max_tokens: 999999 },
      messages: [{ role: 'user', content: 'hello' }],
      settings: settings({ translationProvider: 'gemini' }),
      model: 'gemini-3-flash-preview',
      reasoningMode: 'nonThinking',
    })
    expect('max_tokens' in adapted.body).toBe(false)
    expect('max_completion_tokens' in adapted.body).toBe(false)
  })

  it('keeps clamping token limits for the local_openai provider even when a model profile matches (e.g. a gemma/qwen-named local model)', () => {
    const adapted = adaptChatCompletionRequest({
      body: { model: 'gemma-4-e4b-it', max_tokens: 999999 },
      messages: [{ role: 'user', content: 'hello' }],
      settings: settings({ translationProvider: 'local_openai' }),
      model: 'gemma-4-e4b-it',
      reasoningMode: 'nonThinking',
    })
    expect(adapted.body.max_tokens).toBeLessThan(999999)
    expect(adapted.body.max_tokens as number).toBeGreaterThanOrEqual(256)
  })

  it('strips token limit fields for openai/gemini even when no model profile matches at all (the common production case: a real gpt-*/gemini-* model with no gemma/qwen profile configured)', () => {
    // resolveModelProfile が undefined を返す（!profile の早期 return）経路でも、provider による
    // トークン上限の扱いが正しく適用されることを確認する。detectIncompleteEnds.ts /
    // translateEn.ts が渡す実際の本番モデル（例: gpt-5.6-luna）はここを通る。
    const openaiAdapted = adaptChatCompletionRequest({
      body: { model: 'gpt-5.6-luna', max_completion_tokens: 376 },
      messages: [{ role: 'user', content: 'hello' }],
      settings: settings({ translationProvider: 'openai' }),
      model: 'gpt-5.6-luna',
      reasoningMode: 'nonThinking',
    })
    expect(openaiAdapted.profile).toBeUndefined()
    expect('max_completion_tokens' in openaiAdapted.body).toBe(false)

    const geminiAdapted = adaptChatCompletionRequest({
      body: { model: 'gemini-3-flash-preview', max_tokens: 376 },
      messages: [{ role: 'user', content: 'hello' }],
      settings: settings({ translationProvider: 'gemini' }),
      model: 'gemini-3-flash-preview',
      reasoningMode: 'nonThinking',
    })
    expect(geminiAdapted.profile).toBeUndefined()
    expect('max_tokens' in geminiAdapted.body).toBe(false)
  })

  it('leaves the body untouched (no clamp, no strip) for local_openai when no model profile matches', () => {
    const adapted = adaptChatCompletionRequest({
      body: { model: 'mistral-small', max_tokens: 999999 },
      messages: [{ role: 'user', content: 'hello' }],
      settings: settings({ translationProvider: 'local_openai' }),
      model: 'mistral-small',
      reasoningMode: 'nonThinking',
    })
    expect(adapted.profile).toBeUndefined()
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

  describe('reasoningBudgetOverrideTokens (implementation 3: AdminSettings.llmReasoningBudgetTokens)', () => {
    it('falls back to the previous profile-based behavior when the override is 0 (default = auto)', () => {
      // profile 未解決（isReasoningCapableProfile が false）のとき、override=0 なら従来どおり素通し。
      expect(withReasoningHeadroom(1000, undefined, 0)).toBe(1000)
      // 思考しうる profile のとき、override=0 なら従来どおり REASONING_BUDGET_TOKENS を加算。
      const profile = { ...MODEL_PROFILE_PRESETS.gemma, maxOutputTokens: 1_000_000 }
      expect(withReasoningHeadroom(1000, profile, 0)).toBe(1000 + REASONING_BUDGET_TOKENS)
    })

    it('always adds the override amount regardless of profile reasoning capability when override > 0', () => {
      // profile が undefined（=推定不能なローカルモデル）でも override が指定されていれば加算する。
      // これが実装3の主目的: モデル名が gemma/qwen に一致しないローカルモデルで割り増しが
      // 一切効かず出力上限で切れる、という破綻の穴を利用者が埋められるようにする。
      expect(withReasoningHeadroom(1000, undefined, 5000)).toBe(1000 + 5000)

      const nonThinkingProfile = {
        ...MODEL_PROFILE_PRESETS.gemma,
        maxOutputTokens: 1_000_000,
        reasoning: { ...MODEL_PROFILE_PRESETS.gemma.reasoning, capability: 'none' as const },
      }
      expect(withReasoningHeadroom(1000, nonThinkingProfile, 5000)).toBe(1000 + 5000)
    })

    it('overrides REASONING_BUDGET_TOKENS entirely (does not add both) when override > 0 for a reasoning-capable profile', () => {
      const profile = { ...MODEL_PROFILE_PRESETS.gemma, maxOutputTokens: 1_000_000 }
      const result = withReasoningHeadroom(1000, profile, 3000)
      expect(result).toBe(1000 + 3000)
      expect(result).not.toBe(1000 + REASONING_BUDGET_TOKENS)
    })

    it('still clamps to profile.maxOutputTokens and never drops below MIN_REASONING_HEADROOM_TOKENS with an override', () => {
      const smallCapProfile = { ...MODEL_PROFILE_PRESETS.gemma, maxOutputTokens: 2000 }
      expect(withReasoningHeadroom(1000, smallCapProfile, 5000)).toBe(2000)

      const tinyCapProfile = { ...MODEL_PROFILE_PRESETS.gemma, maxOutputTokens: 10 }
      expect(withReasoningHeadroom(1, tinyCapProfile, 5000)).toBe(MIN_REASONING_HEADROOM_TOKENS)
    })

    it('ignores a negative or non-finite override and falls back to profile-based behavior', () => {
      expect(withReasoningHeadroom(1000, undefined, -1)).toBe(1000)
      expect(withReasoningHeadroom(1000, undefined, Number.NaN)).toBe(1000)
      const profile = { ...MODEL_PROFILE_PRESETS.gemma, maxOutputTokens: 1_000_000 }
      expect(withReasoningHeadroom(1000, profile, -1)).toBe(1000 + REASONING_BUDGET_TOKENS)
    })
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
