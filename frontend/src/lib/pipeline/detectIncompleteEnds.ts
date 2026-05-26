import type { AdminSettings } from '@/types/adminSettings'
import { requireChatModelForProvider } from './aiProvider'
import { parseJsonObjectFromLlmContent } from './jsonResponse'
import { llmCallWithMeta, isAbortableFailure, type LlmCallResult } from './llmCallWithMeta'
import { mapWithConcurrency } from '@/lib/concurrency'

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
 *   - **設定エラー** (no API key, HTTP 401/403/404, model 未対応): 最初のバッチで検出して
 *     早期 abort。残バッチは走らせず、abortReason を返す。
 *   - **truncated_at_length_limit**: バッチが大きすぎ。半分に割って再帰実行（最大 2 段）。
 *   - **transient 失敗** (5xx, network, JSON parse 失敗, empty): 1 回だけリトライ。
 *     失敗すれば該当バッチのみ諦め、他バッチは継続。
 *   - **abortable** (content_filter / model_refusal): リトライ無駄。該当バッチ諦め。
 *   - 諦めた場合は該当ブロックの flags が false（=マージしない）にフォールバック。
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

interface DetectResultItem {
  id: number
  incomplete: boolean
}

interface BatchItem {
  id: number
  text: string
}

export interface DetectionResult {
  /** texts と同じ長さ・順序の boolean 配列。失敗ブロックは false */
  flags: boolean[]
  /** 判定が成功した件数 */
  success: number
  /** 判定に失敗したため false 扱いになった件数 */
  failed: number
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
  if (isAbortableFailure(call)) {
    return { kind: 'abortable', message: call.errorMessage }
  }
  // 設定起因: 接続不能 / 認証エラー / モデル未対応
  if (call.errorMessage.startsWith('connection_failed')) {
    return { kind: 'config_error', message: call.errorMessage }
  }
  if (call.httpStatus === 401 || call.httpStatus === 403 || call.httpStatus === 404) {
    return { kind: 'config_error', message: `HTTP ${call.httpStatus}: ${call.errorMessage}` }
  }
  // バッチサイズ過多: 半分にして再試行
  if (call.errorMessage === 'truncated_at_length_limit') {
    return { kind: 'truncated', message: call.errorMessage }
  }
  // 一時的失敗（5xx, rate limit, empty response, network）
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

  const call = await llmCallWithMeta(
    {
      model,
      systemPrompt: DETECTION_SYSTEM_PROMPT,
      userContent: buildBatchUserContent(items),
      temperature: 0.0,
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

function giveUpBatch(items: BatchItem[]): ProcessOutcome {
  return {
    aborted: false,
    items: items.map(({ id }) => ({ id, incomplete: false })),
    successCount: 0,
    failedCount: items.length,
  }
}

function abortedOutcome(items: BatchItem[], reason: string): ProcessOutcome {
  return {
    aborted: true,
    abortReason: reason,
    items: items.map(({ id }) => ({ id, incomplete: false })),
    successCount: 0,
    failedCount: items.length,
  }
}

const MAX_TRUNCATION_SPLIT_DEPTH = 2

async function processBatch(
  items: BatchItem[],
  settings: AdminSettings,
  depth = 0,
): Promise<ProcessOutcome> {
  const outcome = await detectBatchOnce(items, settings)

  if (outcome.kind === 'ok') {
    return {
      aborted: false,
      items: outcome.items,
      successCount: outcome.items.length,
      failedCount: 0,
    }
  }

  if (outcome.kind === 'config_error') {
    return abortedOutcome(items, outcome.message)
  }

  // truncated: 半割で再帰（暴走防止のため depth 制限）
  if (outcome.kind === 'truncated' && items.length > 1 && depth < MAX_TRUNCATION_SPLIT_DEPTH) {
    const mid = Math.floor(items.length / 2)
    const [left, right] = await Promise.all([
      processBatch(items.slice(0, mid), settings, depth + 1),
      processBatch(items.slice(mid), settings, depth + 1),
    ])
    if (left.aborted) return { ...left, items: [...left.items, ...right.items], failedCount: left.failedCount + right.failedCount }
    if (right.aborted) return { ...right, items: [...left.items, ...right.items], failedCount: left.failedCount + right.failedCount }
    return {
      aborted: false,
      items: [...left.items, ...right.items],
      successCount: left.successCount + right.successCount,
      failedCount: left.failedCount + right.failedCount,
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
      }
    }
    if (retry.kind === 'config_error') {
      return abortedOutcome(items, retry.message)
    }
  }

  // それ以外（abortable / リトライしても駄目 / depth超過）はバッチ諦め
  return giveUpBatch(items)
}

export async function detectIncompleteEnds(
  texts: string[],
  settings: AdminSettings,
): Promise<DetectionResult> {
  if (texts.length === 0) return { flags: [], success: 0, failed: 0 }

  const batchSize = Math.max(1, settings.incompleteEndDetectionBatchSize)
  const concurrency = Math.max(1, settings.apiRequestConcurrency)

  const batches: BatchItem[][] = []
  for (let i = 0; i < texts.length; i += batchSize) {
    batches.push(texts.slice(i, i + batchSize).map((text, j) => ({ id: i + j, text })))
  }

  const flags = new Array<boolean>(texts.length).fill(false)

  // プローブ: 最初のバッチを単独で実行し、設定エラーを早期検出する。
  // ここで config_error が出れば残バッチを走らせず即返却（無駄な API call を抑制）。
  const probe = await processBatch(batches[0], settings)
  for (const item of probe.items) {
    if (item.id >= 0 && item.id < texts.length) flags[item.id] = item.incomplete
  }
  if (probe.aborted) {
    const remainingCount = texts.length - batches[0].length
    return {
      flags,
      success: probe.successCount,
      failed: probe.failedCount + remainingCount,
      abortReason: probe.abortReason,
    }
  }

  let success = probe.successCount
  let failed = probe.failedCount

  if (batches.length === 1) {
    return { flags, success, failed }
  }

  const restBatches = batches.slice(1)
  const restResults = await mapWithConcurrency(
    restBatches.length,
    concurrency,
    (idx) => processBatch(restBatches[idx], settings),
  )

  for (const r of restResults) {
    for (const item of r.items) {
      if (item.id >= 0 && item.id < texts.length) flags[item.id] = item.incomplete
    }
    success += r.successCount
    failed += r.failedCount
  }

  // 並列実行中にどこかが abort 状態になった場合は理由を残す（rare: probeを通過しても
  // モデル一時障害等で個別バッチが認証類エラーを返す可能性に備える）
  const lateAbort = restResults.find((r) => r.aborted)
  if (lateAbort) {
    return { flags, success, failed, abortReason: lateAbort.abortReason }
  }

  return { flags, success, failed }
}
