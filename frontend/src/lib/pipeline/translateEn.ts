import type { AdminSettings } from '@/types/adminSettings'
import { buildLlmFailureCode, createAiGateway, type ChatTextResult, type JsonSchemaSpec } from '@/lib/aiGateway'
import type { EnBlock, JaBlock, ViolationCode } from './blockTypes'
import { computeMetrics } from './metrics'
import { normalizeSpaces } from './textUtils'
import { DEFAULT_TRANSLATION_FEW_SHOT_JSON, pickTranslateSystemPrompt, resolveTranslateModelId } from './prompts'
import { loadLanguageProfileConfig, resolveTargetCharMatcher, type LanguageProfileConfig, type LanguageRoleProfile } from './languageProfileConfig'
import { requireAiConnection, requireChatModelForProvider, resolveAiProvider } from './aiProvider'
import { parseJsonObjectFromLlmContent } from './jsonResponse'
import { mapWithConcurrency, normalizeConcurrency } from '@/lib/concurrency'
import { resolveModelProfile, withReasoningHeadroom } from './modelProfile'
import { isPipelineAbortedError, throwIfPipelineAborted } from './pipelineAbort'

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

/**
 * バッチ翻訳（callOpenAICompatible）・個別翻訳（callTranslationOnce）で使う Structured Outputs スキーマ。
 * LM Studio は response_format:{"type":"json_object"} を HTTP 400 で拒否するため、
 * "type":"json_schema"（Structured Outputs）をスキーマ付きで送る必要がある。
 * OpenAI / Gemini プロファイルでは resolveChatResponseFormatForDialect が自動的に
 * json_object へ読み替えるため、呼出元はこのスキーマを渡すだけでよい。
 */
const TRANSLATION_JSON_SCHEMA = {
  name: 'translation',
  schema: {
    type: 'object',
    properties: {
      translations: { type: 'array', items: { type: 'string' } },
    },
    required: ['translations'],
    additionalProperties: false,
  },
} satisfies JsonSchemaSpec

/** callContextGroupAllocation で使う Structured Outputs スキーマ。用途は TRANSLATION_JSON_SCHEMA と同じ。 */
const CONTEXT_GROUP_TRANSLATION_JSON_SCHEMA = {
  name: 'context_group_translation',
  schema: {
    type: 'object',
    properties: {
      groups: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            translations: { type: 'array', items: { type: 'string' } },
          },
          required: ['id', 'translations'],
          additionalProperties: false,
        },
      },
    },
    required: ['groups'],
    additionalProperties: false,
  },
} satisfies JsonSchemaSpec

/**
 * 1 segment あたりの想定出力トークン数。字幕1行は概ね40文字前後（DEFAULT_PIPELINE_THRESHOLDS.maxLineLen
 * 相当）で、英訳はそれよりやや長くなりうるため安全側に見積もった下限値。
 * 文字数ベースの見積り（CHARS_TO_TOKENS_ESTIMATE_RATIO）が小さくなりすぎる短文セグメントの下支えに使う。
 */
const ESTIMATED_TOKENS_PER_SEGMENT = 60

/** JSON構造のオーバーヘッド分（キー名・括弧・カンマなど）の余裕。 */
const OUTPUT_TOKEN_ESTIMATE_OVERHEAD = 64

/**
 * 原文の文字数から「本文として欲しい出力トークン数」を見積もる係数。
 * 日本語1文字が英語換算で1〜2トークン程度になりうる実測を踏まえ、余裕を持って1.5を採用する。
 */
const CHARS_TO_TOKENS_ESTIMATE_RATIO = 1.5

/**
 * 「本文として欲しい出力トークン数」を、原文の文字数とセグメント数から見積もる。
 * ここで得た値を withReasoningHeadroom に渡し、thinking系モデルの reasoning 消費分を
 * 加味した実際の max_tokens を求める（thinking系は completion_tokens の大半を reasoning が
 * 消費するため、本文分だけを見積もっても reasoning に食い潰されてしまう実測事故があった）。
 */
function estimateDesiredOutputTokens(charCount: number, segmentCount: number): number {
  const charBasedEstimate = Math.ceil(charCount * CHARS_TO_TOKENS_ESTIMATE_RATIO)
  const segmentBasedEstimate = segmentCount * ESTIMATED_TOKENS_PER_SEGMENT
  return Math.max(charBasedEstimate, segmentBasedEstimate) + OUTPUT_TOKEN_ESTIMATE_OVERHEAD
}

