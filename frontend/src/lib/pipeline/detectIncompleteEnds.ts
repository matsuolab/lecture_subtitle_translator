import type { AdminSettings } from '@/types/adminSettings'
import { buildLlmFailureCode } from '@/lib/aiGateway'
import type { JsonSchemaSpec } from '@/lib/aiGateway'
import type { ModelProfile } from '@/types/modelProfile'
import { requireChatModelForProvider, resolveChatModelForProvider } from './aiProvider'
import { parseJsonObjectFromLlmContent } from './jsonResponse'
import { llmCallWithMeta, isAbortableFailure, type LlmCallResult } from './llmCallWithMeta'
import { mapWithConcurrency } from '@/lib/concurrency'
import { resolveModelProfile, withReasoningHeadroom } from './modelProfile'
import { throwIfPipelineAborted } from './pipelineAbort'
import { hasSentenceEnd, loadLanguageProfileConfig, type LanguageRoleProfile } from './languageProfileConfig'

/**
 * テキスト配列に対し「末尾が mid-sentence で次の発話に続いているか」を判定する。
 *
 * 設計意図:
 *   - semanticSplitJa が「〜が」「〜の」「〜まで」「〜and」「〜but」等で切ったブロックは
 *     翻訳時に隣接内容を取り込みやすく、結果として EN が時間枠を超えて CPS 違反になる。
 *   - 多言語対応のため regex ベースの判定ではなく LLM に投げる。
 *   - 高速・低コストの nano モデルを使い、バッチ + 並列で 1000+ 件でも数秒で終わるよう設計。
 *
 * 失敗ハンドリング（案A: 失敗種別ごとに対応を変える）:
 *   - **設定エラー** (no API key, HTTP 401/403/404, 通信そのものが成立しない): 最初のバッチで
 *     検出して早期 abort。残バッチは LLM 呼出こそ行わないが、決定的フォールバック（後述）は
 *     正規表現のみで完結するため適用する。
 *   - **truncated**（gateway の errorCode==='truncated'。応答が出力上限で切れた場合）:
 *     バッチが大きすぎ。半分に割って再帰実行（最大 2 段）。
 *   - **transient 失敗** (5xx, network, JSON parse 失敗, empty): 1 回だけリトライ。
 *     失敗すれば該当バッチのみ諦め、他バッチは継続。
 *   - **abortable** (content_filter / model_refusal): リトライ無駄。該当バッチ諦め。
 *   - 上記いずれかで諦めたブロックは、一律 false にはせず、transcript 側の言語プロファイル
 *     （AdminSettings.languageProfileConfigJson）の文末パターンを使った決定的フォールバックで判定する
 *     （詳細は deterministicIncompleteFlag 参照）。
 *
 * 分岐判定について:
 *   失敗種別の分岐は必ず LlmCallResult.errorCode（構造化コード）を使う。errorMessage は
 *   gateway 側で診断情報の suffix（content_preview= 等）が付与される表示用の自由文字列であり、
 *   完全一致・前方一致等の文字列比較を分岐判定に使ってはならない
 *   （過去に `errorMessage === 'truncated_at_length_limit'` という完全一致判定が、実際には
 *    suffix 付きの文字列が返るため永久に不成立となり、半割リトライが一度も発火しなかった事故がある。
 *    本番ログ実測で 42.3 分・729 ブロック中 630 ブロックの判定が丸ごと失敗していた）。
 *
 * 出力トークン上限について:
 *   thinking 系モデルは completion_tokens の大半を reasoning が消費する（実測 84〜87%）ため、
 *   maxTokens 未指定のままだとバッチサイズが大きい場合に出力上限へ到達しやすい。
 *   1 件あたりの想定出力サイズから見積もった値を withReasoningHeadroom() で割り増して渡す。
 *   同様の理由で、thinking 系モデル解決時はバッチサイズ自体も実行時にクランプする
 *   （設定値の incompleteEndDetectionBatchSize 自体は書き換えない）。
 *
 *   【2026-08 追記】上記の見積り（withReasoningHeadroom の戻り値）が実際に API へ渡る
 *   max_tokens / max_completion_tokens として使われるのは local_openai 経路のみになった。
 *   openai / gemini 経路では、この見積りが原因で 796 ブロック中 226 件（うち 212 件が
 *   truncated）の判定失敗を引き起こしていたことが実測で判明した。バッチ件数から見積もった
 *   376 のときだけ finishReason=length で本文 0 文字のまま切断され、1200 / 4096 / 送らない の
 *   いずれでも消費量は 450 前後で安定して完走した。上限は消費量を左右せず成功可否だけを
 *   左右しており、しかも truncated 時の半割リトライはバッチ件数から予算を再計算するため、
 *   割るほど予算も一緒に減って逆効果だった（212 件が一度も救済されなかった原因）。この事実を
 *   受け、adaptChatCompletionRequest（modelProfile.ts）が openai / gemini 向けには
 *   max_tokens / max_completion_tokens を丸ごと送らなくなった（stripTokenLimitFields 参照）。
 *   このファイルの見積りロジック自体は変更していない（local_openai 向けの見積りとして
 *   引き続き必要なため）。
 *
 * 入力配列と出力 flags の長さ・順序は完全一致する。
 */

