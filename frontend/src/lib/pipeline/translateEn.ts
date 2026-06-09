import type { AdminSettings } from '@/types/adminSettings'
import { createAiGateway } from '@/lib/aiGateway'
import type { EnBlock, JaBlock, ViolationCode } from './blockTypes'
import { computeMetrics } from './metrics'
import { normalizeSpaces } from './textUtils'
import { DEFAULT_TRANSLATION_FEW_SHOT_JSON, pickTranslateSystemPrompt, resolveTranslateModelId } from './prompts'
import { requireAiConnection, requireChatModelForProvider, resolveAiProvider } from './aiProvider'
import { parseJsonObjectFromLlmContent } from './jsonResponse'
import { mapWithConcurrency, normalizeConcurrency } from '@/lib/concurrency'

const MAX_SEGMENTS_PER_REQUEST = 40
const LOCAL_MAX_SEGMENTS_PER_REQUEST = 4
const MAX_CONTEXT_GROUPS_PER_REQUEST = 8
const JA_CHAR_RE = /[぀-ヿ㐀-䶿一-鿿]/g
const COUNT_MISMATCH_RE = /translation API returned (\d+) segments for (\d+) inputs/

/**
 * 個別リトライの最大試行回数。
 * バッチ翻訳後に未翻訳判定された block を 1 つずつ再翻訳する。
 * 2 回までに留めるのは、それ以上は同じ原因（content_filter/refusal/source が本質的にJA-heavy）で
 * 改善見込みが薄く、コストだけ増えるため。
 */
const PER_BLOCK_RETRY_MAX_ATTEMPTS = 2

interface TranslationInput {
  text: string
  start: number
  end: number
  contextGroupId?: string
  contextGroupText?: string
  contextGroupRole?: string
  contextGroupIndex?: number
  contextGroupSize?: number
  contextGroupReason?: string
}

interface ContextGroupTranslationDraft {
  id: string
  text: string
  itemIndices: number[]
  items: Array<{
    index: number
    text: string
    role?: string
    durationSec: number
  }>
}

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
  settings: AdminSettings
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
    settings,
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

function buildContextGroupsForPrompt(inputs: TranslationInput[]): Array<Record<string, unknown>> {
  const byId = new Map<string, { text: string; itemIndices: number[]; roles: string[]; size: number }>()
  inputs.forEach((input, index) => {
    if (!input.contextGroupId || !input.contextGroupText) return
    const current = byId.get(input.contextGroupId) ?? { text: input.contextGroupText, itemIndices: [], roles: [], size: input.contextGroupSize ?? 1 }
    current.itemIndices.push(index)
    if (input.contextGroupRole) current.roles.push(input.contextGroupRole)
    byId.set(input.contextGroupId, current)
  })
  return [...byId.entries()]
    .filter(([, group]) => group.itemIndices.length > 1 || group.size > 1)
    .map(([id, group]) => ({
      id,
      text: group.text,
      item_indices: group.itemIndices,
      roles: group.roles,
    }))
}

function buildContextGroupTranslationDrafts(inputs: TranslationInput[]): ContextGroupTranslationDraft[] {
  const byId = new Map<string, ContextGroupTranslationDraft>()
  inputs.forEach((input, index) => {
    if (!input.contextGroupId || !input.contextGroupText) return
    if ((input.contextGroupSize ?? 1) <= 1) return
    if (input.contextGroupReason !== 'incomplete_end_context_group') return

    const current = byId.get(input.contextGroupId) ?? {
      id: input.contextGroupId,
      text: input.contextGroupText,
      itemIndices: [],
      items: [],
    }
    current.itemIndices.push(index)
    current.items.push({
      index,
      text: input.text,
      role: input.contextGroupRole,
      durationSec: Math.round(Math.max(0.001, input.end - input.start) * 1000) / 1000,
    })
    byId.set(input.contextGroupId, current)
  })

  return [...byId.values()]
    .filter(group => group.itemIndices.length > 1)
    .map(group => ({
      ...group,
      itemIndices: [...group.itemIndices].sort((a, b) => a - b),
      items: [...group.items].sort((a, b) => a.index - b.index),
    }))
    .sort((a, b) => a.itemIndices[0] - b.itemIndices[0])
}

function buildContextGroupTranslationPayload(groups: ContextGroupTranslationDraft[]): Record<string, unknown> {
  return {
    context_groups: groups.map(group => ({
      id: group.id,
      text: group.text,
      items: group.items.map(item => ({
        index: item.index,
        text: item.text,
        role: item.role,
        duration_sec: item.durationSec,
      })),
    })),
  }
}

