import type { AdminSettings } from '@/types/adminSettings'
import type { EnBlock, PipelineThresholds } from '../../blockTypes'
import { normalizeSpaces } from '../../textUtils'
import { resolveCompressModelId } from '../../prompts'
import { requireAiConnection, resolveChatModelForProvider } from '../../aiProvider'
import type { AgentThresholds, DecisionContext, TimelinePatch, Tool } from '../types'
import { tauriFetch } from '@/lib/tauriFetch'

function buildCoreSystemPrompt(): string {
  return (
    'You are a subtitle editor making a last-resort compression for academic lecture subtitles. ' +
    'Reduce this subtitle to the single most important concept only. ' +
    'This output will be flagged for manual review — accuracy takes priority over length. ' +
    'Preserve: technical terms, numbers, the core definition or claim. ' +
    'Do not include line breaks in your response. ' +
    'Respond with JSON: {"text": "<core subtitle>"}'
  )
}

async function callCore(
  enText: string,
  jaText: string,
  settings: AdminSettings,
): Promise<string> {
  const connection = requireAiConnection(settings)
  const model = resolveChatModelForProvider(settings, resolveCompressModelId(settings))
  const systemPrompt = buildCoreSystemPrompt()

  const response = await tauriFetch(`${connection.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${connection.apiKey}`,
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
    throw new Error(`compress_core API returned HTTP ${response.status}: ${detail}`)
  }

  const payload = await response.json()
  const content: string = payload?.choices?.[0]?.message?.content ?? ''
  const parsed = JSON.parse(content) as { text?: unknown }
  const text = typeof parsed.text === 'string' ? parsed.text : ''
  return normalizeSpaces(text.trim())
}

export const compressCoreTool: Tool = {
  name: 'compress_core',
  description: 'Reduce to single most important concept. Flags block for manual review.',

  canApply(ctx: DecisionContext): boolean {
    const compressCount = ctx.block.compressCount ?? 0
    return (
      compressCount < ctx.thresholds.maxCompressPerBlock &&
      !ctx.attemptHistory.some(a => a.strategy === 'compress_core')
    )
  },

  async execute(
    block: EnBlock,
    _ctx: DecisionContext,
    settings: AdminSettings,
    _thresholds: PipelineThresholds & AgentThresholds,
  ): Promise<TimelinePatch> {
    const core = await callCore(block.enText, block.jaText, settings)

    const changed = core.length > 0 && core !== block.enText.replace(/\n/g, ' ')
    const newEnText = changed ? core : block.enText

    return {
      replaceBlocks: [
        {
          ...block,
          enText: newEnText,
          enRaw: changed ? core : block.enRaw,
          compressCount: (block.compressCount ?? 0) + 1,
          enTextOriginal: block.enTextOriginal ?? block.enText,
        },
      ],
      dirtyBlockIds: [String(block.id)],
      changed,
    }
  },
}
