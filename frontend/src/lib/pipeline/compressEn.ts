import type { AdminSettings } from '@/types/adminSettings'
import type { EnBlock, PipelineThresholds } from './blockTypes'
import { computeMetrics, classifyViolation } from './metrics'
import { formatLines } from './formatLines'
import { resolveCompressModelId, resolveCompressSystemPrompt } from './prompts'
import { normalizeSpaces } from './textUtils'
import { requireAiConnection, resolveChatModelForProvider } from './aiProvider'
import { tauriFetch } from '@/lib/tauriFetch'

async function callCompress(
  enText: string,
  jaText: string,
  settings: AdminSettings,
): Promise<string> {
  const connection = requireAiConnection(settings)
  const model = resolveChatModelForProvider(settings, resolveCompressModelId(settings))
  const systemPrompt = resolveCompressSystemPrompt(settings, settings.compressPromptOverride)

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
        { role: 'user', content: `Japanese source:\n${jaText}\n\nCurrent English subtitle:\n${enText.replace(/\n/g, ' ')}` },
      ],
    }),
  })

  if (!response.ok) {
    const detail = await response.text()
    throw new Error(`compress API returned HTTP ${response.status}: ${detail}`)
  }

  const payload = await response.json()
  const content: string = payload?.choices?.[0]?.message?.content ?? ''
  const parsed = JSON.parse(content) as { text?: unknown }
  const text = typeof parsed.text === 'string' ? parsed.text : ''
  return normalizeSpaces(text.trim())
}

export async function compressEn(
  blocks: EnBlock[],
  settings: AdminSettings,
  thresholds: PipelineThresholds,
): Promise<EnBlock[]> {
  const results: EnBlock[] = []

  for (const block of blocks) {
    if (block.violation !== 'verbose_en' && block.violation !== 'line_length_only') {
      results.push(block)
      continue
    }
    if (block.compressCount >= thresholds.maxCompressPerBlock) {
      results.push(block)
      continue
    }

    let current = block
    for (let attempt = 0; attempt < thresholds.maxCompressPerBlock - block.compressCount; attempt++) {
      const compressed = await callCompress(current.enText, current.jaText, settings)
      if (!compressed || compressed.length >= current.enText.length) break

      const formatted = formatLines([{ ...current, enRaw: compressed, enText: compressed }], thresholds)[0]
      const metrics = computeMetrics(formatted)
      const violation = classifyViolation(formatted, thresholds)
      const candidate: EnBlock = {
        ...formatted,
        enText: formatted.enText,
        enRaw: compressed,
        enChars: metrics.enChars,
        cps: Math.round(metrics.cps * 10) / 10,
        maxLineLen: metrics.maxLineLen,
        violation,
        compressCount: current.compressCount + 1,
        enTextOriginal: block.enTextOriginal ?? block.enText,
      }

      current = candidate
      if (violation === 'ok' || violation === 'slow_speech') break
    }

    results.push(current)
  }

  return results
}