function buildTranslationUserPayload(inputs: TranslationInput[]): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    segments: inputs.map(input => input.text),
  }
  const contextGroups = buildContextGroupsForPrompt(inputs)
  if (contextGroups.length > 0) {
    payload.context_groups = contextGroups
  }
  return payload
}

function withContextInstruction(systemPrompt: string): string {
  return systemPrompt +
    '\n\nIf context_groups are provided, use them only as surrounding meaning for translation consistency. ' +
    'Return exactly one translation for each item in segments, in the same order. ' +
    'Do not merge multiple segments into one output, and do not add context that is outside the current segment.'
}

function withContextGroupAllocationInstruction(systemPrompt: string): string {
  return systemPrompt +
    '\n\nYou will receive incomplete Japanese context_groups. Translate each whole group first, then allocate that meaning across its items. ' +
    'Return exactly one English subtitle per item, preserving item order and item count for every group. ' +
    'Do not repeat the full group meaning in multiple items. Each item must carry only its share of the group meaning. ' +
    'Continuation items may be grammatical continuations, but they must be readable subtitle lines. ' +
    'Prefer concise wording that fits each item duration; avoid copying the same subject, definition, or referent into every item. ' +
    'Respond only with JSON: {"groups":[{"id":"<group id>","translations":["item0 translation","item1 translation"]}]}'
}

async function callOpenAICompatible(
  inputs: TranslationInput[],
  config: ReturnType<typeof resolveApiConfig>,
  glossaryTerms: string[],
): Promise<string[]> {
  const glossaryInstruction = glossaryTerms.length > 0
    ? `\n\nPROJECT GLOSSARY:\nUse these term mappings when the source text contains the Japanese term or related notation. Preserve official English terms exactly.\n${glossaryTerms.map(term => `- ${term}`).join('\n')}`
    : ''
  const result = await createAiGateway(config.settings).chatText({
    nodeName: 'translateEn[batch]',
    model: config.model,
    temperature: 0.0,
    responseFormat: 'omit',
    messages: [
      { role: 'system', content: withContextInstruction(config.systemPrompt) + glossaryInstruction },
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
        content: JSON.stringify(buildTranslationUserPayload(inputs)),
      },
    ],
  })

  if (result.finishReason === 'length') {
    throw new TranslationRetryableError(`translation API stopped because output length was reached. content=${result.content.slice(0, 500)}`)
  }
  if (result.errorMessage || !result.content.trim()) {
    throw new TranslationRetryableError(`translation API response did not include message content. error=${result.errorMessage ?? 'empty_response'}`)
  }

  let parsed: Record<string, unknown>
  try {
    parsed = parseJsonObjectFromLlmContent(result.content, 'translation')
  } catch (error) {
    throw new TranslationRetryableError(
      `${error instanceof Error ? error.message : String(error)}. content=${result.content.slice(0, 500)}`,
    )
  }

  const translations = parsed.translations
  if (!Array.isArray(translations) || !translations.every((item) => typeof item === 'string')) {
    throw new TranslationRetryableError(
      `translation response was not valid JSON with a translations array. content=${result.content.slice(0, 500)}`,
    )
  }
  if (translations.length !== inputs.length) {
    throw new TranslationRetryableError(`translation API returned ${translations.length} segments for ${inputs.length} inputs`)
  }

  return translations.map((item) => normalizeSpaces(String(item)))
}

