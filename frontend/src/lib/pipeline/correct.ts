import type { TranscriptSegment } from './types'
import { normalizeSpaces } from './textUtils'
import type { AdminSettings } from '@/types/adminSettings'
import { requireChatModelForProvider, resolveAiProvider } from './aiProvider'
import { parseJsonObjectFromLlmContent } from './jsonResponse'
import { mapWithConcurrency, normalizeConcurrency } from '@/lib/concurrency'
import { llmCallWithMeta, isAbortableFailure } from './llmCallWithMeta'
import { DEFAULT_CORRECTION_FEW_SHOT_JSON } from './prompts'

const MAX_SEGMENTS_PER_REQUEST = 20
const LOCAL_MAX_SEGMENTS_PER_REQUEST = 4
/** 単一セグメントまで分割しても失敗した時、ここで指定回数までリトライ。それでも駄目なら原文を返す。*/
const PER_LEAF_RETRY_MAX_ATTEMPTS = 2

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

const FEW_SHOT_USER_CONTENT = JSON.stringify({
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
})

const FEW_SHOT_ASSISTANT_CONTENT = JSON.stringify({
  corrections: [
    { id: 1, text: '機械学習とは、データから自動的に学習するアルゴリズムのことです。' },
    { id: 2, text: '現時点で未提出7件を完了しています。' },
    { id: 3, text: 'こちらは予約機能の設計を進めています。' },
  ],
})

function buildCorrectionSystemPrompt(settings: AdminSettings): string {
  const additional = settings.correctionAdditionalInstructions.trim()
  return additional ? `${SYSTEM_PROMPT}\n\n${additional}` : SYSTEM_PROMPT
}

function resolveCorrectionFewShotMessages(settings: AdminSettings): Array<{ role: 'user' | 'assistant'; content: string }> {
  const raw = settings.correctionFewShotJson.trim() || DEFAULT_CORRECTION_FEW_SHOT_JSON
  try {
    const parsed = JSON.parse(raw) as { segments?: unknown; corrections?: unknown }
    if (Array.isArray(parsed.segments) && Array.isArray(parsed.corrections)) {
      return [
        { role: 'user', content: JSON.stringify({ segments: parsed.segments }) },
        { role: 'assistant', content: JSON.stringify({ corrections: parsed.corrections }) },
      ]
    }
  } catch {
    // Fall back to the stable built-in example below.
  }
  return [
    { role: 'user', content: FEW_SHOT_USER_CONTENT },
    { role: 'assistant', content: FEW_SHOT_ASSISTANT_CONTENT },
  ]
}

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
  /** 補正失敗時の理由（成功時は undefined）。失敗時は correctedText に原文を返す。*/
  correctionFailureReason?: string
  /** 補正に要した試行回数（1=初回成功、>1=リトライあり、PER_LEAF_RETRY_MAX_ATTEMPTS=最終的に諦め）。
   *  注: EnBlock 側の `correctionAttempts`（配列）と区別するためにリネーム済み。*/
  correctionRetryAttempts?: number
}

/**
 * 1 バッチ分を Chat Completions API へ送信した結果。
 * - errorMessage / abortable は呼び出し側がリトライ・分割・諦めを判断するための情報。
 * - 失敗時 texts は「原文を normalize したもの」が入る（呼び出し側が fall-back として使える）。
 */
interface CorrectionApiResult {
  texts: string[]
  errorMessage?: string
  abortable: boolean
}

async function callCorrectionApi(
  segments: Array<{ id: number; text: string }>,
  glossaryTerms: string[],
  model: string,
  settings: AdminSettings,
): Promise<CorrectionApiResult> {
  const glossaryNote =
    glossaryTerms.length > 0
      ? `【専門用語リスト】\n${glossaryTerms.slice(0, 100).join('、')}\n\n`
      : ''

  const fallbackTexts = segments.map((s) => normalizeSpaces(s.text))

  const result = await llmCallWithMeta(
    {
      model,
      systemPrompt: buildCorrectionSystemPrompt(settings),
      userContent: glossaryNote + JSON.stringify({ segments }),
      fewShotMessages: resolveCorrectionFewShotMessages(settings),
      temperature: 0.1,
      // response_format は付けない（OpenAI 既定 text のまま、既存挙動を保つ）
      responseFormat: 'omit',
      nodeName: 'correctJa',
    },
    settings,
  )

  if (result.errorMessage) {
    return {
      texts: fallbackTexts,
      errorMessage: result.errorMessage,
      abortable: isAbortableFailure(result),
    }
  }

  let parsed: Record<string, unknown>
  try {
    parsed = parseJsonObjectFromLlmContent(result.content, 'correction')
  } catch (error) {
    return {
      texts: fallbackTexts,
      errorMessage: `parse_failed: ${error instanceof Error ? error.message : String(error)}. content=${result.content.slice(0, 300)}`,
      abortable: false,
    }
  }

  const corrections = parsed.corrections
  if (!Array.isArray(corrections)) {
    return {
      texts: fallbackTexts,
      errorMessage: `no_corrections_array. content=${result.content.slice(0, 300)}`,
      abortable: false,
    }
  }
  if (corrections.length !== segments.length) {
    return {
      texts: fallbackTexts,
      errorMessage: `count_mismatch: returned ${corrections.length} items for ${segments.length} inputs`,
      abortable: false,
    }
  }

  const byId = new Map<number, string>()
  for (const c of corrections) {
    if (c && typeof c === 'object' && 'id' in c && 'text' in c) {
      byId.set(Number((c as { id: unknown }).id), normalizeSpaces(String((c as { text: unknown }).text)))
    }
  }
  return {
    texts: segments.map((seg) => byId.get(seg.id) ?? normalizeSpaces(seg.text)),
    abortable: false,
  }
}

