import type { TauriFetchResponse } from '@/lib/tauriFetch'

/**
 * レート制限（429）・サーバ過負荷（503/529）検知時のバックオフ付きリトライを
 * chatText.ts / chatVision.ts / embeddings.ts の3つの gateway ヘルパーで共通利用するための
 * 純粋関数群。判定・待機時間の計算のみを担い、スロット確保・fetch 実行・リトライループ自体は
 * 各呼出元（chatText 等）に委ねる。
 *
 * 設計上の最重要制約: バックオフ待機は呼出元が acquireLlmSlot() のスロットを解放した「後」に
 * 行うこと。スロットを保持したまま待つと、同時実行枠が「待っているだけのリクエスト」で
 * 埋まり、他の待機中リクエストが永久にスロットを獲得できずパイプライン全体が停止する
 * （本タスクの実データ事故: 同時実行7・レート制限668件でこの手当てが無かったため
 *  即2回連続送信して両方弾かれ諦めていた。バックオフ実装時に同種の新たなデッドロックを
 *  作らないよう、この関数群はスロットの外側で使うことを前提に設計している）。
 */

/**
 * レート制限リトライの最大試行回数（初回 + リトライ）。
 * 一時的な輻輳はリトライ・バックオフで解消する見込みが高く、かつ 429 は「今は無理だが
 * 少し待てば通る」性質が強いエラーであるため、他の一般的なエラー（例: correct.ts の
 * PER_LEAF_RETRY_MAX_ATTEMPTS=2）よりも多めに試行回数を確保する。
 * 6 回（初回 + 最大5リトライ）を採用し、指数バックオフの上限（RATE_LIMIT_MAX_DELAY_MS）と
 * 組み合わせても現実的な待ち時間（後述の見積りで最大 1+2+4+8+16=31秒 程度、ジッタ込みでも
 * 1分弱）に収まるようにする。
 */
export const RATE_LIMIT_MAX_ATTEMPTS = 6

/** 指数バックオフの基準値（1回目の待機は概ね1秒、以降 2s, 4s, 8s, 16s ... と倍加する）。 */
const RATE_LIMIT_BASE_DELAY_MS = 1000

/**
 * バックオフ待機時間の上限（暴走防止）。Retry-After ヘッダが無い場合の指数バックオフにのみ
 * 適用する（Retry-After が明示されていればサーバの指示を優先し、この上限では丸めない）。
 */
const RATE_LIMIT_MAX_DELAY_MS = 30_000

/**
 * バックオフ待機時間に加えるジッタの比率（±50%）。
 * 同時実行 N 本が同じタイミングで 429 を受け取ると、ジッタ無しの指数バックオフでは
 * 全リクエストが寸分違わず同じタイミングで一斉に再送し、再びまとめてレート制限を踏む
 * 「サンダリングハード」現象が起きる。待機時間にランダム幅を持たせることで再送タイミングを
 * 散らし、この現象を避ける。
 */
const RATE_LIMIT_JITTER_RATIO = 0.5

/**
 * 指数バックオフ + ジッタで待機時間 (ms) を計算する。
 * attempt は 1 始まり（1 = 1 回目のリトライ待機）。
 */
export function computeBackoffDelayMs(attempt: number, random: () => number = Math.random): number {
  const exponential = Math.min(RATE_LIMIT_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1), RATE_LIMIT_MAX_DELAY_MS)
  const jitter = exponential * RATE_LIMIT_JITTER_RATIO * (random() * 2 - 1)
  return Math.max(0, Math.round(exponential + jitter))
}

/**
 * Retry-After ヘッダの値を待機時間 (ms) に変換する。
 * 仕様上 2 種類の形式がある: 秒数（例: "2"）、または HTTP-date（例: "Wed, 21 Oct 2026 07:28:00 GMT"）。
 * どちらでもない・パースできない場合は null を返し、呼出元は指数バックオフにフォールバックする。
 */
export function parseRetryAfterMs(value: string | null | undefined): number | null {
  if (!value) return null
  const trimmed = value.trim()
  if (!trimmed) return null

  const seconds = Number(trimmed)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)

  const dateMs = Date.parse(trimmed)
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now())

  return null
}

/**
 * OpenAI が x-ratelimit-reset-requests / x-ratelimit-reset-tokens ヘッダで返す duration 文字列
 * （Go の time.Duration.String() 形式）を待機時間 (ms) に変換する純関数。
 * 例: "1s" / "6m0s" / "120ms" / "1h2m3s" のように、数値+単位の並びを連結した表記。
 * 対応単位: h（時） / m（分） / s（秒） / ms（ミリ秒） / us・µs（マイクロ秒） / ns（ナノ秒）。
 *
 * 不正な値（単位が無い、数字以外の文字が混ざっている、空文字等）は null を返し、
 * 呼出元は Retry-After と同様に指数バックオフへフォールバックすること。
 */
