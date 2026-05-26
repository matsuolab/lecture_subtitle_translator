import type { AdminSettings } from '@/types/adminSettings'
import type { EnBlock, JaBlock, ViolationCode } from './blockTypes'
import { computeMetrics } from './metrics'
import { normalizeSpaces } from './textUtils'
import { DEFAULT_TRANSLATION_FEW_SHOT_JSON, pickTranslateSystemPrompt, resolveTranslateModelId } from './prompts'
import { requireAiConnection, requireChatModelForProvider, resolveAiProvider } from './aiProvider'
import { tauriFetch } from '@/lib/tauriFetch'
import { parseJsonObjectFromLlmContent } from './jsonResponse'
import { mapWithConcurrency, normalizeConcurrency } from '@/lib/concurrency'

const MAX_SEGMENTS_PER_REQUEST = 40
const LOCAL_MAX_SEGMENTS_PER_REQUEST = 4
const JA_CHAR_RE = /[぀-ヿ㐀-䶿一-鿿]/g
const COUNT_MISMATCH_RE = /translation API returned (\d+) segments for (\d+) inputs/

/**
 * 個別リトライの最大試行回数。
 * バッチ翻訳後に未翻訳判定された block を 1 つずつ再翻訳する。
 * 2 回までに留めるのは、それ以上は同じ原因（content_filter/refusal/source が本質的にJA-heavy）で
 * 改善見込みが薄く、コストだけ増えるため。
 */
const PER_BLOCK_RETRY_MAX_ATTEMPTS = 2

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

function computeJaRatio(text: string): number {
  const trl = normalizeSpaces(text)
  const nonSpace = [...trl].filter((c) => c.trim())
  if (nonSpace.length === 0) return 0
  const jaCount = (trl.match(JA_CHAR_RE) ?? []).length
  return Math.round((jaCount / nonSpace.length) * 100) / 100
}

function resolveApiConfig(settings: AdminSettings): {
  apiKey: string
  baseUrl: string
  providerLabel: string
  model: string
  systemPrompt: string
  fewShotSegments: string[]
  fewShotTranslations: string[]
  maxSegmentsPerRequest: number
  requestConcurrency: number
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
    systemPrompt: pickTranslateSystemPrompt(model, settings.translationAdditionalInstructions),
    ...resolveTranslationFewShot(settings.translationFewShotJson),
    maxSegmentsPerRequest,
    requestConcurrency: normalizeConcurrency(settings.apiRequestConcurrency, 1),
  }
}