function sumTextLength(inputs: TranslationInput[]): number {
  return inputs.reduce((sum, input) => sum + input.text.length, 0)
}

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

/**
 * 設定起因（認証エラー・モデルID誤りなど）の致命的エラー。
 * TranslationRetryableError と異なりリトライしても回復しないため、
 * translateBatchWithFallback / translateInBatches の catch-all では握り潰さず、
 * 呼出元（translateEn の外）まで即座に伝播させる（fail fast）。
 * 改修前は 1 ブロックの一時的失敗も設定起因の致命エラーも区別せず同じ catch-all で
 * 空文字へ降格させていたため、モデルID誤りのような即座に検知すべき失敗が
 * 個別リトライの上限まで空振りしてから未翻訳終了するまで気づけず、数十分を浪費する
 * 事故につながっていた。
 */
class TranslationFatalError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TranslationFatalError'
  }
}

/**
 * リトライしても回復する見込みが無い HTTP ステータス。
 * - 401 Unauthorized / 403 Forbidden: APIキー等の認証情報の設定誤り
 * - 404 Not Found: モデルID誤りやエンドポイント誤り
 * これらは設定を直さない限り何度リクエストしても同じ結果になるため、
 * バッチ単位のリトライ・catch-all に委ねず即座に致命エラーとして扱う。
 * 判定は httpStatus（数値）ベースで行い、errorMessage の文字列比較は行わない
 * （errorMessage は suffix 付与で内容が変わりうる自由文字列であり、文字列比較に
 * 依存した分岐が原因で 42 分無駄にした事故が別ノードで起きているため）。
 */
const FATAL_HTTP_STATUSES: ReadonlySet<number> = new Set([401, 403, 404])

/**
 * 401/403/404 に加えて、errorCode === 'quota_exhausted'（HTTP 429 のうち OpenAI 公式仕様の
 * insufficient_quota。aiGateway/errors.ts の classifyHttpErrorCode 参照）も同格の致命エラーとして
 * 扱う。課金設定（支払い方法・利用枠）を直さない限り絶対に回復しないため、gateway 側は既に
 * バックオフリトライを一切行っていない（chatText.ts 参照）。ここでさらにバッチ半割・個別リトライへ
 * 委ねると、全ブロックが同じ理由で失敗し続けるだけで時間を空費するため、401/403/404 と同様に
 * 即座に TranslationFatalError を投げて translateEn 全体を fail fast させる。
 */
function isFatalTranslationHttpError(result: Pick<ChatTextResult, 'errorCode' | 'httpStatus'>): boolean {
  if (result.errorCode === 'quota_exhausted') return true
  return result.errorCode === 'http_error' && result.httpStatus !== undefined && FATAL_HTTP_STATUSES.has(result.httpStatus)
}

// 出力にターゲット言語の特徴文字がこの比率を下回ると「未翻訳（ソース言語のまま）」とみなす。
const MIN_TARGET_CHAR_RATIO = 0.15
// ラテン字幕（日本語→英語など）に CJK がこの比率以上混入していれば未翻訳と判定する既存セーフティネット。
const LATIN_TARGET_CJK_LEAK_RATIO = 0.35

function charRatio(text: string, matcher: RegExp | null): number {
  if (!matcher) return 0
  const nonSpace = [...text].filter((c) => c.trim())
  if (nonSpace.length === 0) return 0
  return (text.match(matcher) ?? []).length / nonSpace.length
}

/**
 * バッチ翻訳結果がソース言語のまま（未翻訳）かどうかを、ターゲット言語プロファイルに基づき判定する。
 * - 空 / ソースと同一 → 未翻訳
 * - ターゲット言語の特徴文字が乏しい（< MIN_TARGET_CHAR_RATIO） → 未翻訳
 * - ラテン字幕に CJK が混入（>= LATIN_TARGET_CJK_LEAK_RATIO） → 未翻訳（日本語→英語の取りこぼし対策）
 * target.script === 'generic' かつ translatedCharPattern 未指定なら、同一文字列チェックのみで判定する。
 */