const DETECTION_SYSTEM_PROMPT =
  'You are a fast subtitle-fragment classifier. ' +
  'For each input item, decide if it ENDS MID-SENTENCE (i.e., it is grammatically incomplete and continues into the next utterance). ' +
  'Examples that end MID-SENTENCE (incomplete=true): ends with a connective particle like を/に/が/は/で/と/から/まで/ため/として/ば, ' +
  'or with a comma+conjunction like ",and", ",but", ",because", or trails off without a sentence-final punctuation. ' +
  'Examples that DO NOT end mid-sentence (incomplete=false): ends with 。!?.!? or any clear sentence-final form. ' +
  'Be fast and approximate. Multi-language input is fine. ' +
  'Respond only with JSON: {"r":[{"i":<id>,"x":<true|false>}, ...]} where x=true means INCOMPLETE.'

/**
 * Structured Outputs 用 JSON Schema。実機（LM Studio / OpenAI 互換）で動作確認済みの形を維持する。
 * additionalProperties:false / 全フィールド required は strict:true 前提のための必須条件
 * （apiCompatibilityProfile.ts の JsonSchemaSpec 参照）。
 */
const DETECT_RESPONSE_JSON_SCHEMA: JsonSchemaSpec = {
  name: 'detect_incomplete_ends',
  schema: {
    type: 'object',
    properties: {
      r: {
        type: 'array',
        items: {
          type: 'object',
          properties: { i: { type: 'integer' }, x: { type: 'boolean' } },
          required: ['i', 'x'],
          additionalProperties: false,
        },
      },
    },
    required: ['r'],
    additionalProperties: false,
  },
}

/**
 * バッチ 1 件あたりの想定出力トークン数。レスポンス 1 要素 {"i":<id>,"x":<bool>} は
 * 概ね 10 トークン前後だが、id が複数桁になるケースや区切り文字の揺れを見込んで少し余裕を持たせる。
 */
const ESTIMATED_TOKENS_PER_RESULT_ITEM = 12

/** レスポンス全体を包む {"r":[...]}  自体のオーバーヘッド分（件数に依存しない固定コスト）。 */
const RESPONSE_ENVELOPE_OVERHEAD_TOKENS = 16

/**
 * バッチの件数から「本文として必要な出力トークン数」を見積もる。
 * この値は withReasoningHeadroom() に通してから maxTokens として使うこと
 * （thinking 系モデルは reasoning が completion_tokens の大半を消費するため、素の値だと不足する）。
 */
function estimateDesiredOutputTokens(itemCount: number): number {
  return itemCount * ESTIMATED_TOKENS_PER_RESULT_ITEM + RESPONSE_ENVELOPE_OVERHEAD_TOKENS
}

