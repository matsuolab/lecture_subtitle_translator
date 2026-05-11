import type { AdminSettings } from '@/types/adminSettings'
import type { EnBlock, PipelineThresholds } from '../../blockTypes'
import { normalizeSpaces } from '../../textUtils'
import { resolveCompressModelId, resolveCompressSystemPrompt } from '../../prompts'
import { requireAiConnection, resolveChatModelForProvider } from '../../aiProvider'
import type { AgentThresholds, DecisionContext, TimelinePatch, Tool } from '../types'
import { tauriFetch } from '@/lib/tauriFetch'

async function callCompress(
  enText: string,
  jaText: string,
  systemPrompt: string,
  settings: AdminSettings,
  model: string,
): Promise<string> {
  const connection = requireAiConnection(settings)
  const resolvedModel = resolveChatModelForProvider(settings, model)

  const response = await tauriFetch(`${connection.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${connection.apiKey}`,
    },
    body: JSON.stringify({
      model: resolvedModel,
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
    throw new Error(`compress_rephrase API returned HTTP ${response.status}: ${detail}`)
  }

  const payload = await response.json()
  const content: string = payload?.choices?.[0]?.message?.content ?? ''
  const parsed = JSON.parse(content) as { text?: unknown }
  const text = typeof parsed.text === 'string' ? parsed.text : ''
  return normalizeSpaces(text.trim())
}

export const compressRephraseTool: Tool = {
  name: 'compress_rephrase',
  description: 'Shorten while preserving meaning. Targets filler phrases and verbose constructions.',

  canApply(ctx: DecisionContext): boolean {
    const compressCount = ctx.block.compressCount ?? 0
    return (
      compressCount < ctx.thresholds.maxCompressPerBlock &&
      !ctx.attemptHistory.some(a => a.strategy === 'compress_rephrase')
    )
  },

  async execute(
    block: EnBlock,
    _ctx: DecisionContext,
    settings: AdminSettings,
    _thresholds: PipelineThresholds & AgentThresholds,
  ): Promise<TimelinePatch> {
    const systemPrompt = resolveCompressSystemPrompt(settings, settings.compressPromptOverride)
    const model = resolveCompressModelId(settings)
    const compressed = await callCompress(block.enText, block.jaText, systemPrompt, settings, model)

    const changed = compressed.length > 0 && compressed !== block.enText.replace(/\n/g, ' ')
    const newEnText = changed ? compressed : block.enText

    return {
      replaceBlocks: [
        {
          ...block,
          enText: newEnText,
          enRaw: changed ? compressed : block.enRaw,
          compressCount: (block.compressCount ?? 0) + 1,
          enTextOriginal: block.enTextOriginal ?? block.enText,
        },
      ],
      dirtyBlockIds: [String(block.id)],
      changed,
    }
  },
}
