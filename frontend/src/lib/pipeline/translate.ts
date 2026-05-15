import type { CorrectedSegment, TranslatedSegment } from './types'
import { normalizeSpaces } from './textUtils'
import type { AdminSettings } from '@/types/adminSettings'
import { requireAiConnection, requireChatModelForProvider, resolveAiProvider } from './aiProvider'
import { tauriFetch } from '@/lib/tauriFetch'
import { parseJsonObjectFromLlmContent } from './jsonResponse'

const JA_CHAR_RE = /[぀-ヿ㐀-䶿一-鿿]/g
const MAX_SEGMENTS_PER_REQUEST = 40
const LOCAL_MAX_SEGMENTS_PER_REQUEST = 4
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
  if (!trl) return true
  if (trl === src) return true
  const nonSpace = [...trl].filter((c) => c.trim())
  if (nonSpace.length === 0) return true
  const jaCount = (trl.match(JA_CHAR_RE) ?? []).length
  return jaCount / nonSpace.length >= 0.35
}

async function callOpenAICompatible(
  texts: string[],
  apiKey: string,
  baseUrl: string,
  model: string,
): Promise<string[]> {
  const response = await tauriFetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({
      model,
      temperature: 0.0,
      messages: [
        {
          role: 'system',
          content:
            'You are a subtitle translator for academic lectures. Translate each Japanese segment into natural English.\n' +
            '\n' +
            'Input format:  {"segments": ["seg0", "seg1", ...]}\n' +
            'Output format: {"translations": ["trans0", "trans1", ...]}\n' +
            '\n' +
            'MAPPING (CRITICAL):\n' +
            '- translations[i] is the English translation of segments[i]\n' +
            '- Output EXACTLY one translation per input segment\n' +
            '- NEVER merge or split segments\n' +
            '- Output array length MUST equal input array length\n' +
            '\n' +
            'STYLE (BBC/Netflix subtitle standards):\n' +
            '- casual-academic tone; contractions are fine (we\'ll, it\'s, don\'t)\n' +
            '- Short sentences; subject and verb first\n' +
            '- Avoid front-heavy structures — NOT "To solve X, we..." → "We solved X by..."\n' +
            '- Never use "What we do is..." / "What this means is..." patterns\n' +
            '- Avoid nominalizations: "use" not "utilization", "show" not "demonstrate"\n' +
            '\n' +
            'STANDALONE RULE:\n' +
            '- Each block appears alone on screen; the viewer cannot look back\n' +
            '- Never start a block with "This", "That", "It", or "These" referring to the previous block — repeat the noun instead\n' +
            '\n' +
            'TERMINOLOGY:\n' +
            '- Preserve technical terms exactly as-is: RAG, HyDE, LLM, ReAct, etc.\n' +
            '- Never translate framework, algorithm, or product names\n' +
            '- Katakana-rendered terms: restore to original form (ハイド → HyDE, リアクト → ReAct)',
        },
        {
          role: 'user',
          content: JSON.stringify({ segments: ['機械学習とは何ですか。', 'ディープラーニングについて説明します。', 'では次のトピックに移ります。'] }),
        },
        {
          role: 'assistant',
          content: JSON.stringify({ translations: ['What is machine learning?', 'I will explain deep learning.', "Now let's move on to the next topic."] }),
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
  if (!Array.isArray(translations) || !translations.every((t) => typeof t === 'string')) {
    throw new TranslationRetryableError(
      `translation response was not valid JSON with a translations array. content=${content.slice(0, 500)}`,
    )
  }
  if (translations.length !== texts.length) {
    throw new TranslationRetryableError(
      `translation API returned ${translations.length} segments for ${texts.length} inputs`,
    )
  }
  return translations.map((t) => normalizeSpaces(t as string))
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
  apiKey: string,
  baseUrl: string,
  model: string,
): Promise<string[]> {
  if (texts.length === 0) return []

  try {
    return await callOpenAICompatible(texts, apiKey, baseUrl, model)
  } catch (error) {
    if (!isRetryableTranslationError(error)) throw error
    if (texts.length === 1) throw formatTranslationFailure(texts[0], error)
  }

  const splitAt = Math.ceil(texts.length / 2)
  const left = await translateBatchWithFallback(texts.slice(0, splitAt), apiKey, baseUrl, model)
  const right = await translateBatchWithFallback(texts.slice(splitAt), apiKey, baseUrl, model)
  return [...left, ...right]
}

async function translateInBatches(
  texts: string[],
  apiKey: string,
  baseUrl: string,
  model: string,
  maxSegmentsPerRequest: number,
): Promise<string[]> {
  const translated: string[] = []
  for (let start = 0; start < texts.length; start += maxSegmentsPerRequest) {
    const batch = texts.slice(start, start + maxSegmentsPerRequest)
    const batchTranslations = await translateBatchWithFallback(batch, apiKey, baseUrl, model)
    translated.push(...batchTranslations)
  }
  return translated
}

function resolveApiConfig(settings: AdminSettings): { apiKey: string; baseUrl: string; providerLabel: string; model: string; maxSegmentsPerRequest: number } {
  const connection = requireAiConnection(settings)
  const model = requireChatModelForProvider(settings, settings.translationModel, 'translation')
  const maxSegmentsPerRequest = resolveAiProvider(settings) === 'local_openai'
    ? LOCAL_MAX_SEGMENTS_PER_REQUEST
    : MAX_SEGMENTS_PER_REQUEST
  return {
    apiKey: connection.apiKey,
    baseUrl: connection.baseUrl,
    providerLabel: connection.providerLabel,
    model,
    maxSegmentsPerRequest,
  }
}

export async function translateSegments(
  segments: CorrectedSegment[],
  settings: AdminSettings,
): Promise<TranslatedSegment[]> {
  if (segments.length === 0) {
    throw new Error('no corrected segments to translate')
  }

  const { apiKey, baseUrl, providerLabel, model, maxSegmentsPerRequest } = resolveApiConfig(settings)
  const sourceTexts = segments.map((seg) => seg.ja_corrected || seg.text || '')
  const translatedTexts = await translateInBatches(sourceTexts, apiKey, baseUrl, model, maxSegmentsPerRequest)

  const untranslatedIds: number[] = []
  const result: TranslatedSegment[] = segments.map((seg, idx) => {
    const en = translatedTexts[idx]
    if (looksUntranslated(sourceTexts[idx], en)) {
      untranslatedIds.push(idx + 1)
    }
    return {
      ...seg,
      en,
      translation_flagged: false,
      translation_provider: providerLabel,
    }
  })

  if (untranslatedIds.length > 0) {
    throw new Error(
      `translation output appears untranslated at segment(s): ${untranslatedIds.join(', ')}`,
    )
  }

  return result
}