/**
 * 既定バッチサイズ（AdminSettings.incompleteEndDetectionBatchSize、既定 30）は高速な nano クラスの
 * モデルを前提にした値。thinking 系モデル（reasoning.capability が 'always_on' | 'toggleable'）は
 * 件数なりに思考が膨張し、実測で 1 コールあたり約 6 分かかった上に出力上限に達してバッチ全体が
 * truncated で失敗する原因になっていた。thinking 系モデル解決時のみ、実行時にバッチサイズを
 * この値で頭打ちにする（設定値そのものは変更しない）。
 */
const THINKING_MODEL_MAX_BATCH_SIZE = 8

function isThinkingCapableProfile(profile: ModelProfile | undefined): boolean {
  return profile?.reasoning.capability === 'always_on' || profile?.reasoning.capability === 'toggleable'
}

/**
 * 実行時のバッチサイズを解決する。モデル解決に失敗した場合（API key 未設定等）でも例外は投げず、
 * 素の設定値をそのまま返す（実際の設定エラー検出は detectBatchOnce 側の
 * requireChatModelForProvider に委ねる）。
 */
function resolveEffectiveBatchSize(settings: AdminSettings): number {
  const configured = Math.max(1, settings.incompleteEndDetectionBatchSize)
  const requestedModel = settings.incompleteEndDetectionModel || settings.splitJaModel
  const model = resolveChatModelForProvider(settings, requestedModel)
  const profile = resolveModelProfile(settings, model)
  return isThinkingCapableProfile(profile) ? Math.min(configured, THINKING_MODEL_MAX_BATCH_SIZE) : configured
}

/**
 * LLM 判定に失敗したブロックに対する決定的フォールバック。
 * DETECTION_SYSTEM_PROMPT が定義する判定基準（文末が完結パターン: 。！？!? 等でなければ未完結とみなす）を、
 * transcript 側の言語プロファイル（AdminSettings.languageProfileConfigJson の sentenceEndPattern）で再現する。
 * hasSentenceEnd / matchesPattern は不正な正規表現・未設定パターンに対して安全側（false）を返す
 * （languageProfileConfig.ts 参照）ため、ここで追加の try/catch は不要。
 */
function deterministicIncompleteFlag(text: string, transcriptProfile: LanguageRoleProfile): boolean {
  return !hasSentenceEnd(text, transcriptProfile)
}

interface DetectResultItem {
  id: number
  incomplete: boolean
}

interface BatchItem {
  id: number
  text: string
}

/**
 * LLM 判定が失敗した理由の分類。BatchOutcome の kind と対応する。
 * config_error は常に abortedOutcome（全体 abort）経由でのみ発生し、残り3種は
 * giveUpBatch（該当バッチだけ諦めて決定的フォールバックへ倒す）経由で発生する。
 *
 * 背景（本番事故）: 実行ログには「308 of 823 blocks fell back to singleton context groups」
 * という集計1行しか残らず、308件のうち timeout が何件で truncated が何件かが後から分からなかった。
 * 実際には「存在しないモデルを指していて404で全滅」（= config_error）していたケースがあったが、
 * 集計メッセージからはそれが読み取れなかった。種別ごとに数えて trace に残す。
 */
export type IncompleteEndsFailureKind = 'abortable' | 'retryable' | 'truncated' | 'config_error'

export type FailureKindCounts = Record<IncompleteEndsFailureKind, number>

function emptyFailureKindCounts(): FailureKindCounts {
  return { abortable: 0, retryable: 0, truncated: 0, config_error: 0 }
}

function singleFailureKindCount(kind: IncompleteEndsFailureKind, count: number): FailureKindCounts {
  return { ...emptyFailureKindCounts(), [kind]: count }
}

function mergeFailureKindCounts(a: FailureKindCounts, b: FailureKindCounts): FailureKindCounts {
  return {
    abortable: a.abortable + b.abortable,
    retryable: a.retryable + b.retryable,
    truncated: a.truncated + b.truncated,
    config_error: a.config_error + b.config_error,
  }
}