async function callContextGroupAllocation(
  groups: ContextGroupTranslationDraft[],
  config: ReturnType<typeof resolveApiConfig>,
  glossaryTerms: string[],
): Promise<Map<number, string>> {
  if (groups.length === 0) return new Map()
  const glossaryInstruction = glossaryTerms.length > 0
    ? `\n\nPROJECT GLOSSARY:\nUse these term mappings when the source text contains the Japanese term or related notation. Preserve official English terms exactly.\n${glossaryTerms.map(term => `- ${term}`).join('\n')}`
    : ''
  const result = await createAiGateway(config.settings).chatText({
    nodeName: 'translateEn[contextGroupAllocation]',
    model: config.model,
    temperature: 0.0,
    responseFormat: 'omit',
    messages: [
      { role: 'system', content: withContextGroupAllocationInstruction(config.systemPrompt) + glossaryInstruction },
      {
        role: 'user',
        content: JSON.stringify({
          context_groups: [
            {
              id: 'example-1',
              text: 'それを防ぐために、 ペナルティがかかるような目的関数を設計してやるというのがL2正則化になります。',
              items: [
                { index: 0, role: 'lead', duration_sec: 3.6, text: 'それを防ぐために、' },
                { index: 1, role: 'middle', duration_sec: 3.9, text: 'ペナルティがかかるような目的関数を設' },
                { index: 2, role: 'tail', duration_sec: 3.2, text: '計してやるというのがL2正則化になります。' },
              ],
            },
          ],
        }),
      },
      {
        role: 'assistant',
        content: JSON.stringify({
          groups: [
            {
              id: 'example-1',
              translations: [
                'To prevent that,',
                'we design an objective function with a penalty.',
                'That is L2 regularization.',
              ],
            },
          ],
        }),
      },
      {
        role: 'user',
        content: JSON.stringify(buildContextGroupTranslationPayload(groups)),
      },
    ],
  })

  if (result.finishReason === 'length') {
    throw new TranslationRetryableError(`context group translation stopped because output length was reached. content=${result.content.slice(0, 500)}`)
  }
  if (result.errorMessage || !result.content.trim()) {
    throw new TranslationRetryableError(`context group translation response did not include message content. error=${result.errorMessage ?? 'empty_response'}`)
  }

  let parsed: Record<string, unknown>
  try {
    parsed = parseJsonObjectFromLlmContent(result.content, 'context group translation')
  } catch (error) {
    throw new TranslationRetryableError(
      `${error instanceof Error ? error.message : String(error)}. content=${result.content.slice(0, 500)}`,
    )
  }

  if (!Array.isArray(parsed.groups)) {
    throw new TranslationRetryableError(`context group translation response did not include groups array. content=${result.content.slice(0, 500)}`)
  }

  const expected = new Map(groups.map(group => [group.id, group]))
  const translated = new Map<number, string>()
  for (const item of parsed.groups) {
    if (!item || typeof item !== 'object') continue
    const row = item as Record<string, unknown>
    const id = typeof row.id === 'string' ? row.id : ''
    const group = expected.get(id)
    if (!group || !Array.isArray(row.translations) || row.translations.length !== group.itemIndices.length) {
      throw new TranslationRetryableError(`context group translation count mismatch for ${id || '<missing id>'}`)
    }
    row.translations.forEach((translation, offset) => {
      if (typeof translation !== 'string') {
        throw new TranslationRetryableError(`context group translation item was not a string for ${id}`)
      }
      translated.set(group.itemIndices[offset], normalizeSpaces(translation))
    })
  }

  for (const group of groups) {
    if (!group.itemIndices.every(index => translated.has(index))) {
      throw new TranslationRetryableError(`context group translation missing group ${group.id}`)
    }
  }

  return translated
}

