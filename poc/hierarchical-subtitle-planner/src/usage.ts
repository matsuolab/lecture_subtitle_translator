import type { CostEstimate, TokenUsage } from './schema.js'

interface ModelPricing {
  inputUsdPer1M: number
  cachedInputUsdPer1M: number
  outputUsdPer1M: number
  source: string
}

const PRICING: Record<string, ModelPricing> = {
  'gpt-5.4-mini': {
    inputUsdPer1M: 0.75,
    cachedInputUsdPer1M: 0.075,
    outputUsdPer1M: 4.5,
    source: 'https://developers.openai.com/api/docs/models/gpt-5.4-mini',
  },
  'gpt-5.4-mini-2026-03-17': {
    inputUsdPer1M: 0.75,
    cachedInputUsdPer1M: 0.075,
    outputUsdPer1M: 4.5,
    source: 'https://developers.openai.com/api/docs/models/gpt-5.4-mini',
  },
  'gpt-5.4-nano': {
    inputUsdPer1M: 0.2,
    cachedInputUsdPer1M: 0.02,
    outputUsdPer1M: 1.25,
    source: 'https://developers.openai.com/api/docs/models/gpt-5.4-nano',
  },
  'gpt-5.4-nano-2026-03-17': {
    inputUsdPer1M: 0.2,
    cachedInputUsdPer1M: 0.02,
    outputUsdPer1M: 1.25,
    source: 'https://developers.openai.com/api/docs/models/gpt-5.4-nano',
  },
  'gpt-5.5': {
    inputUsdPer1M: 5,
    cachedInputUsdPer1M: 0.5,
    outputUsdPer1M: 30,
    source: 'https://developers.openai.com/api/docs/models/gpt-5.5',
  },
  'gpt-5.5-2026-04-23': {
    inputUsdPer1M: 5,
    cachedInputUsdPer1M: 0.5,
    outputUsdPer1M: 30,
    source: 'https://developers.openai.com/api/docs/models/gpt-5.5',
  },
  'gpt-4.1-mini': {
    inputUsdPer1M: 0.4,
    cachedInputUsdPer1M: 0.1,
    outputUsdPer1M: 1.6,
    source: 'https://platform.openai.com/docs/models/gpt-4.1-mini',
  },
  'gpt-4.1-mini-2025-04-14': {
    inputUsdPer1M: 0.4,
    cachedInputUsdPer1M: 0.1,
    outputUsdPer1M: 1.6,
    source: 'https://platform.openai.com/docs/models/gpt-4.1-mini',
  },
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function cachedTokensFromUsage(usage: Record<string, unknown>): number {
  const details = usage.inputTokensDetails ?? usage.input_tokens_details
  if (Array.isArray(details)) {
    return details.reduce((sum, item) => {
      const record = asRecord(item)
      return sum + numberValue(record.cached_tokens ?? record.cachedTokens)
    }, 0)
  }
  const record = asRecord(details)
  return numberValue(record.cached_tokens ?? record.cachedTokens)
}

export function emptyUsage(): TokenUsage {
  return {
    input_tokens: 0,
    cached_input_tokens: 0,
    billable_input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
  }
}

export function collectTokenUsage(rawResponses: unknown[]): TokenUsage {
  const total = emptyUsage()
  for (const response of rawResponses) {
    const usage = asRecord(asRecord(response).usage)
    const input = numberValue(usage.inputTokens ?? usage.input_tokens)
    const output = numberValue(usage.outputTokens ?? usage.output_tokens)
    const totalTokens = numberValue(usage.totalTokens ?? usage.total_tokens)
    const cached = cachedTokensFromUsage(usage)
    total.input_tokens += input
    total.cached_input_tokens += cached
    total.output_tokens += output
    total.total_tokens += totalTokens || input + output
  }
  total.billable_input_tokens = Math.max(0, total.input_tokens - total.cached_input_tokens)
  return total
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    cached_input_tokens: a.cached_input_tokens + b.cached_input_tokens,
    billable_input_tokens: a.billable_input_tokens + b.billable_input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    total_tokens: a.total_tokens + b.total_tokens,
  }
}

function envNumber(name: string): number | null {
  const value = process.env[name]
  if (!value) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

export function estimateCost(model: string, usage: TokenUsage): CostEstimate {
  const pricing = PRICING[model] ?? PRICING[model.replace(/-\d{4}-\d{2}-\d{2}$/, '')]
  const input = envNumber('HSP_INPUT_USD_PER_1M') ?? pricing?.inputUsdPer1M ?? null
  const cached = envNumber('HSP_CACHED_INPUT_USD_PER_1M') ?? pricing?.cachedInputUsdPer1M ?? null
  const output = envNumber('HSP_OUTPUT_USD_PER_1M') ?? pricing?.outputUsdPer1M ?? null
  const notes: string[] = []
  if (!pricing) notes.push('No built-in pricing for this model. Set HSP_INPUT_USD_PER_1M, HSP_CACHED_INPUT_USD_PER_1M, and HSP_OUTPUT_USD_PER_1M to estimate cost.')
  if (envNumber('HSP_INPUT_USD_PER_1M') !== null || envNumber('HSP_OUTPUT_USD_PER_1M') !== null) {
    notes.push('Pricing was overridden by environment variables.')
  }
  const estimated = input === null || cached === null || output === null
    ? null
    : (usage.billable_input_tokens * input + usage.cached_input_tokens * cached + usage.output_tokens * output) / 1_000_000
  return {
    model,
    input_usd_per_1m: input,
    cached_input_usd_per_1m: cached,
    output_usd_per_1m: output,
    estimated_usd: estimated === null ? null : Math.round(estimated * 1_000_000) / 1_000_000,
    pricing_source: pricing?.source ?? 'env',
    notes,
  }
}

export function estimateUsd(model: string, usage: TokenUsage): number | null {
  return estimateCost(model, usage).estimated_usd
}