export interface DetectionResult {
  /** texts と同じ長さ・順序の boolean 配列。失敗ブロックは決定的フォールバックの判定値 */
  flags: boolean[]
  /** 判定が成功した件数 */
  success: number
  /** LLM 判定に失敗し、決定的フォールバックに倒れた件数 */
  failed: number
  /**
   * failed のうち、決定的フォールバック（正規表現ベース）で実際に判定できた件数。
   * 現状の実装では失敗ブロックは必ず決定的フォールバックを経由するため failed と同値になるが、
   * 「何件が LLM 判定で、何件が決定的フォールバックか」を呼出元が区別できるよう独立したフィールドとして残す。
   */
  deterministicFallbackCount: number
  /**
   * failed の内訳（種別ごとの件数）。合計は failed と一致する。
   * 既存の failed / deterministicFallbackCount は後方互換のため残し、これは追加フィールドとする。
   */
  failureKindCounts: FailureKindCounts
  /** 早期 abort 発生時の理由（config_error 等）。継続実行時は undefined */
  abortReason?: string
}

/**
 * 1 回のバッチ呼び出しの分類結果。
 * kind ごとに mergeContinuation 側の挙動を分岐する。
 */
type BatchOutcome =
  | { kind: 'ok'; items: DetectResultItem[] }
  | { kind: 'config_error'; message: string }    // → 全体 abort
  | { kind: 'truncated'; message: string }       // → バッチ半割で再試行
  | { kind: 'retryable'; message: string }       // → 1回リトライ
  | { kind: 'abortable'; message: string }       // → 該当バッチ諦め

interface ProcessOutcome {
  aborted: boolean
  abortReason?: string
  items: DetectResultItem[]
  successCount: number
  failedCount: number
  /** failedCount のうち決定的フォールバックで判定した件数 */
  fallbackCount: number
  /** failedCount の内訳（種別ごとの件数）。合計は failedCount と一致する。 */
  failureKindCounts: FailureKindCounts
}

function buildBatchUserContent(items: BatchItem[]): string {
  return JSON.stringify(items.map(({ id, text }) => ({ i: id, t: text })))
}

function parseBatchResponse(content: string, expectedIds: number[]): DetectResultItem[] {
  const parsed = parseJsonObjectFromLlmContent(content, 'detect_incomplete_ends')
  const raw = parsed.r ?? parsed.results
  if (!Array.isArray(raw)) return []
  const results: DetectResultItem[] = []
  const expected = new Set(expectedIds)
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const row = entry as Record<string, unknown>
    const idRaw = row.i ?? row.id
    const id = typeof idRaw === 'number' ? idRaw : Number(idRaw)
    if (!Number.isFinite(id) || !expected.has(id)) continue
    const x = row.x ?? row.incomplete
    const incomplete = x === true || x === 'true' || x === 1
    results.push({ id, incomplete })
  }
  return results
}