interface BatchOutcome {
  texts: string[]
  /** 各セグメントが失敗した時の理由（成功時は undefined） */
  failureReasons: Array<string | undefined>
  /** 各セグメントが要した試行回数 */
  attempts: number[]
}

function makeFailureOutcome(
  segments: Array<{ id: number; text: string }>,
  errorMessage: string,
  attempts: number,
): BatchOutcome {
  return {
    texts: segments.map((s) => normalizeSpaces(s.text)),
    failureReasons: segments.map(() => errorMessage),
    attempts: segments.map(() => attempts),
  }
}

/**
 * バッチ単位で API を叩く。失敗時はバッチを半分に分割して再試行（既存挙動）。
 * 単一セグメントまで分割しても失敗した場合は throw せず、原文 + failureReason を返す。
 */
async function correctBatchWithFallback(
  segments: Array<{ id: number; text: string }>,
  glossaryTerms: string[],
  model: string,
  settings: AdminSettings,
): Promise<BatchOutcome> {
  if (segments.length === 0) return { texts: [], failureReasons: [], attempts: [] }

  const result = await callCorrectionApi(segments, glossaryTerms, model, settings)
  if (!result.errorMessage) {
    return {
      texts: result.texts,
      failureReasons: segments.map(() => undefined),
      attempts: segments.map(() => 1),
    }
  }

  // content_filter / refusal はリトライ・分割しても無駄なので、即諦めて原文を返す
  if (result.abortable) {
    return makeFailureOutcome(segments, result.errorMessage, 1)
  }

  // 単一セグメントまで分割済み → 最大 PER_LEAF_RETRY_MAX_ATTEMPTS 回までリトライ、それでも駄目なら諦める
  if (segments.length === 1) {
    let lastError = result.errorMessage
    for (let attempt = 2; attempt <= PER_LEAF_RETRY_MAX_ATTEMPTS; attempt++) {
      const retry = await callCorrectionApi(segments, glossaryTerms, model, settings)
      if (!retry.errorMessage) {
        return {
          texts: retry.texts,
          failureReasons: [undefined],
          attempts: [attempt],
        }
      }
      if (retry.abortable) {
        return makeFailureOutcome(segments, retry.errorMessage, attempt)
      }
      lastError = retry.errorMessage
    }
    return makeFailureOutcome(segments, lastError, PER_LEAF_RETRY_MAX_ATTEMPTS)
  }

  // 複数セグメント → 半分に分割して再帰
  const splitAt = Math.ceil(segments.length / 2)
  const [left, right] = await Promise.all([
    correctBatchWithFallback(segments.slice(0, splitAt), glossaryTerms, model, settings),
    correctBatchWithFallback(segments.slice(splitAt), glossaryTerms, model, settings),
  ])
  return {
    texts: [...left.texts, ...right.texts],
    failureReasons: [...left.failureReasons, ...right.failureReasons],
    attempts: [...left.attempts, ...right.attempts],
  }
}

async function correctWithLlm(
  segments: TranscriptSegment[],
  model: string,
  settings: AdminSettings,
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
    (index) => correctBatchWithFallback(batches[index], glossaryTerms, model, settings),
  )

  const correctedTexts: string[] = []
  const failureReasons: Array<string | undefined> = []
  const attemptCounts: number[] = []
  for (const r of batchResults) {
    correctedTexts.push(...r.texts)
    failureReasons.push(...r.failureReasons)
    attemptCounts.push(...r.attempts)
  }

  return segments.map((seg, idx) => {
    const source = seg.text ?? ''
    const corrected = correctedTexts[idx] ?? normalizeSpaces(source)
    const distance = Math.round((1.0 - levenshteinRatio(source, corrected)) * 10000) / 10000
    const failureReason = failureReasons[idx]
    const out: CorrectedSegmentLite = {
      ...seg,
      correctedText: corrected,
      correctionDistance: distance,
      correctionFlagged: distance > threshold,
      correctionRetryAttempts: attemptCounts[idx] ?? 1,
    }
    if (failureReason) {
      out.correctionFailureReason = failureReason
    }
    return out
  })
}

export async function correctSegments(
  segments: TranscriptSegment[],
  options: CorrectionOptions = {},
  settings?: AdminSettings,
  glossaryTerms: string[] = [],
): Promise<CorrectedSegmentLite[]> {
  if (!settings) throw new Error('AI provider settings are required before running the pipeline')
  // 接続情報は llmCallWithMeta が個別呼び出しで取得・検証する（throw しない）。
  // ここでは「モデルが解決できるか」だけ事前チェック（解決不能なら全件失敗するのが明らかなので throw）。
  const model = requireChatModelForProvider(
    settings,
    settings.correctionModel || settings.translationModel,
    'correction',
  )
  const maxSegmentsPerRequest = resolveAiProvider(settings) === 'local_openai'
    ? LOCAL_MAX_SEGMENTS_PER_REQUEST
    : MAX_SEGMENTS_PER_REQUEST

  const threshold = options.threshold ?? 0.2
  const requestConcurrency = normalizeConcurrency(settings.apiRequestConcurrency, 1)
  return correctWithLlm(
    segments,
    model,
    settings,
    glossaryTerms,
    threshold,
    maxSegmentsPerRequest,
    requestConcurrency,
  )
}