async function translateContextGroups(
  inputs: TranslationInput[],
  config: ReturnType<typeof resolveApiConfig>,
  glossaryTerms: string[],
): Promise<Map<number, string>> {
  const groups = buildContextGroupTranslationDrafts(inputs)
  if (groups.length === 0) return new Map()

  const batches: ContextGroupTranslationDraft[][] = []
  for (let start = 0; start < groups.length; start += MAX_CONTEXT_GROUPS_PER_REQUEST) {
    batches.push(groups.slice(start, start + MAX_CONTEXT_GROUPS_PER_REQUEST))
  }

  const results = await mapWithConcurrency(
    batches.length,
    config.requestConcurrency,
    async (index) => {
      try {
        return await callContextGroupAllocation(batches[index], config, glossaryTerms)
      } catch {
        return new Map<number, string>()
      }
    },
  )

  const merged = new Map<number, string>()
  for (const result of results) {
    for (const [index, text] of result.entries()) {
      merged.set(index, text)
    }
  }
  return merged
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
  input: TranslationInput,
  config: ReturnType<typeof resolveApiConfig>,
  glossaryTerms: string[],
): Promise<SingleCallResult> {
  const glossaryInstruction = glossaryTerms.length > 0
    ? `\n\nPROJECT GLOSSARY:\nUse these term mappings when the source text contains the Japanese term or related notation. Preserve official English terms exactly.\n${glossaryTerms.map(term => `- ${term}`).join('\n')}`
    : ''
  const result = await createAiGateway(config.settings).chatText({
    nodeName: 'translateEn[single]',
    model: config.model,
    temperature: 0.0,
    responseFormat: 'omit',
    messages: [
      { role: 'system', content: withContextInstruction(config.systemPrompt) + glossaryInstruction },
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
        content: JSON.stringify(buildTranslationUserPayload([input])),
      },
    ],
  })

  // 即諦め分岐: content_filter / refusal / length
  if (result.finishReason === 'content_filter') {
    return { translation: '', finishReason: result.finishReason, refusal: result.refusal, errorMessage: 'content_filter' }
  }
  if (result.refusal) {
    return { translation: '', finishReason: result.finishReason, refusal: result.refusal, errorMessage: `model_refusal: ${result.refusal.slice(0, 200)}` }
  }
  if (result.finishReason === 'length') {
    return { translation: '', finishReason: result.finishReason, errorMessage: `truncated_at_length_limit (content_preview=${result.content.slice(0, 100)})` }
  }
  if (result.errorMessage || !result.content.trim()) {
    return { translation: '', finishReason: result.finishReason, errorMessage: result.errorMessage ?? 'empty_response' }
  }

  // JSON 解析
  let parsed: Record<string, unknown>
  try {
    parsed = parseJsonObjectFromLlmContent(result.content, 'translation single')
  } catch (err) {
    return {
      translation: '',
      finishReason: result.finishReason,
      errorMessage: `json_parse_failed: ${err instanceof Error ? err.message : String(err)} (content=${result.content.slice(0, 200)})`,
    }
  }

  const translations = parsed.translations
  if (!Array.isArray(translations) || translations.length === 0 || typeof translations[0] !== 'string') {
    return {
      translation: '',
      finishReason: result.finishReason,
      errorMessage: `invalid_response_format: expected translations[0]: string. content=${result.content.slice(0, 200)}`,
    }
  }
  return { translation: normalizeSpaces(String(translations[0])), finishReason: result.finishReason, refusal: result.refusal }
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
  input: TranslationInput,
  config: ReturnType<typeof resolveApiConfig>,
  glossaryTerms: string[],
  maxAttempts = PER_BLOCK_RETRY_MAX_ATTEMPTS,
): Promise<RetranslationResult> {
  let lastReason = 'unknown_failure'
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await callTranslationOnce(input, config, glossaryTerms)

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
    if (!looksUntranslated(input.text, result.translation)) {
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
  inputs: TranslationInput[],
  config: ReturnType<typeof resolveApiConfig>,
  glossaryTerms: string[],
): Promise<string[]> {
  if (inputs.length === 0) return []
  try {
    return await callOpenAICompatible(inputs, config, glossaryTerms)
  } catch (error) {
    if (!isRetryableTranslationError(error)) throw error
    if (inputs.length === 1) throw formatTranslationFailure(inputs[0].text, error)
  }

  const splitAt = Math.ceil(inputs.length / 2)
  const left = await translateBatchWithFallback(inputs.slice(0, splitAt), config, glossaryTerms)
  const right = await translateBatchWithFallback(inputs.slice(splitAt), config, glossaryTerms)
  return [...left, ...right]
}

async function translateInBatches(
  inputs: TranslationInput[],
  config: ReturnType<typeof resolveApiConfig>,
  glossaryTerms: string[],
): Promise<string[]> {
  const batches: TranslationInput[][] = []
  for (let start = 0; start < inputs.length; start += config.maxSegmentsPerRequest) {
    batches.push(inputs.slice(start, start + config.maxSegmentsPerRequest))
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
  const inputs: TranslationInput[] = blocks.map((block) => ({
    text: block.jaText,
    start: block.start,
    end: block.end,
    contextGroupId: block.contextGroupId,
    contextGroupText: block.contextGroupText,
    contextGroupRole: block.contextGroupRole,
    contextGroupIndex: block.contextGroupIndex,
    contextGroupSize: block.contextGroupSize,
    contextGroupReason: block.contextGroupReason,
  }))
  const translatedTexts = new Array<string>(inputs.length)
  const groupTranslations = await translateContextGroups(inputs, config, glossaryTerms)
  for (const [index, text] of groupTranslations.entries()) {
    translatedTexts[index] = text
  }

  const fallbackIndices = inputs
    .map((_, index) => index)
    .filter(index => translatedTexts[index] === undefined)
  if (fallbackIndices.length > 0) {
    const fallbackTexts = await translateInBatches(fallbackIndices.map(index => inputs[index]), config, glossaryTerms)
    fallbackIndices.forEach((blockIndex, fallbackIndex) => {
      translatedTexts[blockIndex] = fallbackTexts[fallbackIndex] ?? ''
    })
  }

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
        const result = await retranslateBlockIndividually(inputs[blockIdx], config, glossaryTerms)
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

export const __testing = {
  looksUntranslated,
  computeJaRatio,
  buildTranslationUserPayload,
  buildContextGroupTranslationDrafts,
  buildContextGroupTranslationPayload,
}