function looksUntranslated(source: string, translated: string, target: LanguageRoleProfile): boolean {
  const src = normalizeSpaces(source)
  const trl = normalizeSpaces(translated)
  if (!trl || trl === src) return true
  const nonSpace = [...trl].filter((c) => c.trim())
  if (nonSpace.length === 0) return true

  const targetMatcher = resolveTargetCharMatcher(target)
  if (targetMatcher && charRatio(trl, targetMatcher) < MIN_TARGET_CHAR_RATIO) return true
  if (target.script === 'latin' && charRatio(trl, JA_CHAR_RE) >= LATIN_TARGET_CJK_LEAK_RATIO) return true
  return false
}

/** 診断用: 出力に含まれるターゲット言語特徴文字の比率（0〜1, 小数2桁）。 */
function computeTargetCharRatio(text: string, target: LanguageRoleProfile): number {
  const ratio = charRatio(normalizeSpaces(text), resolveTargetCharMatcher(target))
  return Math.round(ratio * 100) / 100
}

function resolveApiConfig(settings: AdminSettings): {
  settings: AdminSettings
  providerLabel: string
  model: string
  systemPrompt: string
  languages: LanguageProfileConfig
  fewShotSegments: string[]
  fewShotTranslations: string[]
  maxSegmentsPerRequest: number
  requestConcurrency: number
  modelProfile: ReturnType<typeof resolveModelProfile>
  /** withReasoningHeadroom に渡す推論予算の上書き値（AdminSettings.llmReasoningBudgetTokens）。0=自動。 */
  reasoningBudgetOverrideTokens: number
} {
  const connection = requireAiConnection(settings)
  const model = requireChatModelForProvider(settings, resolveTranslateModelId(settings.translationModel), 'translation')
  const languages = loadLanguageProfileConfig(settings)
  const maxSegmentsPerRequest = resolveAiProvider(settings) === 'local_openai'
    ? LOCAL_MAX_SEGMENTS_PER_REQUEST
    : MAX_SEGMENTS_PER_REQUEST
  return {
    settings,
    providerLabel: connection.providerLabel,
    model,
    systemPrompt: pickTranslateSystemPrompt(model, settings.translationAdditionalInstructions, languages),
    languages,
    ...resolveTranslationFewShot(settings.translationFewShotJson, languages),
    maxSegmentsPerRequest,
    requestConcurrency: normalizeConcurrency(settings.apiRequestConcurrency, 1),
    // thinking系モデルの出力上限見積り（withReasoningHeadroom）に使う。呼出のたびに解決すると
    // 無駄なので resolveApiConfig で一度だけ解決し、各 chatText 呼出箇所で使い回す。
    modelProfile: resolveModelProfile(settings, model, 'chatText'),
    reasoningBudgetOverrideTokens: settings.llmReasoningBudgetTokens,
  }
}

function resolveTranslationFewShot(
  rawJson: string,
  languages: LanguageProfileConfig,
): { fewShotSegments: string[]; fewShotTranslations: string[] } {
  // 組み込み few-shot は日本語→英語の例なので、transcript が日本語スクリプト以外の構成では使わない
  // （誤った言語ペアの例示は出力言語を引きずるため、ユーザー指定が無ければ few-shot なしで翻訳する）。
  const transcriptIsJapanese = languages.transcript.script === 'japanese'
  const fallback = transcriptIsJapanese
    ? {
        fewShotSegments: ['機械学習とは何ですか。', 'ディープラーニングについて説明します。'],
        fewShotTranslations: ['What is machine learning?', 'I will explain deep learning.'],
      }
    : { fewShotSegments: [], fewShotTranslations: [] }
  const raw = rawJson.trim() || (transcriptIsJapanese ? DEFAULT_TRANSLATION_FEW_SHOT_JSON : '')
  if (!raw) return fallback
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
    'Do not merge multiple segments into one output, and do not add context that is outside the current segment. ' +
    // OpenAI の response_format:{"type":"json_object"} は、system/user いずれかのメッセージに
    // 語 "JSON" が含まれていないと HTTP 400 で拒否する仕様がある
    // （https://developers.openai.com/api/docs/guides/error-codes）。この関数が組み立てる
    // system prompt は TRANSLATION_JSON_SCHEMA 付きで json_object モードになりうる
    // （callOpenAICompatible / callTranslationOnce の両方から使われる）が、ベースの
    // buildFullTranslateSystemPrompt / buildFtTranslateSystemPrompt には語 "JSON" が含まれない
    // ため、出力仕様自体は変えずにこの一文だけを追加して要件を満たす。
    'Respond only with JSON matching the given schema.'
}