function classifyCallError(call: LlmCallResult): BatchOutcome | null {
  if (!call.errorMessage) return null
  // content_filter / model_refusal はリトライしても結果が変わらないため最優先で確定させる
  if (isAbortableFailure(call)) {
    return { kind: 'abortable', message: call.errorMessage }
  }

  // 分岐判定は必ず errorCode（構造化コード）を使う。errorMessage は表示用の自由文字列であり、
  // gateway 側で診断情報の suffix が付与されるため完全一致・前方一致等の文字列比較を
  // 分岐判定に使ってはならない（ファイル冒頭の JSDoc 参照。過去にこの完全一致判定が
  // suffix 付与で永久に不成立となり、半割リトライが一度も発火しなかった事故がある）。
  if (call.errorCode === 'truncated') {
    return { kind: 'truncated', message: call.errorMessage }
  }

  // context_exceeded（HTTP 400 + コンテキスト長超過。errors.ts の classifyHttpErrorCode 参照）は
  // truncated と同じ「半割で再試行」に分類する。決定的エラーであり同一内容の盲リトライは
  // 無駄だが、バッチを半分に割ればプロンプトサイズが縮むため、truncated と同じ分割トリガーが
  // 有効に働く（新しい分類概念を増やさず、既存の半割リトライの仕組みに倣う）。
  if (call.errorCode === 'context_exceeded') {
    return { kind: 'truncated', message: call.errorMessage }
  }

  // quota_exhausted（HTTP 429 のうち OpenAI 公式仕様の insufficient_quota。aiGateway/errors.ts の
  // classifyHttpErrorCode 参照）は 401/403/404 と同格の致命エラー: 課金設定を直さない限り
  // 絶対に回復しない。下の 401/403/404 分岐と同じ config_error（早期 abort。残バッチへの
  // 無駄な API call を止める）に載せる。message は buildLlmFailureCode() の短い分類コードのみ
  // にし、formatAiGatewayHttpError 経由でプロバイダの生応答本文（call.errorMessage）を
  // そのまま含めない（correct.ts / translateEn.ts の同種の対応と同じ理由）。
  if (call.errorCode === 'quota_exhausted') {
    return { kind: 'config_error', message: buildLlmFailureCode({ errorCode: call.errorCode, httpStatus: call.httpStatus }) }
  }

  // 設定起因: 認証エラー・モデル未対応（HTTP 401/403/404）、および接続情報の解決自体に
  // 失敗したケース（errorCode==='connection_failed'。API key 未設定など、実際に fetch すら
  // 発行していない設定不備）。設定を直さない限り何度リトライしても失敗し続けるため
  // 早期 abort する。
  //
  // 注意: errorCode==='fetch_failed'（fetch 実行中の例外。一時的なネットワーク断など）を
  // ここに含めてはならない。過去に connection_failed と fetch_failed の両方が同じ
  // errorCode='fetch_failed' に統一されていたことがあり、その結果この分岐が一時的な
  // 通信断まで config_error 扱いして検出処理全体を早期 abort させる退行を起こしていた。
  // fetch_failed は下の retryable 分岐で 1 回リトライされるべきものであり、
  // classifyCallError より前に connection_failed / fetch_failed が分離された
  // （chatText.ts / chatVision.ts 参照）ことでこの区別が可能になっている。
  if (call.httpStatus === 401 || call.httpStatus === 403 || call.httpStatus === 404 || call.errorCode === 'connection_failed') {
    const message = call.httpStatus ? `HTTP ${call.httpStatus}: ${call.errorMessage}` : call.errorMessage
    return { kind: 'config_error', message }
  }

  // 一時的失敗（fetch_failed, 5xx 等の http_error, empty_response, response_json_parse_failed 等）。
  // fetch_failed（一時的なネットワーク断）はここでリトライ対象になる。
  return { kind: 'retryable', message: call.errorMessage }
}

async function detectBatchOnce(items: BatchItem[], settings: AdminSettings): Promise<BatchOutcome> {
  if (items.length === 0) return { kind: 'ok', items: [] }

  const requestedModel = settings.incompleteEndDetectionModel || settings.splitJaModel
  let model: string
  try {
    model = requireChatModelForProvider(settings, requestedModel, 'detect incomplete ends')
  } catch (err) {
    return { kind: 'config_error', message: err instanceof Error ? err.message : String(err) }
  }

  const profile = resolveModelProfile(settings, model)
  const maxTokens = withReasoningHeadroom(estimateDesiredOutputTokens(items.length), profile)

  const call = await llmCallWithMeta(
    {
      model,
      systemPrompt: DETECTION_SYSTEM_PROMPT,
      userContent: buildBatchUserContent(items),
      temperature: 0.0,
      maxTokens,
      jsonSchema: DETECT_RESPONSE_JSON_SCHEMA,
      nodeName: 'detect_incomplete_ends',
    },
    settings,
  )

  const errorOutcome = classifyCallError(call)
  if (errorOutcome) return errorOutcome

  try {
    const results = parseBatchResponse(call.content, items.map(({ id }) => id))
    if (results.length === 0) {
      return { kind: 'retryable', message: 'empty_or_invalid_response' }
    }
    const map = new Map(results.map(r => [r.id, r.incomplete]))
    return {
      kind: 'ok',
      items: items.map(({ id }) => ({ id, incomplete: map.get(id) ?? false })),
    }
  } catch (err) {
    return { kind: 'retryable', message: err instanceof Error ? err.message : 'parse_failed' }
  }
}

