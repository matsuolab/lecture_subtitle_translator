import type { AdminSettings } from '@/types/adminSettings'
import type { EnBlock, PipelineThresholds } from './blockTypes'
import { computeMetrics, classifyViolation } from './metrics'
import { formatLines } from './formatLines'
import { resolveExpandModelId, resolveExpandSystemPrompt } from './prompts'
import { requireChatModelForProvider } from './aiProvider'
import { callSubtitleLlm, type SubtitleLlmCallResult } from './correctionAgent/tools/callSubtitleLlm'

async function callExpand(
  enText: string,
  jaText: string,
  settings: AdminSettings,
): Promise<SubtitleLlmCallResult> {
  const model = requireChatModelForProvider(settings, resolveExpandModelId(settings), 'expansion')
  const systemPrompt = resolveExpandSystemPrompt(settings, settings.expandPromptOverride)
  return callSubtitleLlm(
    {
      model,
      systemPrompt,
      userContent: `Japanese source:\n${jaText}\n\nCurrent English subtitle:\n${enText.replace(/\n/g, ' ')}`,
      temperature: 0.0,
      nodeName: 'expand_en',
    },
    settings,
  )
}

export async function expandEn(
  blocks: EnBlock[],
  settings: AdminSettings,
  thresholds: PipelineThresholds,
): Promise<EnBlock[]> {
  const results: EnBlock[] = []

  for (const block of blocks) {
    if (block.violation !== 'over_compressed') {
      results.push(block)
      continue
    }
    if (block.expandCount >= thresholds.maxExpandPerBlock) {
      results.push(block)
      continue
    }

    let current = block
    let lastFailure: string | undefined
    for (let attempt = 0; attempt < thresholds.maxExpandPerBlock - block.expandCount; attempt++) {
      const callResult = await callExpand(current.enText, current.jaText, settings)
      if (callResult.errorMessage) {
        // throw せず、失敗理由を保持してループ脱出。元のブロックを使う。
        lastFailure = callResult.errorMessage
        break
      }
      const expanded = callResult.text
      if (!expanded || expanded.length <= current.enText.length) break

      const formatted = formatLines([{ ...current, enRaw: expanded, enText: expanded }], thresholds)[0]
      const metrics = computeMetrics(formatted)
      const violation = classifyViolation(formatted, thresholds)
      const candidate: EnBlock = {
        ...formatted,
        enText: formatted.enText,
        enRaw: expanded,
        enChars: metrics.enChars,
        cps: Math.round(metrics.cps * 10) / 10,
        maxLineLen: metrics.maxLineLen,
        violation,
        expandCount: current.expandCount + 1,
        enTextOriginal: block.enTextOriginal ?? block.enText,
      }

      current = candidate
      if (violation !== 'over_compressed') break
    }

    results.push(lastFailure ? { ...current, expansionFailureReason: `expand_en: ${lastFailure}` } : current)
  }

  return results
}