function buildGlossaryInstruction(glossaryTerms: string[], languages: LanguageProfileConfig): string {
  if (glossaryTerms.length === 0) return ''
  return `\n\nPROJECT GLOSSARY:\nUse these term mappings when the source text contains the ${languages.transcript.label} term or related notation. Preserve official ${languages.subtitle.label} terms exactly.\n${glossaryTerms.map(term => `- ${term}`).join('\n')}`
}

function withContextGroupAllocationInstruction(systemPrompt: string, languages: LanguageProfileConfig): string {
  return systemPrompt +
    `\n\nYou will receive incomplete ${languages.transcript.label} context_groups. Translate each whole group first, then allocate that meaning across its items. ` +
    `Return exactly one ${languages.subtitle.label} subtitle per item, preserving item order and item count for every group. ` +
    'Do not repeat the full group meaning in multiple items. Each item must carry only its share of the group meaning. ' +
    'Continuation items may be grammatical continuations, but they must be readable subtitle lines. ' +
    'Prefer concise wording that fits each item duration; avoid copying the same subject, definition, or referent into every item. ' +
    'Respond only with JSON: {"groups":[{"id":"<group id>","translations":["item0 translation","item1 translation"]}]}'
}

function buildTranslationFewShotMessages(
  config: ReturnType<typeof resolveApiConfig>,
): Array<{ role: 'user' | 'assistant'; content: string }> {
  if (config.fewShotSegments.length === 0) return []
  return [
    { role: 'user', content: JSON.stringify({ segments: config.fewShotSegments }) },
    { role: 'assistant', content: JSON.stringify({ translations: config.fewShotTranslations }) },
  ]
}

/**
 * バッチ翻訳の結果。texts と rescued は同じ長さ・同じ並び順で対応する。
 * rescued[i]===true は、texts[i] が F（JSONラッパー無しの素テキスト救済）で採用された
 * ことを示す。blockTypes.ts に新フィールドを追加せずに「救済が働いた」ことを呼出元
 * （translateEn）へ伝えるための内部的な仕組み。
 */
interface BatchTranslationOutcome {
  texts: string[]
  rescued: boolean[]
}

/**
 * F: JSONラッパー無しの素の訳文がそのまま返るケースの救済。
 *
 * 実測事故: LM Studio + gemma-4-e4b-it-qat が `{"translations":[...]}` で包まずに
 * 訳文そのもの（例: "Based on my review of each domain's current state, ..."）を返し、
 * parseJsonObjectFromLlmContent が `{` を見つけられず失敗 → リトライ → 1件まで
 * 縮退した時点で throw → パイプライン全体が死んだ。訳文自体は完璧なことが多いため、
 * 条件を満たす場合はそのまま採用する。
 *
 * 採用条件（すべて満たす場合のみ）:
 * - 入力が1件だけ（複数入力では、どの文がどの入力に対応するか特定できないため救済しない）
 * - content が空でない
 * - content が JSON の壊れかけに見えない（`{` や `"translations"` を含む場合は、
 *   閉じ忘れ・カンマ欠落などの「修復すれば直る」壊れ方の可能性があるため、
 *   誤った素テキスト採用を避けて従来どおりリトライへ委ねる）
 * - 訳文としてターゲット言語の体を成している（looksUntranslated が false）。
 *   ソース言語のまま（未翻訳）の文字列を誤って「救済」しないためのガード
 *
 * @returns 採用する訳文（normalizeSpaces 済み）。条件を満たさない場合は undefined。
 */
function rescuePlainTextTranslation(
  inputs: TranslationInput[],
  content: string,
  target: LanguageRoleProfile,
): string | undefined {
  if (inputs.length !== 1) return undefined
  const trimmed = content.trim()
  if (!trimmed) return undefined
  if (trimmed.includes('{') || trimmed.includes('"translations"')) return undefined
  if (looksUntranslated(inputs[0].text, trimmed, target)) return undefined
  return normalizeSpaces(trimmed)
}