function giveUpBatch(
  items: BatchItem[],
  transcriptProfile: LanguageRoleProfile,
  kind: IncompleteEndsFailureKind,
): ProcessOutcome {
  return {
    aborted: false,
    items: items.map(({ id, text }) => ({ id, incomplete: deterministicIncompleteFlag(text, transcriptProfile) })),
    successCount: 0,
    failedCount: items.length,
    fallbackCount: items.length,
    failureKindCounts: singleFailureKindCount(kind, items.length),
  }
}

function abortedOutcome(items: BatchItem[], reason: string, transcriptProfile: LanguageRoleProfile): ProcessOutcome {
  return {
    aborted: true,
    abortReason: reason,
    items: items.map(({ id, text }) => ({ id, incomplete: deterministicIncompleteFlag(text, transcriptProfile) })),
    successCount: 0,
    failedCount: items.length,
    fallbackCount: items.length,
    failureKindCounts: singleFailureKindCount('config_error', items.length),
  }
}

const MAX_TRUNCATION_SPLIT_DEPTH = 2

async function processBatch(
  items: BatchItem[],
  settings: AdminSettings,
  transcriptProfile: LanguageRoleProfile,
  depth = 0,
): Promise<ProcessOutcome> {
  // 協調的キャンセルの検知点。中断済みなら次のバッチを始めない。
  throwIfPipelineAborted()
  const outcome = await detectBatchOnce(items, settings)

  if (outcome.kind === 'ok') {
    return {
      aborted: false,
      items: outcome.items,
      successCount: outcome.items.length,
      failedCount: 0,
      fallbackCount: 0,
      failureKindCounts: emptyFailureKindCounts(),
    }
  }

  if (outcome.kind === 'config_error') {
    return abortedOutcome(items, outcome.message, transcriptProfile)
  }

  // truncated: 半割で再帰（暴走防止のため depth 制限）
  if (outcome.kind === 'truncated' && items.length > 1 && depth < MAX_TRUNCATION_SPLIT_DEPTH) {
    const mid = Math.floor(items.length / 2)
    const [left, right] = await Promise.all([
      processBatch(items.slice(0, mid), settings, transcriptProfile, depth + 1),
      processBatch(items.slice(mid), settings, transcriptProfile, depth + 1),
    ])
    const combinedFailureKindCounts = mergeFailureKindCounts(left.failureKindCounts, right.failureKindCounts)
    if (left.aborted) {
      return {
        ...left,
        items: [...left.items, ...right.items],
        failedCount: left.failedCount + right.failedCount,
        fallbackCount: left.fallbackCount + right.fallbackCount,
        failureKindCounts: combinedFailureKindCounts,
      }
    }
    if (right.aborted) {
      return {
        ...right,
        items: [...left.items, ...right.items],
        failedCount: left.failedCount + right.failedCount,
        fallbackCount: left.fallbackCount + right.fallbackCount,
        failureKindCounts: combinedFailureKindCounts,
      }
    }
    return {
      aborted: false,
      items: [...left.items, ...right.items],
      successCount: left.successCount + right.successCount,
      failedCount: left.failedCount + right.failedCount,
      fallbackCount: left.fallbackCount + right.fallbackCount,
      failureKindCounts: combinedFailureKindCounts,
    }
  }

  // retryable: 1 回だけリトライ（top-level のみ。再帰中は無限ループ防止のため抑止）
  if (outcome.kind === 'retryable' && depth === 0) {
    const retry = await detectBatchOnce(items, settings)
    if (retry.kind === 'ok') {
      return {
        aborted: false,
        items: retry.items,
        successCount: retry.items.length,
        failedCount: 0,
        fallbackCount: 0,
        failureKindCounts: emptyFailureKindCounts(),
      }
    }
    if (retry.kind === 'config_error') {
      return abortedOutcome(items, retry.message, transcriptProfile)
    }
    // リトライしても駄目だった場合は、リトライ後に実際に返ってきた種別で数える
    // （最初は retryable でも、リトライ結果が truncated / abortable に変わることがある）。
    return giveUpBatch(items, transcriptProfile, retry.kind)
  }

  // それ以外（abortable / truncated が depth超過で諦め / retryable が再帰中で抑止）は
  // バッチ諦め → 決定的フォールバック。outcome.kind をそのまま失敗種別として数える。
  return giveUpBatch(items, transcriptProfile, outcome.kind)
}

