import fs from 'node:fs'
import type { FixtureChunk, FixtureSegment } from './schema.js'

interface SelfMadeGlossaryEntry {
  disabled?: boolean
  formalEligible?: boolean
  assistiveEligible?: boolean
  ja?: string
  abbr?: string
  formula?: string
  displayText?: string
  spokenJa?: string
}

interface CorrectionResult {
  chunk: FixtureChunk
  correctionTerms: string[]
  changedSegments: number
}

const MAX_SEGMENTS_PER_REQUEST = 20

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

function normalizeSpaces(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function uniqueNonEmpty(values: Array<string | undefined | null>): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    const text = value?.trim()
    if (!text) continue
    const key = text.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(text)
  }
  return result
}

function levenshteinRatio(a: string, b: string): number {
  if (a === b) return 1
  if (a.length === 0 || b.length === 0) return 0
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i += 1) {
    let prev = dp[0]
    dp[0] = i
    for (let j = 1; j <= b.length; j += 1) {
      const temp = dp[j]
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1])
      prev = temp
    }
  }
  return 1 - dp[b.length] / Math.max(a.length, b.length)
}

function parseJsonObject(content: string): Record<string, unknown> {
  try {
    return JSON.parse(content) as Record<string, unknown>
  } catch {
    const start = content.indexOf('{')
    const end = content.lastIndexOf('}')
    if (start >= 0 && end > start) return JSON.parse(content.slice(start, end + 1)) as Record<string, unknown>
    throw new Error(`correction response is not JSON: ${content.slice(0, 500)}`)
  }
}

export function loadSelfMadeCorrectionTerms(glossaryPath: string): string[] {
  const raw = fs.readFileSync(glossaryPath, 'utf8')
  const entries = JSON.parse(raw) as SelfMadeGlossaryEntry[]
  const usableSelfMade = entries.filter((entry) =>
    !entry.disabled && (entry.formalEligible || entry.assistiveEligible),
  )
  return uniqueNonEmpty(usableSelfMade.flatMap((entry) => [
    entry.ja,
    entry.abbr,
    entry.formula,
    entry.displayText,
    entry.spokenJa,
  ])).slice(0, 160)
}

async function callCorrectionApi(
  segments: Array<{ id: number; text: string }>,
  glossaryTerms: string[],
  model: string,
): Promise<Map<number, string>> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) throw new Error('OPENAI_API_KEY is required for glossary correction.')
  const baseUrl = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '')
  const glossaryNote = glossaryTerms.length > 0
    ? `【専門用語リスト】\n${glossaryTerms.slice(0, 100).join('、')}\n\n`
    : ''

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
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
              { id: 1, text: 'えーっと機械学習というのはですね、データから自動的に学習するアルゴリズムのことです。' },
              { id: 2, text: '現時点で出見中7件完了しています。' },
              { id: 3, text: 'こちらはよやく機能のせっけいを進めています。' },
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
        { role: 'user', content: glossaryNote + JSON.stringify({ segments }) },
      ],
    }),
  })
  if (!response.ok) {
    throw new Error(`correction API returned HTTP ${response.status}: ${await response.text()}`)
  }
  const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> }
  const content = payload.choices?.[0]?.message?.content ?? ''
  const parsed = parseJsonObject(content)
  const corrections = parsed.corrections
  if (!Array.isArray(corrections) || corrections.length !== segments.length) {
    throw new Error(`correction API returned invalid corrections. content=${content.slice(0, 500)}`)
  }
  const byId = new Map<number, string>()
  for (const item of corrections) {
    if (item && typeof item === 'object') {
      const row = item as Record<string, unknown>
      byId.set(Number(row.id), normalizeSpaces(String(row.text ?? '')))
    }
  }
  return byId
}

async function correctBatch(
  segments: FixtureSegment[],
  glossaryTerms: string[],
  model: string,
): Promise<FixtureSegment[]> {
  const inputs = segments.map((segment) => ({ id: segment.id, text: segment.ja_text }))
  const corrected = await callCorrectionApi(inputs, glossaryTerms, model)
  return segments.map((segment) => {
    const source = segment.ja_text
    const text = corrected.get(segment.id) ?? normalizeSpaces(source)
    const distance = Math.round((1 - levenshteinRatio(source, text)) * 10000) / 10000
    return {
      ...segment,
      raw_ja_text: segment.raw_ja_text ?? source,
      ja_text: text,
      correction_distance: distance,
      correction_flagged: distance > 0.2,
    }
  })
}

export async function applyProductionGlossaryCorrection(
  chunk: FixtureChunk,
  glossaryPath: string,
  model: string,
): Promise<CorrectionResult> {
  const correctionTerms = loadSelfMadeCorrectionTerms(glossaryPath)
  const correctedSegments: FixtureSegment[] = []
  for (let start = 0; start < chunk.segments.length; start += MAX_SEGMENTS_PER_REQUEST) {
    correctedSegments.push(...await correctBatch(
      chunk.segments.slice(start, start + MAX_SEGMENTS_PER_REQUEST),
      correctionTerms,
      model,
    ))
  }
  return {
    chunk: {
      ...chunk,
      segments: correctedSegments,
    },
    correctionTerms,
    changedSegments: correctedSegments.filter((segment) => (segment.correction_distance ?? 0) > 0).length,
  }
}