function resolveTranslationFewShot(rawJson: string): { fewShotSegments: string[]; fewShotTranslations: string[] } {
  const fallback = {
    fewShotSegments: ['機械学習とは何ですか。', 'ディープラーニングについて説明します。'],
    fewShotTranslations: ['What is machine learning?', 'I will explain deep learning.'],
  }
  const raw = rawJson.trim() || DEFAULT_TRANSLATION_FEW_SHOT_JSON
  try {
    const parsed = JSON.parse(raw) as { segments?: unknown; translations?: unknown }
    if (
      Array.isArray(parsed.segments)
      && Array.isArray(parsed.translations)
      && parsed.segments.length === parsed.translations.length
      && parsed.segments.length > 0
      && parsed.segments.every((item) => typeof item === 'string')
      && parsed.translations.every((item) => typeof item === 'string')
    ) {
      return {
        fewShotSegments: parsed.segments as string[],
        fewShotTranslations: parsed.translations as string[],
      }
    }
  } catch {
    // Fall back to the stable built-in example.
  }
  return fallback
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
            segments: config.fewShotSegments,
          }),
        },
        {
          role: 'assistant',
          content: JSON.stringify({
            translations: config.fewShotTranslations,
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

/**
 * 1 block を 1 リクエストで翻訳し、API レスポンスのメタ情報を呼出元に返す。
 * 個別リトライ時に使う。throw せず、失敗理由を文字列で返却するのが特徴
 * （バッチ用 callOpenAICompatible とは異なり、呼出元が原因に応じた分岐判断を出来るようにする）。
 *
 * 仕様参照: https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create
 * - finish_reason: 'stop' | 'length' | 'content_filter' | 'tool_calls' | 'function_call'
 * - message.refusal: string | null （Structured Outputs で拒否時にメッセージが入る）
 */
interface SingleCallResult {
  translation: string
  finishReason?: string
  refusal?: string | null
  errorMessage?: string
}

async function callTranslationOnce(
  text: string,
  config: ReturnType<typeof resolveApiConfig>,
  glossaryTerms: string[],
): Promise<SingleCallResult> {
  const glossaryInstruction = glossaryTerms.length > 0
    ? `\n\nPROJECT GLOSSARY:\nUse these term mappings when the source text contains the Japanese term or related notation. Preserve official English terms exactly.\n${glossaryTerms.slice(0, 120).map(term => `- ${term}`).join('\n')}`
    : ''
  let response: Awaited<ReturnType<typeof tauriFetch>>
  try {
    response = await tauriFetch(`${config.baseUrl}/chat/completions`, {
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
              segments: config.fewShotSegments,
            }),
          },
          {
            role: 'assistant',
            content: JSON.stringify({
              translations: config.fewShotTranslations,
            }),
          },
          {
            role: 'user',
            content: JSON.stringify({ segments: [text] }),
          },
        ],
      }),
    })
  } catch (err) {
    return { translation: '', errorMessage: `fetch_failed: ${err instanceof Error ? err.message : String(err)}` }
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    return { translation: '', errorMessage: `http_${response.status}: ${detail.slice(0, 200)}` }
  }

  let payload: Record<string, unknown>
  try {
    payload = (await response.json()) as Record<string, unknown>
  } catch (err) {
    return { translation: '', errorMessage: `json_response_parse_failed: ${err instanceof Error ? err.message : String(err)}` }
  }

  const choices = Array.isArray(payload.choices) ? payload.choices : []
  const firstChoice = choices[0] as Record<string, unknown> | undefined
  const finishReason = typeof firstChoice?.finish_reason === 'string' ? firstChoice.finish_reason : undefined
  const message = firstChoice?.message as Record<string, unknown> | undefined
  const refusal = typeof message?.refusal === 'string' ? message.refusal : null
  const content: string = typeof message?.content === 'string' ? message.content : ''

  // 即諦め分岐: content_filter / refusal / length
  if (finishReason === 'content_filter') {
    return { translation: '', finishReason, refusal, errorMessage: 'content_filter' }
  }
  if (refusal) {
    return { translation: '', finishReason, refusal, errorMessage: `model_refusal: ${refusal.slice(0, 200)}` }
  }
  if (finishReason === 'length') {
    return { translation: '', finishReason, errorMessage: `truncated_at_length_limit (content_preview=${content.slice(0, 100)})` }
  }
  if (!content.trim()) {
    return { translation: '', finishReason, errorMessage: `empty_response (payload_keys=${Object.keys(payload).join(',')})` }
  }

  // JSON 解析
  let parsed: Record<string, unknown>
  try {
    parsed = parseJsonObjectFromLlmContent(content, 'translation single')
  } catch (err) {
    return {
      translation: '',
      finishReason,
      errorMessage: `json_parse_failed: ${err instanceof Error ? err.message : String(err)} (content=${content.slice(0, 200)})`,
    }
  }

  const translations = parsed.translations
  if (!Array.isArray(translations) || translations.length === 0 || typeof translations[0] !== 'string') {
    return {
      translation: '',
      finishReason,
      errorMessage: `invalid_response_format: expected translations[0]: string. content=${content.slice(0, 200)}`,
    }
  }
  return { translation: normalizeSpaces(String(translations[0])), finishReason, refusal }
}

/**
 * 1 block を最大 N 回個別リトライする。
 * 原因に応じて分岐:
 *   - content_filter / refusal → 即諦め（再試行しても結果は変わらない）
 *   - length / empty / parse_error / API エラー → リトライ（transient の可能性）
 *   - still_japanese → リトライ（バッチ混乱の可能性）
 *   - 全リトライ後も解決しない場合は理由つきで失敗を返す
 */
interface RetranslationResult {
  translation: string
  attempts: number
  succeeded: boolean
  reason?: string
}

