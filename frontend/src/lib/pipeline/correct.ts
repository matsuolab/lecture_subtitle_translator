import type { TranscriptSegment } from './types'
import { normalizeSpaces } from './textUtils'
import type { AdminSettings } from '@/types/adminSettings'
import { requireAiConnection } from './aiProvider'
import { tauriFetch } from '@/lib/tauriFetch'

const MAX_SEGMENTS_PER_REQUEST = 20
const COUNT_MISMATCH_RE = /correction API returned (\d+) items for (\d+) inputs/

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
): Promise<string[]> {
  const glossaryNote =
    glossaryTerms.length > 0
      ? `【専門用語リスト】\n${glossaryTerms.slice(0, 100).join('、')}\n\n`
      : ''

  const response = await tauriFetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4.1-mini',
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
  if (!content.trim()) throw new Error('correction API response did not include message content')

  let parsed: unknown
  try {
    parsed = JSON.parse(content.trim())
  } catch {
    const match = content.match(/\{[\s\S]*\}/)
    if (!match) throw new Error('correction response was not valid JSON')
    parsed = JSON.parse(match[0])
  }

  const corrections = (parsed as Record<string, unknown>)?.corrections
  if (!Array.isArray(corrections)) {
    throw new Error('correction response did not contain corrections array')
  }
  if (corrections.length !== segments.length) {
    throw new Error(
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

function isCountMismatchError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '')
  return COUNT_MISMATCH_RE.test(message)
}

async function correctBatchWithFallback(
  segments: Array<{ id: number; text: string }>,
  glossaryTerms: string[],
  apiKey: string,
  baseUrl: string,
): Promise<string[]> {
  if (segments.length === 0) return []
  try {
    return await callCorrectionApi(segments, glossaryTerms, apiKey, baseUrl)
  } catch (error) {
    if (!isCountMismatchError(error) || segments.length === 1) throw error
  }
  const splitAt = Math.ceil(segments.length / 2)
  const left = await correctBatchWithFallback(segments.slice(0, splitAt), glossaryTerms, apiKey, baseUrl)
  const right = await correctBatchWithFallback(segments.slice(splitAt), glossaryTerms, apiKey, baseUrl)
  return [...left, ...right]
}

async function correctWithLlm(
  segments: TranscriptSegment[],
  apiKey: string,
  baseUrl: string,
  glossaryTerms: string[],
  threshold: number,
): Promise<CorrectedSegmentLite[]> {
  const inputs = segments.map((seg) => ({ id: seg.id ?? 0, text: seg.text ?? '' }))
  const correctedTexts: string[] = []

  for (let start = 0; start < inputs.length; start += MAX_SEGMENTS_PER_REQUEST) {
    const batch = inputs.slice(start, start + MAX_SEGMENTS_PER_REQUEST)
    const batchResults = await correctBatchWithFallback(batch, glossaryTerms, apiKey, baseUrl)
    correctedTexts.push(...batchResults)
  }

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

  const threshold = options.threshold ?? 0.2
  return correctWithLlm(segments, connection.apiKey, connection.baseUrl, glossaryTerms, threshold)
}
