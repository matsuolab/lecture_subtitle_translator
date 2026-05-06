import type { AdminSettings } from '@/types/adminSettings'
import type { EnBlock, PipelineThresholds } from './blockTypes'
import { computeMetrics, classifyViolation } from './metrics'
import { formatLines } from './formatLines'
import { resolveExpandModelId, resolveExpandSystemPrompt } from './prompts'
import { normalizeSpaces } from './textUtils'

async function callExpand(
  enText: string,
  jaText: string,
  settings: AdminSettings,
): Promise<string> {
  const apiKey = settings.openaiApiKey.trim()
  const baseUrl = (settings.openaiCompatibleBaseUrl.trim() || 'https://api.openai.com/v1').replace(/\/$/, '')
  const model = resolveExpandModelId(settings)
  const systemPrompt = resolveExpandSystemPrompt(settings, settings.expandPromptOverride)

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
        { role: 'user', content: `Japanese source:\n${jaText}\n\nCurrent English subtitle:\n${enText.replace(/\n/g, ' ')}` },
      ],
    }),
  })

  if (!response.ok) {
    const detail = await response.text()
    throw new Error(`expand API returned HTTP ${response.status}: ${detail}`)
  }

  const payload = await response.json()
  const content: string = payload?.choices?.[0]?.message?.content ?? ''
  const parsed = JSON.parse(content) as { text?: unknown }
  const text = typeof parsed.text === 'string' ? parsed.text : ''
  return normalizeSpaces(text.trim())
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
    for (let attempt = 0; attempt < thresholds.maxExpandPerBlock - block.expandCount; attempt++) {
      const expanded = await callExpand(current.enText, current.jaText, settings)
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

    results.push(current)
  }

  return results
}