async function retranslateBlockIndividually(
  sourceText: string,
  config: ReturnType<typeof resolveApiConfig>,
  glossaryTerms: string[],
  maxAttempts = PER_BLOCK_RETRY_MAX_ATTEMPTS,
): Promise<RetranslationResult> {
  let lastReason = 'unknown_failure'
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await callTranslationOnce(sourceText, config, glossaryTerms)

    // 即諦めパターン: 同じ入力をもう一度送っても結果が変わらない
    if (result.finishReason === 'content_filter') {
      return {
        translation: '',
        attempts: attempt,
        succeeded: false,
        reason: `content_filter_at_attempt_${attempt} (retry_futile)`,
      }
    }
    if (result.refusal) {
      return {
        translation: '',
        attempts: attempt,
        succeeded: false,
        reason: `model_refusal_at_attempt_${attempt}: ${result.refusal.slice(0, 200)}`,
      }
    }

    // 一般エラー: リトライ可能
    if (result.errorMessage) {
      lastReason = `attempt_${attempt}_${result.errorMessage}`
      continue
    }

    // 翻訳成功
    if (!looksUntranslated(sourceText, result.translation)) {
      return {
        translation: result.translation,
        attempts: attempt,
        succeeded: true,
      }
    }

    // まだ未翻訳: ratio を含めて理由を残してリトライ
    const jaRatio = computeJaRatio(result.translation)
    lastReason = `attempt_${attempt}_still_japanese (jaRatio=${jaRatio}, content_preview=${result.translation.slice(0, 80)})`
  }

  return {
    translation: '',
    attempts: maxAttempts,
    succeeded: false,
    reason: `${lastReason} after_${maxAttempts}_retries`,
  }
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
  const batches: string[][] = []
  for (let start = 0; start < texts.length; start += config.maxSegmentsPerRequest) {
    batches.push(texts.slice(start, start + config.maxSegmentsPerRequest))
  }
  const results = await mapWithConcurrency(
    batches.length,
    config.requestConcurrency,
    (index) => translateBatchWithFallback(batches[index], config, glossaryTerms),
  )
  return results.flat()
}

export async function translateEn(blocks: JaBlock[], settings: AdminSettings, glossaryTerms: string[] = []): Promise<EnBlock[]> {
  if (blocks.length === 0) return []

  const config = resolveApiConfig(settings)
  const sourceTexts = blocks.map((block) => block.jaText)
  const translatedTexts = await translateInBatches(sourceTexts, config, glossaryTerms)

  // 未翻訳判定された block を集めて個別リトライ
  const untranslatedIndices: number[] = []
  for (let i = 0; i < blocks.length; i += 1) {
    const enRaw = translatedTexts[i] ?? ''
    if (looksUntranslated(blocks[i].jaText, enRaw)) {
      untranslatedIndices.push(i)
    }
  }

  // 個別リトライ（並列度は requestConcurrency に従う）
  const retranslationResults = new Map<number, RetranslationResult>()
  if (untranslatedIndices.length > 0) {
    const results = await mapWithConcurrency(
      untranslatedIndices.length,
      config.requestConcurrency,
      async (idx: number) => {
        const blockIdx = untranslatedIndices[idx]
        const sourceText = blocks[blockIdx].jaText
        const result = await retranslateBlockIndividually(sourceText, config, glossaryTerms)
        return { blockIdx, result }
      },
    )
    for (const { blockIdx, result } of results) {
      retranslationResults.set(blockIdx, result)
    }
  }

  // 最終的な EnBlock 構築（失敗時は throw せず violation='untranslated' で次段へ）
  return blocks.map((block, index) => {
    const initialTranslation = translatedTexts[index] ?? ''
    const retry = retranslationResults.get(index)

    let enText = initialTranslation
    let violation: ViolationCode = 'ok'
    let translationFailureReason: string | undefined
    let translationRetryAttempts: number | undefined

    if (retry) {
      translationRetryAttempts = retry.attempts
      if (retry.succeeded) {
        enText = retry.translation
        // violation は 'ok' のまま
      } else {
        // 失敗 reason と原文を enText に直接埋め込む
        // → SubtitleBlockList でそのまま視認できる（別UI追加不要）
        // → 人間レビュー時に「これは要訳」と判別でき、原文も並んでいる
        // → general_repair_agent が拾った時もマーカーから状況を理解できる
        const shortReason = (retry.reason ?? 'unknown_failure').slice(0, 120)
        enText = `[UNTRANSLATED: ${shortReason}]\n${block.jaText}`
        violation = 'untranslated'
        translationFailureReason = retry.reason
      }
    }

    const metrics = computeMetrics({ ...block, enRaw: enText })
    const result: EnBlock = {
      ...block,
      enText,
      enRaw: enText,
      enChars: metrics.enChars,
      cps: metrics.cps,
      maxLineLen: metrics.maxLineLen,
      violation,
      expandCount: 0,
      compressCount: 0,
    }
    if (translationFailureReason !== undefined) result.translationFailureReason = translationFailureReason
    if (translationRetryAttempts !== undefined) result.translationRetryAttempts = translationRetryAttempts
    return result
  })
}

// summarizeTranslationPayload は将来のデバッグ用途で残す（現状は callOpenAICompatible 内で使用）
export const __testing = { summarizeTranslationPayload, looksUntranslated, computeJaRatio }
