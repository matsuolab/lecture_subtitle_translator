import type { AdminSettings } from '@/types/adminSettings'
import type { ModelProfile, ModelProfilePresetId, SamplingParams } from '@/types/modelProfile'
import { resolveAiProvider } from './aiProvider'

export const MODEL_PROFILE_PRESETS: Record<Exclude<ModelProfilePresetId, 'auto'>, ModelProfile> = {
  openai: {
    id: 'openai',
    label: 'OpenAI reasoning-compatible',
    contextLength: 128000,
    maxOutputTokens: 32768,
    supportsSystemRole: true,
    reasoning: {
      capability: 'toggleable',
      enable: { method: 'param', key: 'reasoning_effort', onValue: 'medium', offValue: undefined },
      output: { style: 'reasoning_content_field' },
    },
    sampling: {},
  },
  gemma: {
    id: 'gemma',
    label: 'Gemma thinking-token compatible',
    contextLength: 128000,
    maxOutputTokens: 32768,
    supportsSystemRole: true,
    reasoning: {
      capability: 'toggleable',
      enable: { method: 'system_token', systemToken: '<|think|>' },
      output: { style: 'tag_delimited', openTag: '<|channel>thought', closeTag: '<channel|>' },
    },
    sampling: {
      thinking: { temperature: 1.0, topP: 0.95, topK: 64 },
      nonThinking: { temperature: 1.0, topP: 0.95, topK: 64 },
    },
  },
  qwen: {
    id: 'qwen',
    label: 'Qwen thinking compatible',
    contextLength: 262000,
    maxOutputTokens: 32768,
    supportsSystemRole: true,
    reasoning: {
      capability: 'toggleable',
      enable: { method: 'chat_template_kwarg', key: 'enable_thinking', onValue: true, offValue: false },
      output: { style: 'tag_delimited', openTag: '<think>', closeTag: '</think>' },
    },
    sampling: {
      thinking: { temperature: 1.0, topP: 0.95, topK: 20, minP: 0 },
      nonThinking: { temperature: 0.7, topP: 0.8, topK: 20, presencePenalty: 1.5 },
    },
  },
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek thinking-mode compatible',
    contextLength: 1000000,
    maxOutputTokens: 32768,
    supportsSystemRole: true,
    reasoning: {
      capability: 'toggleable',
      enable: { method: 'param', key: 'thinking_mode', onValue: 'thinking', offValue: 'non-think' },
      output: { style: 'reasoning_content_field', openTag: '<think>', closeTag: '</think>' },
    },
    sampling: {
      thinking: { temperature: 1.0, topP: 1.0 },
      nonThinking: { temperature: 1.0, topP: 1.0 },
    },
  },
  non_reasoning: {
    id: 'non_reasoning',
    label: 'Non-reasoning OpenAI-compatible',
    contextLength: 128000,
    maxOutputTokens: 8192,
    supportsSystemRole: true,
    reasoning: {
      capability: 'none',
      enable: { method: 'none' },
      output: { style: 'reasoning_content_field' },
    },
    sampling: {},
  },
}

export type LlmReasoningMode = 'thinking' | 'nonThinking'

