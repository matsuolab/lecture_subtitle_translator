import type { EnBlock } from './blockTypes'
import type { PipelineThresholds } from './blockTypes'
import { classifyViolation, computeMetrics } from './metrics'

export type TextNormalizationMatchType = 'literal' | 'regex'

export interface TextNormalizationRule {
  enabled: boolean
  match: string
  replacement: string
  matchType: TextNormalizationMatchType
}

export interface TextNormalizationConfig {
  version: 1
  rules: TextNormalizationRule[]
}

export interface TextNormalizationValidationResult {
  ok: boolean
  config?: TextNormalizationConfig
  error?: string
}

export const DEFAULT_TEXT_NORMALIZATION_CONFIG: TextNormalizationConfig = {
  version: 1,
  rules: [
    {
      enabled: true,
      match: '‘',
      replacement: "'",
      matchType: 'literal',
    },
    {
      enabled: true,
      match: '’',
      replacement: "'",
      matchType: 'literal',
    },
    {
      enabled: true,
      match: '“',
      replacement: '"',
      matchType: 'literal',
    },
    {
      enabled: true,
      match: '”',
      replacement: '"',
      matchType: 'literal',
    },
    {
      enabled: true,
      match: '\u00A0',
      replacement: ' ',
      matchType: 'literal',
    },
  ],
}

export const DEFAULT_TEXT_NORMALIZATION_RULES_JSON = JSON.stringify(DEFAULT_TEXT_NORMALIZATION_CONFIG, null, 2)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function validateRule(value: unknown, index: number): TextNormalizationRule {
  if (!isRecord(value)) throw new Error(`rules[${index}] must be an object`)
  const enabled = typeof value.enabled === 'boolean' ? value.enabled : true
  const match = typeof value.match === 'string' ? value.match : ''
  const replacement = typeof value.replacement === 'string' ? value.replacement : ''
  const matchType = value.matchType === 'regex' ? 'regex' : value.matchType === 'literal' ? 'literal' : null

  if (!match) throw new Error(`rules[${index}].match is required`)
  if (!matchType) throw new Error(`rules[${index}].matchType must be "literal" or "regex"`)
  if (matchType === 'regex') {
    try {
      new RegExp(match, 'gu')
    } catch (error) {
      throw new Error(`rules[${index}].match is invalid regex: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return { enabled, match, replacement, matchType }
}

export function validateTextNormalizationRulesJson(json: string): TextNormalizationValidationResult {
  try {
    const parsed = JSON.parse(json)
    if (!isRecord(parsed)) throw new Error('root must be an object')
    if (parsed.version !== 1) throw new Error('version must be 1')
    if (!Array.isArray(parsed.rules)) throw new Error('rules must be an array')
    return {
      ok: true,
      config: {
        version: 1,
        rules: parsed.rules.map(validateRule),
      },
    }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export function parseTextNormalizationConfig(json: string): TextNormalizationConfig {
  const result = validateTextNormalizationRulesJson(json)
  if (!result.ok || !result.config) {
    throw new Error(result.error ?? 'invalid text normalization rules')
  }
  return result.config
}

function applyRule(text: string, rule: TextNormalizationRule): string {
  if (!rule.enabled) return text
  if (rule.matchType === 'literal') return text.split(rule.match).join(rule.replacement)
  return text.replace(new RegExp(rule.match, 'gu'), rule.replacement)
}

export function normalizeSubtitleText(text: string, config: TextNormalizationConfig): string {
  return config.rules.reduce((current, rule) => applyRule(current, rule), text)
}

export function normalizeEnBlocks(
  blocks: EnBlock[],
  config: TextNormalizationConfig,
  thresholds: PipelineThresholds,
): EnBlock[] {
  return blocks.map((block) => {
    const enText = normalizeSubtitleText(block.enText, config)
    const enRaw = normalizeSubtitleText(block.enRaw ?? block.enText, config)
    const metrics = computeMetrics({ ...block, enText, enRaw })
    return {
      ...block,
      enText,
      enRaw,
      enChars: metrics.enChars,
      cps: metrics.cps,
      maxLineLen: metrics.maxLineLen,
      violation: classifyViolation({ ...block, enText, enRaw }, thresholds),
    }
  })
}
