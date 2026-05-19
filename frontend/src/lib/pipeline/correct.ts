import type { TranscriptSegment } from './types'
import { normalizeSpaces } from './textUtils'
import type { AdminSettings } from '@/types/adminSettings'
import { requireAiConnection, requireChatModelForProvider, resolveAiProvider } from './aiProvider'
import { tauriFetch } from '@/lib/tauriFetch'
import { parseJsonObjectFromLlmContent } from './jsonResponse'
import { mapWithConcurrency, normalizeConcurrency } from '@/lib/concurrency'

const MAX_SEGMENTS_PER_REQUEST = 20
const COUNT_MISMATCH_RE = /correction API returned (\d+) items for (\d+) inputs/
const LOCAL_MAX_SEGMENTS_PER_REQUEST = 4

class CorrectionRetryableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CorrectionRetryableError'
  }
}

const SYSTEM_PROMPT =
  'あなたは日本語書き起こしテキストの校正専門家です。\n' +
  '\n' +
  'Input format:  {"segments": [{"id": N, "text": "..."}]}\n' +
  'Output format: {"corrections": [{"id": N, "text": "..."}]}\n' +
  '\n' +
  '修正ルール:\n' +
  '1. フィラー語を除去（えー、ええ、あの、あのー、えーと、そのー、まあ、ちょっと等）\n' +
  '2. 専門用語リストにある誤認識を正しい表記に修正\n' +
  '3. 口語表現を自然な書き言葉に整える\n' +
  '4. ASR由来の明らかな誤変換・同音異義語ミス・文脈上不自然な語を、自然で意味の通る日本語に修正する\n' +
  '5. 数量・件数・時制・主語述語の対応を文脈に合わせて整える\n' +
  '6. 文の意味・情報量は変えない（要約・追加は禁止）\n' +
  '\n' +
  'ASR誤変換の扱い:\n' +
  '- 文として意味が通らない場合は、最も尤もらしい元の表現へ修正してよい\n' +
  '- 例: 誤字、脱字、助詞抜け、同音異義語、専門語の聞き間違い、漢字変換ミス\n' +
  '- ただし推測で新情報を足さない。文脈から強く支持される修正だけ行う\n' +
  '\n' +
  'CRITICAL: Output EXACTLY one correction per input segment. Array length MUST equal input array length.\n' +
  '意味を大きく変える修正は絶対にしないこと。'

function levenshteinRatio(a: string, b: string): number {
  if (a === b) return 1.0
  if (a.length === 0 || b.length === 0) return 0.0

  const lb = b.length
  const dp: number[] = Array.from({ length: lb + 1 }, (_, i) => i)

  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]
    dp[0] = i
    for (let j = 1; j <= lb; j++) {
      const temp = dp[j]
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1])
      prev = temp
    }
  }

  return 1.0 - dp[lb] / Math.max(a.length, lb)
}

export interface CorrectionOptions {
  threshold?: number
}

export interface CorrectedSegmentLite extends TranscriptSegment {
  correctedText: string
  correctionDistance: number
  correctionFlagged: boolean
}

async function callCorrectionApi(
  segments: Array<{ id: number; text: string }>,
  glossaryTerms: string[],
  apiKey: string,
  baseUrl: string,
  model: string,
): Promise<string[]> {
  const glossaryNote =
    glossaryTerms.length > 0
      ? `【専門用語リスト】\n${glossaryTerms.slice(0, 100).join('、')}\n\n`
      : ''

  const response = await tauriFetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({
      model,
      temperature: 0.1,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: JSON.stringify({
            segments: [
              {
                id: 1,
                text: 'えーっと機械学習というのはですね、データから自動的に学習するアルゴリズムのことです。',
              },
              {
                id: 2,
                text: '現時点で出見中7件完了しています。',
              },
              {
                id: 3,
                text: 'こちらはよやく機能のせっけいを進めています。',
              },
            ],
          }),
        },
        {
          role: 'assistant',
          content: JSON.stringify({
            corrections: [
              { id: 1, text: '機械学習とは、データから自動的に学習するアルゴリズムのことです。' },
              { id: 2, text: '現時点で未提出7件を完了しています。' },
              { id: 3, text: 'こちらは予約機能の設計を進めています。' },
            ],
          }),
        },
        {
          role: 'user',
          content: glossaryNote + JSON.stringify({ segments }),
        },
      ],
    }),
  })

  if (!response.ok) {
    const detail = await response.text()
    throw new Error(`correction API returned HTTP ${response.status}: ${detail}`)
  }

  const payload = await response.json()
  const content: string = payload?.choices?.[0]?.message?.content ?? ''
  if (!content.trim()) {
    throw new CorrectionRetryableError(
      `correction API response did not include message content. payload=${summarizeCorrectionPayload(payload)}`,
    )
  }

  let parsed: Record<string, unknown>
  try {
    parsed = parseJsonObjectFromLlmContent(content, 'correction')
  } catch (error) {
    throw new CorrectionRetryableError(
      `${error instanceof Error ? error.message : String(error)}. content=${content.slice(0, 500)}`,
    )
  }

  const corrections = parsed.corrections
  if (!Array.isArray(corrections)) {
    throw new CorrectionRetryableError(
      `correction response did not contain corrections array. content=${content.slice(0, 500)}`,
    )
  }
  if (corrections.length !== segments.length) {
    throw new CorrectionRetryableError(
      `correction API returned ${corrections.length} items for ${segments.length} inputs`,
    )
  }

  const byId = new Map<number, string>()
  for (const c of corrections) {
    if (c && typeof c === 'object' && 'id' in c && 'text' in c) {
      byId.set(Number(c.id), normalizeSpaces(String(c.text)))
    }
  }
  return segments.map((seg) => byId.get(seg.id) ?? normalizeSpaces(seg.text))
}