export interface AdaptedChatRequest {
  body: Record<string, unknown>
  messages: Array<{ role: string; content: string }>
  profile?: ModelProfile
  reasoningMode: LlmReasoningMode
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function normalizeSampling(value: unknown): SamplingParams | undefined {
  if (!isObject(value)) return undefined
  const out: SamplingParams = {}
  if (typeof value.temperature === 'number') out.temperature = value.temperature
  if (typeof value.topP === 'number') out.topP = value.topP
  if (typeof value.topK === 'number') out.topK = value.topK
  if (typeof value.minP === 'number') out.minP = value.minP
  if (typeof value.presencePenalty === 'number') out.presencePenalty = value.presencePenalty
  if (typeof value.repetitionPenalty === 'number') out.repetitionPenalty = value.repetitionPenalty
  return Object.keys(out).length ? out : undefined
}

export function normalizeModelProfile(value: unknown): ModelProfile | undefined {
  if (!isObject(value)) return undefined
  const reasoning = isObject(value.reasoning) ? value.reasoning : undefined
  const enable = reasoning && isObject(reasoning.enable) ? reasoning.enable : undefined
  const output = reasoning && isObject(reasoning.output) ? reasoning.output : undefined
  const sampling = isObject(value.sampling) ? value.sampling : {}
  const capability = reasoning?.capability
  const method = enable?.method
  const style = output?.style
  if (
    typeof value.contextLength !== 'number'
    || typeof value.maxOutputTokens !== 'number'
    || typeof value.supportsSystemRole !== 'boolean'
    || !enable
    || !output
    || (capability !== 'none' && capability !== 'always_on' && capability !== 'toggleable')
    || (method !== 'param' && method !== 'chat_template_kwarg' && method !== 'system_token' && method !== 'none')
    || (style !== 'reasoning_content_field' && style !== 'tag_delimited')
  ) {
    return undefined
  }

  return {
    id: typeof value.id === 'string' && value.id ? value.id : 'custom',
    label: typeof value.label === 'string' && value.label ? value.label : 'Custom model profile',
    contextLength: Math.max(1024, Math.trunc(value.contextLength)),
    maxOutputTokens: Math.max(256, Math.trunc(value.maxOutputTokens)),
    supportsSystemRole: value.supportsSystemRole,
    reasoning: {
      capability,
      enable: {
        method,
        key: typeof enable.key === 'string' ? enable.key : undefined,
        onValue: enable.onValue,
        offValue: enable.offValue,
        systemToken: typeof enable.systemToken === 'string' ? enable.systemToken : undefined,
      },
      output: {
        style,
        openTag: typeof output.openTag === 'string' ? output.openTag : undefined,
        closeTag: typeof output.closeTag === 'string' ? output.closeTag : undefined,
      },
    },
    sampling: {
      thinking: normalizeSampling(sampling.thinking),
      nonThinking: normalizeSampling(sampling.nonThinking),
    },
  }
}

export function resolveModelProfile(
  settings: Pick<AdminSettings,
    | 'translationProvider'
    | 'modelProfilePreset'
    | 'modelProfileJson'
    | 'chatTextProfilePreset'
    | 'chatTextProfileJson'
    | 'chatVisionProfilePreset'
    | 'chatVisionProfileJson'
    | 'embeddingProfilePreset'
    | 'embeddingProfileJson'
  >,
  model: string,
  capability: 'chatText' | 'chatVision' | 'embedding' = 'chatText',
): ModelProfile | undefined {
  const profileJson = capability === 'chatVision'
    ? settings.chatVisionProfileJson
    : capability === 'embedding'
      ? settings.embeddingProfileJson
      : settings.chatTextProfileJson
  const presetId = capability === 'chatVision'
    ? settings.chatVisionProfilePreset
    : capability === 'embedding'
      ? settings.embeddingProfilePreset
      : settings.chatTextProfilePreset
  const customJson = profileJson.trim() || settings.modelProfileJson.trim()
  if (customJson) {
    try {
      const custom = normalizeModelProfile(JSON.parse(customJson))
      if (custom) return custom
    } catch {
      // Invalid custom JSON should not break the pipeline; fall through to preset inference.
    }
  }

  const preset = presetId !== 'auto' ? presetId : settings.modelProfilePreset
  if (preset && preset !== 'auto') return MODEL_PROFILE_PRESETS[preset]

  const provider = resolveAiProvider(settings)
  const normalized = model.toLowerCase()
  if (provider === 'openai') return MODEL_PROFILE_PRESETS.openai
  if (normalized.includes('gemma')) return MODEL_PROFILE_PRESETS.gemma
  if (normalized.includes('qwen')) return MODEL_PROFILE_PRESETS.qwen
  if (normalized.includes('deepseek')) return MODEL_PROFILE_PRESETS.deepseek
  return provider === 'local_openai' ? MODEL_PROFILE_PRESETS.non_reasoning : undefined
}

function estimatePromptTokens(messages: Array<{ role: string; content: string }>): number {
  const chars = messages.reduce((sum, msg) => sum + msg.role.length + msg.content.length, 0)
  return Math.ceil(chars / 4) + messages.length * 4
}

function clampMaxTokens(
  requested: unknown,
  profile: ModelProfile,
  messages: Array<{ role: string; content: string }>,
): number {
  const requestedNumber = typeof requested === 'number' ? requested : profile.maxOutputTokens
  const promptEstimate = estimatePromptTokens(messages)
  const reserve = 256
  const contextBudget = Math.max(256, profile.contextLength - promptEstimate - reserve)
  return Math.max(256, Math.min(Math.trunc(requestedNumber), profile.maxOutputTokens, contextBudget))
}

function applySampling(body: Record<string, unknown>, sampling: SamplingParams | undefined): void {
  if (!sampling) return
  if (typeof body.temperature !== 'number' && typeof sampling.temperature === 'number') body.temperature = sampling.temperature
  if (typeof sampling.topP === 'number') body.top_p = sampling.topP
  if (typeof sampling.topK === 'number') body.top_k = sampling.topK
  if (typeof sampling.minP === 'number') body.min_p = sampling.minP
  if (typeof sampling.presencePenalty === 'number') body.presence_penalty = sampling.presencePenalty
  if (typeof sampling.repetitionPenalty === 'number') body.repetition_penalty = sampling.repetitionPenalty
}

function foldSystemMessages(messages: Array<{ role: string; content: string }>): Array<{ role: string; content: string }> {
  const systemContent = messages.filter(msg => msg.role === 'system').map(msg => msg.content).join('\n\n')
  const nonSystem = messages.filter(msg => msg.role !== 'system')
  if (!systemContent) return messages
  const firstUserIndex = nonSystem.findIndex(msg => msg.role === 'user')
  if (firstUserIndex >= 0) {
    return nonSystem.map((msg, index) => index === firstUserIndex
      ? { ...msg, content: `${systemContent}\n\n${msg.content}` }
      : msg)
  }
  return [{ role: 'user', content: systemContent }, ...nonSystem]
}

function prependSystemToken(messages: Array<{ role: string; content: string }>, token: string): Array<{ role: string; content: string }> {
  const systemIndex = messages.findIndex(msg => msg.role === 'system')
  if (systemIndex >= 0) {
    return messages.map((msg, index) => {
      if (index !== systemIndex || msg.content.trimStart().startsWith(token)) return msg
      return { ...msg, content: `${token}\n${msg.content}` }
    })
  }
  return [{ role: 'system', content: token }, ...messages]
}

function applyReasoningEnable(
  body: Record<string, unknown>,
  messages: Array<{ role: string; content: string }>,
  profile: ModelProfile,
  mode: LlmReasoningMode,
): Array<{ role: string; content: string }> {
  const enable = profile.reasoning.enable
  const shouldThink = profile.reasoning.capability === 'always_on' || mode === 'thinking'
  if (enable.method === 'none') return messages
  if (enable.method === 'param' && enable.key) {
    const value = shouldThink ? enable.onValue : enable.offValue
    if (value !== undefined && body[enable.key] === undefined) body[enable.key] = value
    return messages
  }
  if (enable.method === 'chat_template_kwarg' && enable.key) {
    body.chat_template_kwargs = {
      ...(isObject(body.chat_template_kwargs) ? body.chat_template_kwargs : {}),
      [enable.key]: shouldThink ? enable.onValue : enable.offValue,
    }
    return messages
  }
  if (enable.method === 'system_token' && shouldThink && enable.systemToken) {
    return prependSystemToken(messages, enable.systemToken)
  }
  return messages
}

export function adaptChatCompletionRequest(args: {
  body: Record<string, unknown>
  messages: Array<{ role: string; content: string }>
  settings: Pick<AdminSettings,
    | 'translationProvider'
    | 'modelProfilePreset'
    | 'modelProfileJson'
    | 'chatTextProfilePreset'
    | 'chatTextProfileJson'
    | 'chatVisionProfilePreset'
    | 'chatVisionProfileJson'
    | 'embeddingProfilePreset'
    | 'embeddingProfileJson'
  >
  model: string
  reasoningMode: LlmReasoningMode
}): AdaptedChatRequest {
  const profile = resolveModelProfile(args.settings, args.model)
  if (!profile) {
    return { body: args.body, messages: args.messages, profile, reasoningMode: args.reasoningMode }
  }

  const provider = resolveAiProvider(args.settings)
  const body = { ...args.body }
  let messages = profile.supportsSystemRole ? args.messages : foldSystemMessages(args.messages)
  messages = applyReasoningEnable(body, messages, profile, args.reasoningMode)
  applySampling(body, args.reasoningMode === 'thinking' ? profile.sampling.thinking : profile.sampling.nonThinking)
  if (provider !== 'openai') {
    if (body.max_tokens !== undefined) body.max_tokens = clampMaxTokens(body.max_tokens, profile, messages)
    if (body.max_completion_tokens !== undefined) body.max_completion_tokens = clampMaxTokens(body.max_completion_tokens, profile, messages)
  }

  return { body, messages, profile, reasoningMode: args.reasoningMode }
}

export function stripDelimitedReasoning(content: string, openTag?: string, closeTag?: string): string {
  if (!content) return content
  let out = content
  if (openTag && closeTag) {
    let start = out.indexOf(openTag)
    while (start >= 0) {
      const end = out.indexOf(closeTag, start + openTag.length)
      if (end < 0) return out.slice(0, start).trim()
      out = `${out.slice(0, start)}${out.slice(end + closeTag.length)}`
      start = out.indexOf(openTag)
    }
    return out.trim()
  }
  if (closeTag) {
    const end = out.lastIndexOf(closeTag)
    if (end >= 0) return out.slice(end + closeTag.length).trim()
  }
  if (openTag) {
    const start = out.indexOf(openTag)
    if (start >= 0) return out.slice(0, start).trim()
  }
  return out.trim()
}

export function normalizeChatCompletionContent(content: string, profile?: ModelProfile): string {
  if (!profile || profile.reasoning.output.style !== 'tag_delimited') return content
  return stripDelimitedReasoning(
    content,
    profile.reasoning.output.openTag,
    profile.reasoning.output.closeTag,
  )
}