const DURATION_TOKEN_RE = /(\d+(?:\.\d+)?)(h|ms|m|s|µs|us|ns)/g
const DURATION_UNIT_TO_MS: Record<string, number> = {
  h: 3_600_000,
  m: 60_000,
  s: 1000,
  ms: 1,
  us: 0.001,
  µs: 0.001,
  ns: 0.000001,
}

export function parseDurationStringMs(value: string | null | undefined): number | null {
  if (!value) return null
  const trimmed = value.trim()
  if (!trimmed) return null

  let totalMs = 0
  let matchedAny = false
  let cursor = 0
  const re = new RegExp(DURATION_TOKEN_RE)
  let match: RegExpExecArray | null = re.exec(trimmed)
  while (match !== null) {
    // トークン間に不正な文字が挟まっている場合（例: "1x2s"）は全体を無効とみなす。
    if (match.index !== cursor) return null
    matchedAny = true
    const amount = Number(match[1])
    const unitMs = DURATION_UNIT_TO_MS[match[2]]
    totalMs += amount * unitMs
    cursor = re.lastIndex
    match = re.exec(trimmed)
  }
  // 末尾に余りがある（例: "1sabc"）場合も無効とみなす。
  if (!matchedAny || cursor !== trimmed.length) return null
  return Math.max(0, Math.round(totalMs))
}

/**
 * x-ratelimit-reset-requests / x-ratelimit-reset-tokens ヘッダから待機時間 (ms) を求める。
 * 両方存在する場合はより安全側（大きい方）を採用する。片方のみパース可能な場合はその値を使う。
 * どちらもパースできない場合は null を返し、呼出元は指数バックオフへフォールバックする。
 */
export function resolveRateLimitResetHeaderDelayMs(response: Response | TauriFetchResponse): number | null {
  const requestsMs = parseDurationStringMs(readResponseHeader(response, 'x-ratelimit-reset-requests'))
  const tokensMs = parseDurationStringMs(readResponseHeader(response, 'x-ratelimit-reset-tokens'))
  if (requestsMs === null && tokensMs === null) return null
  return Math.max(requestsMs ?? 0, tokensMs ?? 0)
}

/**
 * fetch のレスポンスからヘッダ値を取り出す。AiGatewayFetch は `Response`（ブラウザ経路。
 * headers は Headers インスタンスで .get() を持つ）と `TauriFetchResponse`（Tauri 経路。
 * headers は素の Record<string, string>）の両方を返しうるため、どちらの形でも
 * 大文字小文字を区別せず読み取れるようにする。
 */
export function readResponseHeader(response: Response | TauriFetchResponse, name: string): string | null {
  const headers = response.headers as Headers | Record<string, string>
  if (typeof (headers as Headers)?.get === 'function') {
    return (headers as Headers).get(name)
  }
  const record = headers as Record<string, string>
  const lowerName = name.toLowerCase()
  for (const key of Object.keys(record ?? {})) {
    if (key.toLowerCase() === lowerName) return record[key]
  }
  return null
}

/**
 * ms 待つ。ただし signal が abort されたら即座に resolve して待機を打ち切る
 * （中断要求が出ているのに待ち続けてはならないという要件を満たすため）。
 * chatText.ts 等の呼出元は、この関数から戻った直後に signal.aborted を確認し、
 * abort されていればリトライを続けず現在のエラー結果を返すこと（本関数自体は
 * reject しない＝abort をエラーとして伝播させない。gateway の「throw しない」契約を保つため）。
 */
export function delayRespectingAbort(ms: number, signal: AbortSignal | null | undefined): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  if (signal?.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * 待機時間の優先順位: Retry-After > x-ratelimit-reset-requests / x-ratelimit-reset-tokens >
 * 指数バックオフ + ジッタ。
 * Retry-After はサーバが明示的に指示する値なので最優先する。無ければ OpenAI 公式定義の
 * x-ratelimit-reset-* ヘッダ（"1s" "6m0s" のような duration 文字列。resolveRateLimitResetHeaderDelayMs
 * 参照）を使う。どちらも無い・パースできない場合のみ指数バックオフへフォールバックする。
 */
export function resolveRateLimitDelayMs(
  response: Response | TauriFetchResponse,
  attempt: number,
  random?: () => number,
): number {
  const retryAfterMs = parseRetryAfterMs(readResponseHeader(response, 'retry-after'))
  if (retryAfterMs !== null) return retryAfterMs
  const resetHeaderMs = resolveRateLimitResetHeaderDelayMs(response)
  if (resetHeaderMs !== null) return resetHeaderMs
  return computeBackoffDelayMs(attempt, random)
}