function summarizeCorrectionPayload(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return String(payload)
  const row = payload as Record<string, unknown>
  const choices = Array.isArray(row.choices) ? row.choices : []
  const firstChoice = choices[0] as Record<string, unknown> | undefined
  const message = firstChoice?.message as Record<string, unknown> | undefined
  const summary = {
    object: row.object,
    model: row.model,
    choices: choices.length,
    finishReason: firstChoice?.finish_reason,
    messageKeys: message ? Object.keys(message) : [],
    hasReasoningContent: typeof message?.reasoning_content === 'string',
    reasoningPreview: typeof message?.reasoning_content === 'string'
      ? String(message.reasoning_content).slice(0, 300)
      : undefined,
    usage: row.usage,
  }
  return JSON.stringify(summary)
}

function isRetryableCorrectionError(error: unknown): boolean {
  if (error instanceof CorrectionRetryableError) return true
  const message = error instanceof Error ? error.message : String(error ?? '')
  return COUNT_MISMATCH_RE.test(message)
}

function formatSegmentFailure(
  segment: { id: number; text: string },
  error: unknown,
): Error {
  const message = error instanceof Error ? error.message : String(error ?? '')
  return new Error(
    `correction failed for segment id=${segment.id}: ${message}. source=${segment.text.slice(0, 500)}`,
  )
}

async function correctBatchWithFallback(
  segments: Array<{ id: number; text: string }>,
  glossaryTerms: string[],
  apiKey: string,
  baseUrl: string,
  model: string,
): Promise<string[]> {
  if (segments.length === 0) return []
  try {
    return await callCorrectionApi(segments, glossaryTerms, apiKey, baseUrl, model)
  } catch (error) {
    if (!isRetryableCorrectionError(error)) throw error
    if (segments.length === 1) throw formatSegmentFailure(segments[0], error)
  }
  const splitAt = Math.ceil(segments.length / 2)
  const left = await correctBatchWithFallback(segments.slice(0, splitAt), glossaryTerms, apiKey, baseUrl, model)
  const right = await correctBatchWithFallback(segments.slice(splitAt), glossaryTerms, apiKey, baseUrl, model)
  return [...left, ...right]
}

async function correctWithLlm(
  segments: TranscriptSegment[],
  apiKey: string,
  baseUrl: string,
  model: string,
  glossaryTerms: string[],
  threshold: number,
  maxSegmentsPerRequest: number,
  requestConcurrency: number,
): Promise<CorrectedSegmentLite[]> {
  const inputs = segments.map((seg) => ({ id: seg.id ?? 0, text: seg.text ?? '' }))
  const batches: Array<Array<{ id: number; text: string }>> = []

  for (let start = 0; start < inputs.length; start += maxSegmentsPerRequest) {
    batches.push(inputs.slice(start, start + maxSegmentsPerRequest))
  }
  const batchResults = await mapWithConcurrency(
    batches.length,
    requestConcurrency,
    (index) => correctBatchWithFallback(batches[index], glossaryTerms, apiKey, baseUrl, model),
  )
  const correctedTexts = batchResults.flat()

  return segments.map((seg, idx) => {
    const source = seg.text ?? ''
    const corrected = correctedTexts[idx] ?? normalizeSpaces(source)
    const distance = Math.round((1.0 - levenshteinRatio(source, corrected)) * 10000) / 10000
    return {
      ...seg,
      correctedText: corrected,
      correctionDistance: distance,
      correctionFlagged: distance > threshold,
    }
  })
}

export async function correctSegments(
  segments: TranscriptSegment[],
  options: CorrectionOptions = {},
  settings?: AdminSettings,
  glossaryTerms: string[] = [],
): Promise<CorrectedSegmentLite[]> {
  if (!settings) throw new Error('AI provider settings are required before running the pipeline')
  const connection = requireAiConnection(settings)
  const model = requireChatModelForProvider(settings, settings.correctionModel || settings.translationModel, 'correction')
  const maxSegmentsPerRequest = resolveAiProvider(settings) === 'local_openai'
    ? LOCAL_MAX_SEGMENTS_PER_REQUEST
    : MAX_SEGMENTS_PER_REQUEST

  const threshold = options.threshold ?? 0.2
  const requestConcurrency = normalizeConcurrency(settings.apiRequestConcurrency, 1)
  return correctWithLlm(
    segments,
    connection.apiKey,
    connection.baseUrl,
    model,
    glossaryTerms,
    threshold,
    maxSegmentsPerRequest,
    requestConcurrency,
  )
}
