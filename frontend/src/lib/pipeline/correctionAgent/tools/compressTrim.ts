import type { AdminSettings } from '@/types/adminSettings'
import type { EnBlock, PipelineThresholds } from '../../blockTypes'
import { normalizeSpaces } from '../../textUtils'
import { resolveCompressModelId } from '../../prompts'
import type { AgentThresholds, DecisionContext, TimelinePatch, Tool } from '../types'

function buildTrimSystemPrompt(settings: { enMaxCharsPerLine: number; enMaxLines: number }): string {
  return (
    'You are a subtitle editor trimming academic lecture subtitles. ' +
    'This subtitle must be shortened by removing qualifications, examples, hedges, and asides. ' +
    `Keep the main claim or definition. Display limit: ${settings.enMaxLines} lines × ${settings.enMaxCharsPerLine} chars. ` +
    'Do NOT remove: technical terms, equations, numbers, named methods, definitions, negations, conditions, causal relations. ' +
    'You may remove: rhetorical filler, pure examples, hedging phrases. ' +
    'Do not include line breaks in your response. ' +
    'Respond with JSON: {"text": "<trimmed subtitle>"}'
  )
}

async function callTrim(
  enText: string,
  jaText: string,
  settings: AdminSettings,
): Promise<string> {
  const apiKey = settings.openaiApiKey.trim()
  const baseUrl = (settings.openaiCompatibleBaseUrl.trim() || 'https://api.openai.com/v1').replace(/\/$/, '')
  const model = resolveCompressModelId(settings)
  const systemPrompt = buildTrimSystemPrompt(settings)

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({
      model,
      temperature: 0.0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: `Japanese source:\n${jaText}\n\nCurrent English subtitle:\n${enText.replace(/\n/g, ' ')}`,
        },
      ],
    }),
  })

  if (!response.ok) {
    const detail = await response.text()
    throw new Error(`compress_trim API returned HTTP ${response.status}: ${detail}`)
  }

  const payload = await response.json()
  const content: string = payload?.choices?.[0]?.message?.content ?? ''
  const parsed = JSON.parse(content) as { text?: unknown }
  const text = typeof parsed.text === 'string' ? parsed.text : ''
  return normalizeSpaces(text.trim())
}

export const compressTrimTool: Tool = {
  name: 'compress_trim',
  description: 'Drop qualifications and examples. Keep main claim only.',

  canApply(ctx: DecisionContext): boolean {
    const compressCount = ctx.block.compressCount ?? 0
    return (
      compressCount < ctx.thresholds.maxCompressPerBlock &&
      !ctx.attemptHistory.some(a => a.strategy === 'compress_trim')
    )
  },

  async execute(
    block: EnBlock,
    _ctx: DecisionContext,
    settings: AdminSettings,
    _thresholds: PipelineThresholds & AgentThresholds,
  ): Promise<TimelinePatch> {
    const trimmed = await callTrim(block.enText, block.jaText, settings)

    const changed = trimmed.length > 0 && trimmed !== block.enText.replace(/\n/g, ' ')
    const newEnText = changed ? trimmed : block.enText

    return {
      replaceBlocks: [
        {
          ...block,
          enText: newEnText,
          enRaw: changed ? trimmed : block.enRaw,
          compressCount: (block.compressCount ?? 0) + 1,
          enTextOriginal: block.enTextOriginal ?? block.enText,
        },
      ],
      dirtyBlockIds: [String(block.id)],
      changed,
    }
  },
}
