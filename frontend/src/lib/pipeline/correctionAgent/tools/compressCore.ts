import type { AdminSettings } from '@/types/adminSettings'
import type { EnBlock, PipelineThresholds } from '../../blockTypes'
import { resolveCompressModelId } from '../../prompts'
import { loadLanguageProfileConfig, type LanguageProfileConfig } from '../../languageProfileConfig'
import { requireChatModelForProvider } from '../../aiProvider'
import type { AgentThresholds, DecisionContext, TimelinePatch, Tool } from '../types'
import { buildBudgetHint } from './budgetHint'
import { buildSubtitleEditUserContent } from './subtitleEditPrompt'
import { callSubtitleLlm, type SubtitleLlmCallResult } from './callSubtitleLlm'

function buildCoreSystemPrompt(subtitleLabel: string): string {
  return (
    'You are a subtitle editor performing aggressive rewriting. ' +
    'The current subtitle is significantly too long for its display time, ' +
    'and gentler rephrasing has already been tried. ' +
    `Rewrite it to fit the display time while producing a COMPLETE, READABLE ${subtitleLabel} subtitle.\n` +
    '\n' +
    'Hard requirements:\n' +
    `- The result MUST be a grammatical ${subtitleLabel} sentence with explicit subject and verb\n` +
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
  budgetHint: string,
  languages: LanguageProfileConfig,
  settings: AdminSettings,
): Promise<SubtitleLlmCallResult> {
  const model = requireChatModelForProvider(settings, resolveCompressModelId(settings), 'compress core')
  const systemPrompt = buildCoreSystemPrompt(languages.subtitle.label)
  return callSubtitleLlm(
    {
      model,
      systemPrompt,
      userContent: buildSubtitleEditUserContent(languages, jaText, enText.replace(/\n/g, ' '), `\n\n${budgetHint}`),
      temperature: 0.0,
      nodeName: 'compress_core',
    },
    settings,
  )
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
    thresholds: PipelineThresholds & AgentThresholds,
  ): Promise<TimelinePatch> {
    const budgetHint = buildBudgetHint(block, thresholds)
    const languages = loadLanguageProfileConfig(settings)
    const result = await callCore(block.enText, block.jaText, budgetHint, languages, settings)

    if (result.errorMessage) {
      return {
        replaceBlocks: [block],
        dirtyBlockIds: [String(block.id)],
        changed: false,
        warning: `compress_core: ${result.errorMessage}`,
      }
    }

    const core = result.text
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
