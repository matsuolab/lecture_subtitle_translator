import type { AdminSettings } from '@/types/adminSettings'
import type { EnBlock, JaBlock } from './blockTypes'
import { computeMetrics } from './metrics'
import { normalizeSpaces } from './textUtils'
import { pickTranslateSystemPrompt, resolveTranslateModelId } from './prompts'

const MAX_SEGMENTS_PER_REQUEST = 40
const JA_CHAR_RE = /[぀-ヿ㐀-䶿一-鿿]/g
const COUNT_MISMATCH_RE = /translation API returned (\d+) segments for (\d+) inputs/

function looksUntranslated(source: string, translated: string): boolean {
  const src = normalizeSpaces(source)
  const trl = normalizeSpaces(translated)
  if (!trl || trl === src) return true
  const nonSpace = [...trl].filter((c) => c.trim())
  if (nonSpace.length === 0) return true
  const jaCount = (trl.match(JA_CHAR_RE) ?? []).length
  return jaCount / nonSpace.length >= 0.35
}

function resolveApiConfig(settings: AdminSettings): {
  apiKey: string
  baseUrl: string
  providerLabel: string
  model: string
  systemPrompt: string
} {
  const provider = settings.translationProvider === 'local' ? 'openai' : settings.translationProvider
  if (provider === 'gemini') throw new Error('Gemini translation provider is not implemented yet')
  if (provider === 'deepl') throw new Error('DeepL translation provider is not implemented yet')

  const apiKey = settings.openaiApiKey.trim()
  const baseUrl = (settings.openaiCompatibleBaseUrl.trim() || 'https://api.openai.com/v1').replace(/\/$/, '')
  if (provider === 'openai' && !apiKey) {
    throw new Error('OpenAI API key is required before running the pipeline')
  }

  const model = resolveTranslateModelId(settings.translationModel)
  return {
    apiKey,
    baseUrl,
    providerLabel: 'OpenAI',
    model,
    systemPrompt: pickTranslateSystemPrompt(model),
  }
}

async function callOpenAICompatible(
  texts: string[],
  config: ReturnType<typeof resolveApiConfig>,
): Promise<string[]> {
  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: config.model,
      temperature: 0.0,
      messages: [
        { role: 'system', content: config.systemPrompt },
        {
          role: 'user',
          content: JSON.stringify({
            segments: ['機械学習とは何ですか。', 'ディープラーニングについて説明します。'],
          }),
        },
        {
          role: 'assistant',
          content: JSON.stringify({
            translations: ['What is machine learning?', 'I will explain deep learning.'],
          }),
        },
        {
          role: 'user',
          content: JSON.stringify({ segments: texts }),
        },
      ],
    }),
  })

  if (!response.ok) {
    const detail = await response.text()
    throw new Error(`translation API returned HTTP ${response.status}: ${detail}`)
  }

  const payload = await response.json()
  const content: string = payload?.choices?.[0]?.message?.content ?? ''
  if (!content.trim()) throw new Error('translation API response did not include message content')

  let parsed: unknown
  try {
    parsed = JSON.parse(content.trim())
  } catch {
    const match = content.match(/\{[\s\S]*\}/)
    if (!match) throw new Error('translation response was not valid JSON with a translations array')
    parsed = JSON.parse(match[0])
  }

  const translations = (parsed as Record<string, unknown>)?.translations
  if (!Array.isArray(translations) || !translations.every((item) => typeof item === 'string')) {
    throw new Error('translation response was not valid JSON with a translations array')
  }
  if (translations.length !== texts.length) {
    throw new Error(`translation API returned ${translations.length} segments for ${texts.length} inputs`)
  }

  return translations.map((item) => normalizeSpaces(String(item)))
}

function isCountMismatchError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '')
  return COUNT_MISMATCH_RE.test(message)
}

async function translateBatchWithFallback(
  texts: string[],
  config: ReturnType<typeof resolveApiConfig>,
): Promise<string[]> {
  if (texts.length === 0) return []
  try {
    return await callOpenAICompatible(texts, config)
  } catch (error) {
    if (!isCountMismatchError(error) || texts.length === 1) throw error
  }

  const splitAt = Math.ceil(texts.length / 2)
  const left = await translateBatchWithFallback(texts.slice(0, splitAt), config)
  const right = await translateBatchWithFallback(texts.slice(splitAt), config)
  return [...left, ...right]
}

async function translateInBatches(
  texts: string[],
  config: ReturnType<typeof resolveApiConfig>,
): Promise<string[]> {
  const translated: string[] = []
  for (let start = 0; start < texts.length; start += MAX_SEGMENTS_PER_REQUEST) {
    const batch = texts.slice(start, start + MAX_SEGMENTS_PER_REQUEST)
    translated.push(...(await translateBatchWithFallback(batch, config)))
  }
  return translated
}

export async function translateEn(blocks: JaBlock[], settings: AdminSettings): Promise<EnBlock[]> {
  if (blocks.length === 0) return []

  const config = resolveApiConfig(settings)
  const sourceTexts = blocks.map((block) => block.jaText)
  const translatedTexts = await translateInBatches(sourceTexts, config)

  const untranslatedIds: number[] = []
  const result = blocks.map((block, index) => {
    const enRaw = translatedTexts[index] ?? ''
    if (looksUntranslated(block.jaText, enRaw)) untranslatedIds.push(block.id)
    const metrics = computeMetrics({ ...block, enRaw })
    return {
      ...block,
      enText: enRaw,
      enRaw,
      enChars: metrics.enChars,
      cps: metrics.cps,
      maxLineLen: metrics.maxLineLen,
      violation: 'ok' as const,
      expandCount: 0,
      compressCount: 0,
    }
  })

  if (untranslatedIds.length > 0) {
    throw new Error(`translation output appears untranslated at block(s): ${untranslatedIds.join(', ')}`)
  }

  return result
}