export async function detectIncompleteEnds(
  texts: string[],
  settings: AdminSettings,
): Promise<DetectionResult> {
  if (texts.length === 0) {
    return { flags: [], success: 0, failed: 0, deterministicFallbackCount: 0, failureKindCounts: emptyFailureKindCounts() }
  }

  const transcriptProfile = loadLanguageProfileConfig(settings).transcript
  const batchSize = resolveEffectiveBatchSize(settings)
  const concurrency = Math.max(1, settings.apiRequestConcurrency)

  const batches: BatchItem[][] = []
  for (let i = 0; i < texts.length; i += batchSize) {
    batches.push(texts.slice(i, i + batchSize).map((text, j) => ({ id: i + j, text })))
  }

  const flags = new Array<boolean>(texts.length).fill(false)

  // プローブ: 最初のバッチを単独で実行し、設定エラーを早期検出する。
  // ここで config_error が出れば残バッチを走らせず即返却（無駄な API call を抑制）。
  const probe = await processBatch(batches[0], settings, transcriptProfile)
  for (const item of probe.items) {
    if (item.id >= 0 && item.id < texts.length) flags[item.id] = item.incomplete
  }
  if (probe.aborted) {
    // 残バッチは LLM 呼出こそ行わないが（config_error 起因の無駄な API call を避けるため）、
    // 決定的フォールバックは正規表現のみで完結するのでここでも適用する。
    // 残バッチは LLM を一度も呼んでいないが、呼ばなかった理由は最初のバッチと同じ
    // config_error（設定を直さない限り呼んでも失敗するため）なので、内訳にも config_error として計上する。
    const remainder: BatchItem[] = texts
      .slice(batches[0].length)
      .map((text, j) => ({ id: batches[0].length + j, text }))
    for (const { id, text } of remainder) {
      if (id >= 0 && id < texts.length) flags[id] = deterministicIncompleteFlag(text, transcriptProfile)
    }
    return {
      flags,
      success: probe.successCount,
      failed: probe.failedCount + remainder.length,
      deterministicFallbackCount: probe.fallbackCount + remainder.length,
      failureKindCounts: mergeFailureKindCounts(
        probe.failureKindCounts,
        singleFailureKindCount('config_error', remainder.length),
      ),
      abortReason: probe.abortReason,
    }
  }

  let success = probe.successCount
  let failed = probe.failedCount
  let deterministicFallbackCount = probe.fallbackCount
  let failureKindCounts = probe.failureKindCounts

  if (batches.length === 1) {
    return { flags, success, failed, deterministicFallbackCount, failureKindCounts }
  }

  const restBatches = batches.slice(1)
  const restResults = await mapWithConcurrency(
    restBatches.length,
    concurrency,
    (idx) => processBatch(restBatches[idx], settings, transcriptProfile),
  )

  for (const r of restResults) {
    for (const item of r.items) {
      if (item.id >= 0 && item.id < texts.length) flags[item.id] = item.incomplete
    }
    success += r.successCount
    failed += r.failedCount
    deterministicFallbackCount += r.fallbackCount
    failureKindCounts = mergeFailureKindCounts(failureKindCounts, r.failureKindCounts)
  }

  // 並列実行中にどこかが abort 状態になった場合は理由を残す（rare: probeを通過しても
  // モデル一時障害等で個別バッチが認証類エラーを返す可能性に備える）
  const lateAbort = restResults.find((r) => r.aborted)
  if (lateAbort) {
    return { flags, success, failed, deterministicFallbackCount, failureKindCounts, abortReason: lateAbort.abortReason }
  }

  return { flags, success, failed, deterministicFallbackCount, failureKindCounts }
}
