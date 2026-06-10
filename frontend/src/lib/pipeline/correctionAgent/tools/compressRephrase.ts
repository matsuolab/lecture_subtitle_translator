import type { AdminSettings } from '@/types/adminSettings'
import type { EnBlock, PipelineThresholds } from '../../blockTypes'
import { resolveCompressModelId, resolveCompressSystemPrompt } from '../../prompts'
import { loadLanguageProfileConfig, type LanguageProfileConfig } from '../../languageProfileConfig'
import { requireChatModelForProvider } from '../../aiProvider'
import type { AgentThresholds, DecisionContext, TimelinePatch, Tool } from '../types'
import { buildBudgetHint } from './budgetHint'
import { buildSubtitleEditUserContent } from './subtitleEditPrompt'
import { callSubtitleLlm, type SubtitleLlmCallResult } from './callSubtitleLlm'

async function callCompress(
  enText: string,
  jaText: string,
  budgetHint: string,
  systemPrompt: string,
  languages: LanguageProfileConfig,
  settings: AdminSettings,
  model: string,
): Promise<SubtitleLlmCallResult> {
  const resolvedModel = requireChatModelForProvider(settings, model, 'compress rephrase')
  return callSubtitleLlm(
    {
      model: resolvedModel,
      systemPrompt,
      userContent: buildSubtitleEditUserContent(languages, jaText, enText.replace(/\n/g, ' '), `\n\n${budgetHint}`),
      temperature: 0.0,
      nodeName: 'compress_rephrase',
    },
    settings,
  )
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
    thresholds: PipelineThresholds & AgentThresholds,
  ): Promise<TimelinePatch> {
    const systemPrompt = resolveCompressSystemPrompt(settings, settings.compressPromptOverride)
    const model = resolveCompressModelId(settings)
    const budgetHint = buildBudgetHint(block, thresholds)
    const languages = loadLanguageProfileConfig(settings)
    const result = await callCompress(block.enText, block.jaText, budgetHint, systemPrompt, languages, settings, model)

    if (result.errorMessage) {
      // throw せず warning として correctionEngine ループへ伝搬。元のブロックを維持。
      return {
        replaceBlocks: [block],
        dirtyBlockIds: [String(block.id)],
        changed: false,
        warning: `compress_rephrase: ${result.errorMessage}`,
      }
    }

    const compressed = result.text
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
