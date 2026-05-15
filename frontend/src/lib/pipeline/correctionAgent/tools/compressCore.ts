import type { AdminSettings } from '@/types/adminSettings'
import type { EnBlock, PipelineThresholds } from '../../blockTypes'
import { normalizeSpaces } from '../../textUtils'
import { resolveCompressModelId } from '../../prompts'
import { requireAiConnection, requireChatModelForProvider, resolveJsonResponseFormatForProvider } from '../../aiProvider'
import type { AgentThresholds, DecisionContext, TimelinePatch, Tool } from '../types'
import { tauriFetch } from '@/lib/tauriFetch'
import { parseJsonObjectFromLlmContent } from '../../jsonResponse'

function buildCoreSystemPrompt(): string {
  return (
    'You are a subtitle editor performing aggressive rewriting. ' +
    'The current subtitle is significantly too long for its display time, ' +
    'and gentler rephrasing has already been tried. ' +
    'Rewrite it to fit the display time while producing a COMPLETE, READABLE English subtitle.\n' +
    '\n' +
    'Hard requirements:\n' +
    '- The result MUST be a grammatical English sentence with explicit subject and verb\n' +
    '- The result MUST start with a capital letter and end with appropriate punctuation\n' +
    '- The result MUST keep all technical terms, proper nouns, numbers, equations exactly as in the source\n' +
    '- The result MUST NOT use pronouns like "this", "that", "it" without clear referents\n' +
    '- The result MUST NOT be a fragment, keyword list, or telegraphic phrase\n' +
    '\n' +
    'You MAY:\n' +
    '- Drop redundant explanations, examples, hedges, soft modifiers\n' +
    '- Combine multiple clauses into one\n' +
    '- Replace verbose phrases with concise equivalents\n' +
    '- Drop topic markers and rhetorical asides\n' +
    '\n' +
    'Aim for roughly 50-70% of the original character count. ' +
    'Do not include line breaks in your response. ' +
    'Respond with JSON: {"text": "<rewritten subtitle>"}'
  )
}

async function callCore(
  enText: string,
  jaText: string,
  settings: AdminSettings,
): Promise<string> {
  const connection = requireAiConnection(settings)
  const model = requireChatModelForProvider(settings, resolveCompressModelId(settings), 'compress core')
  const systemPrompt = buildCoreSystemPrompt()

  const response = await tauriFetch(`${connection.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(connection.apiKey ? { Authorization: `Bearer ${connection.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model,
      temperature: 0.0,
      response_format: resolveJsonResponseFormatForProvider(settings),
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
  const parsed = parseJsonObjectFromLlmContent(content, 'compress_core')
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
