import type { AdminSettings } from '@/types/adminSettings'
import type { EnBlock, JaBlock } from './blockTypes'
import { computeMetrics } from './metrics'
import { normalizeSpaces } from './textUtils'
import { pickTranslateSystemPrompt, resolveTranslateModelId } from './prompts'
import { requireAiConnection, requireChatModelForProvider, resolveAiProvider } from './aiProvider'
import { tauriFetch } from '@/lib/tauriFetch'
import { parseJsonObjectFromLlmContent } from './jsonResponse'

const MAX_SEGMENTS_PER_REQUEST = 40
const LOCAL_MAX_SEGMENTS_PER_REQUEST = 4
const JA_CHAR_RE = /[぀-ヿ㐀-䶿一-鿿]/g
const COUNT_MISMATCH_RE = /translation API returned (\d+) segments for (\d+) inputs/

class TranslationRetryableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TranslationRetryableError'
  }
}

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
  maxSegmentsPerRequest: number
} {
  const connection = requireAiConnection(settings)
  const model = requireChatModelForProvider(settings, resolveTranslateModelId(settings.translationModel), 'translation')
  const maxSegmentsPerRequest = resolveAiProvider(settings) === 'local_openai'
    ? LOCAL_MAX_SEGMENTS_PER_REQUEST
    : MAX_SEGMENTS_PER_REQUEST
  return {
    apiKey: connection.apiKey,
    baseUrl: connection.baseUrl,
    providerLabel: connection.providerLabel,
    model,
    systemPrompt: pickTranslateSystemPrompt(model),
    maxSegmentsPerRequest,
  }
}

async function callOpenAICompatible(
  texts: string[],
  config: ReturnType<typeof resolveApiConfig>,
  glossaryTerms: string[],
): Promise<string[]> {
  const glossaryInstruction = glossaryTerms.length > 0
    ? `\n\nPROJECT GLOSSARY:\nUse these term mappings when the source text contains the Japanese term or related notation. Preserve official English terms exactly.\n${glossaryTerms.slice(0, 120).map(term => `- ${term}`).join('\n')}`
    : ''
  const response = await tauriFetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: config.model,
      temperature: 0.0,
      messages: [
        { role: 'system', content: config.systemPrompt + glossaryInstruction },
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
  const finishReason = payload?.choices?.[0]?.finish_reason
  if (finishReason === 'length') {
    throw new TranslationRetryableError(`translation API stopped because output length was reached. content=${content.slice(0, 500)}`)
  }
  if (!content.trim()) {
    throw new TranslationRetryableError(`translation API response did not include message content. payload=${summarizeTranslationPayload(payload)}`)
  }

  let parsed: Record<string, unknown>
  try {
    parsed = parseJsonObjectFromLlmContent(content, 'translation')
  } catch (error) {
    throw new TranslationRetryableError(
      `${error instanceof Error ? error.message : String(error)}. content=${content.slice(0, 500)}`,
    )
  }

  const translations = parsed.translations
  if (!Array.isArray(translations) || !translations.every((item) => typeof item === 'string')) {
    throw new TranslationRetryableError(
      `translation response was not valid JSON with a translations array. content=${content.slice(0, 500)}`,
    )
  }
  if (translations.length !== texts.length) {
    throw new TranslationRetryableError(`translation API returned ${translations.length} segments for ${texts.length} inputs`)
  }

  return translations.map((item) => normalizeSpaces(String(item)))
}

function summarizeTranslationPayload(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return String(payload)
  const row = payload as Record<string, unknown>
  const choices = Array.isArray(row.choices) ? row.choices : []
  const firstChoice = choices[0] as Record<string, unknown> | undefined
  const message = firstChoice?.message as Record<string, unknown> | undefined
  return JSON.stringify({
    object: row.object,
    model: row.model,
    choices: choices.length,
    finishReason: firstChoice?.finish_reason,
    messageKeys: message ? Object.keys(message) : [],
    hasReasoningContent: typeof message?.reasoning_content === 'string',
    usage: row.usage,
  })
}

function isRetryableTranslationError(error: unknown): boolean {
  if (error instanceof TranslationRetryableError) return true
  const message = error instanceof Error ? error.message : String(error ?? '')
  return COUNT_MISMATCH_RE.test(message)
}

function formatTranslationFailure(text: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error ?? '')
  return new Error(`translation failed for source=${text.slice(0, 500)}: ${message}`)
}

async function translateBatchWithFallback(
  texts: string[],
  config: ReturnType<typeof resolveApiConfig>,
  glossaryTerms: string[],
): Promise<string[]> {
  if (texts.length === 0) return []
  try {
    return await callOpenAICompatible(texts, config, glossaryTerms)
  } catch (error) {
    if (!isRetryableTranslationError(error)) throw error
    if (texts.length === 1) throw formatTranslationFailure(texts[0], error)
  }

  const splitAt = Math.ceil(texts.length / 2)
  const left = await translateBatchWithFallback(texts.slice(0, splitAt), config, glossaryTerms)
  const right = await translateBatchWithFallback(texts.slice(splitAt), config, glossaryTerms)
  return [...left, ...right]
}

async function translateInBatches(
  texts: string[],
  config: ReturnType<typeof resolveApiConfig>,
  glossaryTerms: string[],
): Promise<string[]> {
  const translated: string[] = []
  for (let start = 0; start < texts.length; start += config.maxSegmentsPerRequest) {
    const batch = texts.slice(start, start + config.maxSegmentsPerRequest)
    translated.push(...(await translateBatchWithFallback(batch, config, glossaryTerms)))
  }
  return translated
}

export async function translateEn(blocks: JaBlock[], settings: AdminSettings, glossaryTerms: string[] = []): Promise<EnBlock[]> {
  if (blocks.length === 0) return []

  const config = resolveApiConfig(settings)
  const sourceTexts = blocks.map((block) => block.jaText)
  const translatedTexts = await translateInBatches(sourceTexts, config, glossaryTerms)

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
