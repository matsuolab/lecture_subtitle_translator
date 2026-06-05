export interface SamplingParams {
  temperature?: number
  topP?: number
  topK?: number
  minP?: number
  presencePenalty?: number
  repetitionPenalty?: number
}

export type ReasoningCapability = 'none' | 'always_on' | 'toggleable'
export type ReasoningEnableMethod = 'param' | 'chat_template_kwarg' | 'system_token' | 'none'
export type ReasoningOutputStyle = 'reasoning_content_field' | 'tag_delimited'

export interface ModelProfile {
  id: string
  label: string
  contextLength: number
  maxOutputTokens: number
  supportsSystemRole: boolean
  reasoning: {
    capability: ReasoningCapability
    enable: {
      method: ReasoningEnableMethod
      key?: string
      onValue?: unknown
      offValue?: unknown
      systemToken?: string
    }
    output: {
      style: ReasoningOutputStyle
      openTag?: string
      closeTag?: string
    }
  }
  sampling: {
    thinking?: SamplingParams
    nonThinking?: SamplingParams
  }
}

export type ModelProfilePresetId = 'auto' | 'openai' | 'gemma' | 'qwen' | 'deepseek' | 'non_reasoning'
