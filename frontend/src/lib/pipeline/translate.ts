import type { CorrectedSegment, TranslatedSegment } from './types'
import { normalizeSpaces } from './textUtils'
import type { AdminSettings } from '@/types/adminSettings'

const JA_CHAR_RE = /[぀-ヿ㐀-䶿一-鿿]/g
const MAX_SEGMENTS_PER_REQUEST = 40
const COUNT_MISMATCH_RE = /translation API returned (\d+) segments for (\d+) inputs/

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
): Promise<string[]> {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: 'gpt-4.1-mini',
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
  if (!Array.isArray(translations) || !translations.every((t) => typeof t === 'string')) {
    throw new Error('translation response was not valid JSON with a translations array')
  }
  if (translations.length !== texts.length) {
    throw new Error(
      `translation API returned ${translations.length} segments for ${texts.length} inputs`,
    )
  }
  return translations.map((t) => normalizeSpaces(t as string))
}

function isCountMismatchError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '')
  return COUNT_MISMATCH_RE.test(message)
}

async function translateBatchWithFallback(
  texts: string[],
  apiKey: string,
  baseUrl: string,
): Promise<string[]> {
  if (texts.length === 0) return []

  try {
    return await callOpenAICompatible(texts, apiKey, baseUrl)
  } catch (error) {
    if (!isCountMismatchError(error) || texts.length === 1) {
      throw error
    }
  }

  const splitAt = Math.ceil(texts.length / 2)
  const left = await translateBatchWithFallback(texts.slice(0, splitAt), apiKey, baseUrl)
  const right = await translateBatchWithFallback(texts.slice(splitAt), apiKey, baseUrl)
  return [...left, ...right]
}

async function translateInBatches(
  texts: string[],
  apiKey: string,
  baseUrl: string,
): Promise<string[]> {
  const translated: string[] = []
  for (let start = 0; start < texts.length; start += MAX_SEGMENTS_PER_REQUEST) {
    const batch = texts.slice(start, start + MAX_SEGMENTS_PER_REQUEST)
    const batchTranslations = await translateBatchWithFallback(batch, apiKey, baseUrl)
    translated.push(...batchTranslations)
  }
  return translated
}

function resolveApiConfig(settings: AdminSettings): { apiKey: string; baseUrl: string; providerLabel: string } {
  const provider = settings.translationProvider === 'local' ? 'openai' : settings.translationProvider
  if (provider === 'gemini') throw new Error('Gemini translation provider is not implemented yet')
  if (provider === 'deepl') throw new Error('DeepL translation provider is not implemented yet')

  const apiKey = settings.openaiApiKey.trim()
  const baseUrl = 'https://api.openai.com/v1'

  if (provider === 'openai' && !apiKey) {
    throw new Error('OpenAI API key is required before running the pipeline')
  }

  const providerLabel = 'OpenAI'
  return { apiKey, baseUrl, providerLabel }
}

export async function translateSegments(
  segments: CorrectedSegment[],
  settings: AdminSettings,
): Promise<TranslatedSegment[]> {
  if (segments.length === 0) {
    throw new Error('no corrected segments to translate')
  }

  const { apiKey, baseUrl, providerLabel } = resolveApiConfig(settings)
  const sourceTexts = segments.map((seg) => seg.ja_corrected || seg.text || '')
  const translatedTexts = await translateInBatches(sourceTexts, apiKey, baseUrl)

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
