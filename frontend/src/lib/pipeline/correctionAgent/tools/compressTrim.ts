import type { AdminSettings } from '@/types/adminSettings'
import type { EnBlock, PipelineThresholds } from '../../blockTypes'
import { resolveCompressModelId } from '../../prompts'
import { loadLanguageProfileConfig, type LanguageProfileConfig } from '../../languageProfileConfig'
import { requireChatModelForProvider } from '../../aiProvider'
import type { AgentThresholds, DecisionContext, TimelinePatch, Tool } from '../types'
import { buildBudgetHint } from './budgetHint'
import { buildSubtitleEditUserContent } from './subtitleEditPrompt'
import { callSubtitleLlm, type SubtitleLlmCallResult } from './callSubtitleLlm'

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
  budgetHint: string,
  languages: LanguageProfileConfig,
  settings: AdminSettings,
): Promise<SubtitleLlmCallResult> {
  const model = requireChatModelForProvider(settings, resolveCompressModelId(settings), 'compress trim')
  const systemPrompt = buildTrimSystemPrompt(settings)
  return callSubtitleLlm(
    {
      model,
      systemPrompt,
      userContent: buildSubtitleEditUserContent(languages, jaText, enText.replace(/\n/g, ' '), `\n\n${budgetHint}`),
      temperature: 0.0,
      nodeName: 'compress_trim',
    },
    settings,
  )
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
    thresholds: PipelineThresholds & AgentThresholds,
  ): Promise<TimelinePatch> {
    const budgetHint = buildBudgetHint(block, thresholds)
    const languages = loadLanguageProfileConfig(settings)
    const result = await callTrim(block.enText, block.jaText, budgetHint, languages, settings)

    if (result.errorMessage) {
      return {
        replaceBlocks: [block],
        dirtyBlockIds: [String(block.id)],
        changed: false,
        warning: `compress_trim: ${result.errorMessage}`,
      }
    }

    const trimmed = result.text
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