async function callOpenAICompatible(
  inputs: TranslationInput[],
  config: ReturnType<typeof resolveApiConfig>,
  glossaryTerms: string[],
): Promise<BatchTranslationOutcome> {
  const glossaryInstruction = buildGlossaryInstruction(glossaryTerms, config.languages)
  const maxTokens = withReasoningHeadroom(
    estimateDesiredOutputTokens(sumTextLength(inputs), inputs.length),
    config.modelProfile,
    config.reasoningBudgetOverrideTokens,
  )
  const result = await createAiGateway(config.settings).chatText({
    nodeName: 'translateEn[batch]',
    model: config.model,
    temperature: 0.0,
    jsonSchema: TRANSLATION_JSON_SCHEMA,
    maxTokens,
    // 実際のコンテキスト長を反映してクランプする（LM Studio 系プロファイルのみ有効。
    // modelProfile.ts の CONSERVATIVE_CONTEXT_LENGTH_CEILING_TOKENS の JSDoc 参照）。
    resolveRuntimeContextLength: true,
    messages: [
      { role: 'system', content: withContextInstruction(config.systemPrompt) + glossaryInstruction },
      ...buildTranslationFewShotMessages(config),
      {
        role: 'user',
        content: JSON.stringify(buildTranslationUserPayload(inputs)),
      },
    ],
  })

  // 設定起因の致命エラーはリトライ・半分割・catch-all のいずれにも委ねず即座に伝播させる。
  // メッセージには buildLlmFailureCode() の短い分類コードのみを使う。result.errorMessage
  // には formatAiGatewayHttpError の raw= （プロバイダの生応答本文）が含まれうるため
  // （translateEn の他箇所・correct.ts の同種の対応も参照）。
  if (isFatalTranslationHttpError(result)) {
    throw new TranslationFatalError(`translation API returned a non-recoverable status. error=${buildLlmFailureCode({ errorCode: result.errorCode, httpStatus: result.httpStatus })}`)
  }
  if (result.errorCode === 'truncated') {
    throw new TranslationRetryableError(`translation API stopped because output length was reached. content=${result.content.slice(0, 500)}`)
  }
  if (result.errorCode || !result.content.trim()) {
    const code = result.errorCode
      ? buildLlmFailureCode({ errorCode: result.errorCode, httpStatus: result.httpStatus })
      : 'empty_response'
    throw new TranslationRetryableError(`translation API response did not include message content. error=${code}`)
  }

  let parsed: Record<string, unknown>
  try {
    parsed = parseJsonObjectFromLlmContent(result.content, 'translation')
  } catch (error) {
    const rescued = rescuePlainTextTranslation(inputs, result.content, config.languages.subtitle)
    if (rescued !== undefined) {
      return { texts: [rescued], rescued: [true] }
    }
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
  const coalesced = coalesceTranslations(translations, inputs.length)
  if (!coalesced) {
    throw new TranslationRetryableError(`translation API returned ${translations.length} segments for ${inputs.length} inputs`)
  }

  const texts = coalesced.map((item) => normalizeSpaces(String(item)))
  return { texts, rescued: texts.map(() => false) }
}

/**
 * 翻訳件数と入力件数のずれをコード側で吸収する。
 * 温度0ではリトライしても同じずれが決定的に再現するため、
 * 1入力に複数翻訳が返るケース（モデルが勝手に分割する）は結合して採用する。
 * 複数入力でのずれは対応関係が特定できないので null を返し、バッチ半割リトライに委ねる。
 */
function coalesceTranslations(translations: unknown[], inputCount: number): string[] | null {
  if (!translations.every((item): item is string => typeof item === 'string')) return null
  if (translations.length === inputCount) return translations
  if (inputCount === 1 && translations.length > 1) return [translations.join(' ')]
  return null
}

async function callContextGroupAllocation(
  groups: ContextGroupTranslationDraft[],
  config: ReturnType<typeof resolveApiConfig>,
  glossaryTerms: string[],
): Promise<Map<number, string>> {
  if (groups.length === 0) return new Map()
  const glossaryInstruction = buildGlossaryInstruction(glossaryTerms, config.languages)
  // 組み込みの分担例は日本語→英語なので、transcript が日本語スクリプトの構成でだけ使う
  const allocationFewShotMessages: Array<{ role: 'user' | 'assistant'; content: string }> =
    config.languages.transcript.script === 'japanese'
      ? [
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
        ]
      : []
  const charCount = groups.reduce((sum, group) => sum + group.text.length, 0)
  const itemCount = groups.reduce((sum, group) => sum + group.items.length, 0)
  const maxTokens = withReasoningHeadroom(estimateDesiredOutputTokens(charCount, itemCount), config.modelProfile, config.reasoningBudgetOverrideTokens)
  const result = await createAiGateway(config.settings).chatText({
    nodeName: 'translateEn[contextGroupAllocation]',
    model: config.model,
    temperature: 0.0,
    jsonSchema: CONTEXT_GROUP_TRANSLATION_JSON_SCHEMA,
    maxTokens,
    resolveRuntimeContextLength: true,
    messages: [
      { role: 'system', content: withContextGroupAllocationInstruction(config.systemPrompt, config.languages) + glossaryInstruction },
      ...allocationFewShotMessages,
      {
        role: 'user',
        content: JSON.stringify(buildContextGroupTranslationPayload(groups)),
      },
    ],
  })

  if (result.errorCode === 'truncated') {
    throw new TranslationRetryableError(`context group translation stopped because output length was reached. content=${result.content.slice(0, 500)}`)
  }
  if (result.errorCode || !result.content.trim()) {
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
        throwIfPipelineAborted()
        return await callContextGroupAllocation(batches[index], config, glossaryTerms)
      } catch (error) {
        // 中断は失敗ではないので、この段の「失敗しても空 Map で続行」には載せない。
        if (isPipelineAbortedError(error)) throw error
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
  /** 分岐判定に使う構造化エラーコード。'context_exceeded' は決定的エラー（同一内容の盲リトライ禁止）。 */
  errorCode?: ChatTextResult['errorCode']
  /** HTTP エラー時のステータス。buildLlmFailureCode で短い分類コードを組み立てる際に使う。 */
  httpStatus?: number
}

async function callTranslationOnce(
  input: TranslationInput,
  config: ReturnType<typeof resolveApiConfig>,
  glossaryTerms: string[],
): Promise<SingleCallResult> {
  const glossaryInstruction = buildGlossaryInstruction(glossaryTerms, config.languages)
  const maxTokens = withReasoningHeadroom(estimateDesiredOutputTokens(input.text.length, 1), config.modelProfile, config.reasoningBudgetOverrideTokens)
  const result = await createAiGateway(config.settings).chatText({
    nodeName: 'translateEn[single]',
    model: config.model,
    temperature: 0.0,
    jsonSchema: TRANSLATION_JSON_SCHEMA,
    maxTokens,
    // 実際のコンテキスト長を反映してクランプする（LM Studio 系プロファイルのみ有効。
    // modelProfile.ts の CONSERVATIVE_CONTEXT_LENGTH_CEILING_TOKENS の JSDoc 参照）。
    resolveRuntimeContextLength: true,
    messages: [
      { role: 'system', content: withContextInstruction(config.systemPrompt) + glossaryInstruction },
      ...buildTranslationFewShotMessages(config),
      {
        role: 'user',
        content: JSON.stringify(buildTranslationUserPayload([input])),
      },
    ],
  })

  // 即諦め分岐: content_filter / refusal / length（errorMessage の文字列比較ではなく errorCode で分岐する）
  if (result.errorCode === 'content_filter') {
    return { translation: '', finishReason: result.finishReason, refusal: result.refusal, errorMessage: result.errorMessage ?? 'content_filter', errorCode: result.errorCode, httpStatus: result.httpStatus }
  }
  if (result.errorCode === 'model_refusal' || result.refusal) {
    return { translation: '', finishReason: result.finishReason, refusal: result.refusal, errorMessage: result.errorMessage ?? `model_refusal: ${(result.refusal ?? '').slice(0, 200)}`, errorCode: result.errorCode, httpStatus: result.httpStatus }
  }
  if (result.errorCode === 'truncated') {
    return { translation: '', finishReason: result.finishReason, errorMessage: result.errorMessage ?? `truncated_at_length_limit (content_preview=${result.content.slice(0, 100)})`, errorCode: result.errorCode, httpStatus: result.httpStatus }
  }
  if (result.errorCode || !result.content.trim()) {
    return { translation: '', finishReason: result.finishReason, errorMessage: result.errorMessage ?? 'empty_response', errorCode: result.errorCode, httpStatus: result.httpStatus }
  }

  // JSON 解析
  let parsed: Record<string, unknown>
  try {
    parsed = parseJsonObjectFromLlmContent(result.content, 'translation single')
  } catch (err) {
    // F と同じ素テキスト救済。1入力のみのリクエストなので条件はそのまま流用できる。
    const rescued = rescuePlainTextTranslation([input], result.content, config.languages.subtitle)
    if (rescued !== undefined) {
      return { translation: rescued, finishReason: result.finishReason, refusal: result.refusal }
    }
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
    // context_exceeded は決定的エラー: 1入力まで縮退済みなのでこれ以上入力を小さくできず、
    // 同一内容を再送しても絶対に回復しない（盲リトライしても無駄。本番事故の再発防止:
    // 実データで translationRetryAttempts が全件2＝同一内容の盲リトライで失敗していた）。
    //
    // reason の組み立てには必ず buildLlmFailureCode() を経由し、プロバイダの生応答本文を含めない。
    // この reason は最終的に enText（字幕本文そのもの）の [UNTRANSLATED: ...] マーカーに
    // 埋め込まれる（後段の block 構築部参照）ため、生の HTTP エラー本文（組織ID等を含みうる）を
    // 直接埋め込むと字幕ファイル・共有されるプロジェクト JSON に情報漏洩する
    // （本番事故: 429 応答の生 JSON がそのまま字幕テキストに出力されていた）。
    if (result.errorCode === 'context_exceeded') {
      return {
        translation: '',
        attempts: attempt,
        succeeded: false,
        reason: `${buildLlmFailureCode({ errorCode: result.errorCode, httpStatus: result.httpStatus })}_at_attempt_${attempt} (retry_futile)`,
      }
    }
    // quota_exhausted も同じ理由で即諦める（防御的な多重チェック）。通常はバッチ段の
    // callOpenAICompatible が isFatalTranslationHttpError 経由で先に TranslationFatalError を
    // 投げて translateEn 全体を止めるため、ここに到達するのは稀（例: バッチ成功後、個別リトライ
    // の最中にちょうどクォータが尽きた場合）だが、その場合でも盲リトライで空費しない。
    if (result.errorCode === 'quota_exhausted') {
      return {
        translation: '',
        attempts: attempt,
        succeeded: false,
        reason: `${buildLlmFailureCode({ errorCode: result.errorCode, httpStatus: result.httpStatus })}_at_attempt_${attempt} (retry_futile)`,
      }
    }

    // 一般エラー: リトライ可能。
    // errorCode が 'http_error' | 'rate_limited' の場合のみ buildLlmFailureCode() の短い
    // 分類コードに置き換える（この2つは formatAiGatewayHttpError 経由でプロバイダの生応答本文が
    // errorMessage に含まれうるため。上の context_exceeded 分岐と同じ理由）。
    // それ以外（timeout / fetch_failed / response_json_parse_failed / json_parse_failed など、
    // callTranslationOnce 自身が err.message やモデル出力から組み立てたメッセージ）は
    // プロバイダの生応答本文を含まない安全な文字列なので、従来どおり詳細を残す
    // （translateEn.test.ts の json_parse_failed 検証など、診断用途で使われているため）。
    if (result.errorMessage) {
      const safeReason = result.errorCode === 'http_error' || result.errorCode === 'rate_limited'
        ? buildLlmFailureCode({ errorCode: result.errorCode, httpStatus: result.httpStatus })
        : result.errorMessage
      lastReason = `attempt_${attempt}_${safeReason}`
      continue
    }

    // 翻訳成功
    if (!looksUntranslated(input.text, result.translation, config.languages.subtitle)) {
      return {
        translation: result.translation,
        attempts: attempt,
        succeeded: true,
      }
    }

    // まだ未翻訳: ratio を含めて理由を残してリトライ
    const targetRatio = computeTargetCharRatio(result.translation, config.languages.subtitle)
    lastReason = `attempt_${attempt}_untranslated (targetCharRatio=${targetRatio}, content_preview=${result.translation.slice(0, 80)})`
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

async function translateBatchWithFallback(
  inputs: TranslationInput[],
  config: ReturnType<typeof resolveApiConfig>,
  glossaryTerms: string[],
): Promise<BatchTranslationOutcome> {
  if (inputs.length === 0) return { texts: [], rescued: [] }
  try {
    return await callOpenAICompatible(inputs, config, glossaryTerms)
  } catch (error) {
    if (!isRetryableTranslationError(error)) throw error
    if (inputs.length === 1) {
      // G: 単一入力まで縮退したバッチ失敗はここで throw しない。
      // 以前はここで `throw formatTranslationFailure(...)` していたため、TranslationRetryableError
      // ではない新規の Error が split 再帰を素通りして translateInBatches の外まで伝播し、
      // 1ブロックの失敗で 72分のパイプライン全体が全損する事故につながっていた。
      // 空文字を返せば translateEn 側の looksUntranslated が確実に「未翻訳」と判定し、
      // 既存の個別リトライ経路（retranslateBlockIndividually → callTranslationOnce）に載る。
      return { texts: [''], rescued: [false] }
    }
  }

  const splitAt = Math.ceil(inputs.length / 2)
  const left = await translateBatchWithFallback(inputs.slice(0, splitAt), config, glossaryTerms)
  const right = await translateBatchWithFallback(inputs.slice(splitAt), config, glossaryTerms)
  return { texts: [...left.texts, ...right.texts], rescued: [...left.rescued, ...right.rescued] }
}

async function translateInBatches(
  inputs: TranslationInput[],
  config: ReturnType<typeof resolveApiConfig>,
  glossaryTerms: string[],
): Promise<BatchTranslationOutcome> {
  const batches: TranslationInput[][] = []
  for (let start = 0; start < inputs.length; start += config.maxSegmentsPerRequest) {
    batches.push(inputs.slice(start, start + config.maxSegmentsPerRequest))
  }
  const results = await mapWithConcurrency(
    batches.length,
    config.requestConcurrency,
    async (index): Promise<BatchTranslationOutcome> => {
      try {
        // 協調的キャンセルの検知点。中断済みなら次のバッチを始めない。
        throwIfPipelineAborted()
        return await translateBatchWithFallback(batches[index], config, glossaryTerms)
      } catch (error) {
        // 中断は失敗ではないので降格させず、呼出元まで伝播させる。
        if (isPipelineAbortedError(error)) throw error
        // 設定起因の致命エラー（認証誤り・モデルID誤り等）はここで握り潰さない。
        // 降格させると全ブロックが個別リトライを空振りしてから未翻訳で終わるため、
        // 即座に検知すべき失敗の通知が数十分遅れる。
        if (error instanceof TranslationFatalError) throw error
        // H: 最後の砦。バッチ全体が（非リトライ対象のエラーなど）想定外の理由で落ちても、
        // 他バッチやパイプライン全体を巻き込まない。空文字は looksUntranslated で
        // 「未翻訳」と判定され、後段の個別リトライ（retranslateBlockIndividually）に委ねられる。
        return { texts: batches[index].map(() => ''), rescued: batches[index].map(() => false) }
      }
    },
  )
  return {
    texts: results.flatMap((r) => r.texts),
    rescued: results.flatMap((r) => r.rescued),
  }
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
  // F: バッチがJSONラッパー無しの素テキストをそのまま返し、それを救済採用した block の index。
  // EnBlock.translationRescued として可視化する（詳細は下の block 構築部）。
  const rescuedBlockIndices = new Set<number>()
  const groupTranslations = await translateContextGroups(inputs, config, glossaryTerms)
  for (const [index, text] of groupTranslations.entries()) {
    translatedTexts[index] = text
  }

  const fallbackIndices = inputs
    .map((_, index) => index)
    .filter(index => translatedTexts[index] === undefined)
  if (fallbackIndices.length > 0) {
    const fallbackOutcome = await translateInBatches(fallbackIndices.map(index => inputs[index]), config, glossaryTerms)
    fallbackIndices.forEach((blockIndex, fallbackIndex) => {
      translatedTexts[blockIndex] = fallbackOutcome.texts[fallbackIndex] ?? ''
      if (fallbackOutcome.rescued[fallbackIndex]) rescuedBlockIndices.add(blockIndex)
    })
  }

  // 未翻訳判定された block を集めて個別リトライ
  const untranslatedIndices: number[] = []
  for (let i = 0; i < blocks.length; i += 1) {
    const enRaw = translatedTexts[i] ?? ''
    if (looksUntranslated(blocks[i].jaText, enRaw, config.languages.subtitle)) {
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
    // F の救済で採用された訳文かどうか。translationRetryAttempts は「実際にリトライした回数」
    // という本来の意味だけを持たせ、救済の有無はこの専用フラグで表す。
    const translationRescued = rescuedBlockIndices.has(index)

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
    if (translationRescued) result.translationRescued = true
    return result
  })
}

export const __testing = {
  looksUntranslated,
  computeTargetCharRatio,
  buildTranslationUserPayload,
  buildContextGroupTranslationDrafts,
  buildContextGroupTranslationPayload,
  coalesceTranslations,
  rescuePlainTextTranslation,
  estimateDesiredOutputTokens,
}
