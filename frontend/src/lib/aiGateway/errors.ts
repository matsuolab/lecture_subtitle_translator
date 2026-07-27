import type { AiGatewayContext } from './connection'
import { resolveApiCompatibilityProfile } from './apiCompatibilityProfile'

/**
 * HTTP エラー応答本文から「コンテキスト長超過」を検出する正規表現。
 * LM Studio / llama.cpp 系の典型的なエラー文言（"Context size has been exceeded" 等）を対象にする。
 * formatAiGatewayHttpError（表示用メッセージ組み立て）と classifyHttpErrorCode（errorCode 判定）の
 * 両方から参照する、判定基準の単一の情報源。
 */
const CONTEXT_SIZE_EXCEEDED_DETAIL_RE = /context size has been exceeded|context length|maximum context/i

/**
 * HTTP 400 + コンテキスト長超過を示す文言、の組み合わせを「コンテキスト長超過」として検出する。
 * status を条件に含めるのは、200番台や5xxのエラー文言に偶然 "context length" 等を含むケースを
 * 誤って context_exceeded 判定しないため（実機で確認した context_size_exceeded は常に HTTP 400
 * として返る。400 はサーバがリクエスト内容そのものを拒否したことを示すステータスであり、
 * 同一内容の再送では回復しない決定的エラーの根拠になる）。
 */
export function isContextSizeExceededHttpError(status: number, detail: string): boolean {
  return status === 400 && CONTEXT_SIZE_EXCEEDED_DETAIL_RE.test(detail)
}

/**
 * レート制限・サーバ過負荷を示す HTTP ステータス。
 * - 429 Too Many Requests: レート制限そのもの（本番事故の直接原因。gpt-5.4-mini +
 *   同時実行7で1053件中668件がこのステータスで失敗し、バックオフ無しで即2回送って
 *   両方弾かれ諦めていた）。
 * - 503 Service Unavailable: サーバ側の一時的な過負荷・メンテナンス。OpenAI 互換 API 実装
 *   （ローカル LLM サーバ含む）で過負荷時に返されることがある一般的なステータス。
 * - 529: Anthropic 系 API が過負荷時に返す実装依存のステータス（"Overloaded"）。
 *   標準の HTTP ステータスコードではないが、OpenAI 互換ではない上流 API を将来接続する
 *   ケースを見越して同じ分類に含める。
 * いずれも「今は無理だが、待ってから再送すれば成功する見込みが高い」一時的失敗という共通点が
 * あるため同一の errorCode に分類し、gateway 内のバックオフ付きリトライ（chatText.ts /
 * chatVision.ts / embeddings.ts 参照）の対象にする。400（context_exceeded）のような
 * 「入力を直さない限り回復しない」決定的エラーとは性質が異なるため区別する。
 */
const RATE_LIMITED_HTTP_STATUSES: ReadonlySet<number> = new Set([429, 503, 529])

export function isRateLimitedHttpStatus(status: number): boolean {
  return RATE_LIMITED_HTTP_STATUSES.has(status)
}

/**
 * OpenAI 公式仕様（https://developers.openai.com/api/docs/guides/error-codes）: HTTP 429 には
 * 意味の異なる2種類がある。
 * - 素の rate limit（レート制限）: 一時的な輻輳で、バックオフして再送すれば回復する見込みが高い。
 * - `insufficient_quota`（クォータ・残高・課金枠の枯渇）: `error.code` / `error.type` に
 *   `"insufficient_quota"` が入る。こちらは課金設定（支払い方法・利用枠）を直さない限り
 *   **絶対に回復しない**。同じ 429 ステータスでも意味が全く異なるため、バックオフリトライの
 *   対象にしてはならない（後述の classifyHttpErrorCode 参照。RATE_LIMIT_MAX_ATTEMPTS=6 回の
 *   バックオフを空費するのは、1呼出あたり最大 約1分の完全な無駄になる）。
 *
 * エラー本文の実例:
 *   {"error":{"message":"...","type":"insufficient_quota","code":"insufficient_quota"}}
 *
 * JSON パースに失敗した場合（プロバイダが非 JSON 本文を返す等）は、文字列検索へフォールバックする。
 */
const INSUFFICIENT_QUOTA_MARKER = 'insufficient_quota'

interface OpenAiStyleQuotaErrorBody {
  error?: {
    code?: string
    type?: string
  }
}

export function isInsufficientQuotaHttpError(status: number, detail: string): boolean {
  if (status !== 429) return false
  try {
    const parsed = JSON.parse(detail) as OpenAiStyleQuotaErrorBody
    return parsed.error?.code === INSUFFICIENT_QUOTA_MARKER || parsed.error?.type === INSUFFICIENT_QUOTA_MARKER
  } catch {
    // JSON パース失敗時のみ文字列検索にフォールバックする（構造化判定できない場合の最後の手段）。
    return detail.includes(INSUFFICIENT_QUOTA_MARKER)
  }
}

/**
 * HTTP エラー応答を LlmErrorCode の一部
 * （'context_exceeded' | 'rate_limited' | 'quota_exhausted' | 'http_error'）へ分類する。
 *
 * 'context_exceeded' は決定的エラー: 同一内容を再送しても絶対に回復しない
 * （プロンプト + max_tokens がコンテキスト長を超えている以上、入力を小さくしない限り
 * 何度リトライしても同じ 400 が返る）。呼出元（correct.ts / translateEn.ts / detectIncompleteEnds.ts）
 * はこのコードを「同一内容の盲リトライ禁止・入力を小さくして再試行」の分岐トリガーに使うこと。
 *
 * 'quota_exhausted' も決定的エラー: HTTP 429 のうち isInsufficientQuotaHttpError が真のもの。
 * 課金設定を直さない限り絶対に回復しないため、'context_exceeded' と同様に判定を最優先で行い、
 * 'rate_limited'（バックオフで回復する見込みがある一時的失敗）とは明確に区別する。
 * このコードは gateway 層（chatText.ts 等）のバックオフリトライループへは一切乗らない
 * （呼出元は 401/403/404 等の設定起因の致命エラーと同格に扱ってよい）。
 *
 * 'rate_limited' は一時的失敗: 待ってから再送すれば回復する見込みが高い（RATE_LIMITED_HTTP_STATUSES
 * 参照）。gateway 層（chatText.ts 等）がバックオフ付きで自動リトライし、リトライを尽くしても
 * 解消しない場合のみこのコードのまま呼出元へ返す。
 *
 * 判定をこの1箇所に集約し、chatText.ts / chatVision.ts / embeddings.ts のいずれからも
 * 同じ判定基準を再利用できるようにする（重複判定による分岐のズレを防ぐ）。
 */
export function classifyHttpErrorCode(status: number, detail: string): 'context_exceeded' | 'quota_exhausted' | 'rate_limited' | 'http_error' {
  if (isContextSizeExceededHttpError(status, detail)) return 'context_exceeded'
  if (isInsufficientQuotaHttpError(status, detail)) return 'quota_exhausted'
  if (isRateLimitedHttpStatus(status)) return 'rate_limited'
  return 'http_error'
}

/**
 * 字幕本文の `[UNTRANSLATED: ...]` マーカーや校正失敗理由など、ユーザーに見える／プロジェクト
 * ファイルとして共有されうる場所に埋め込む失敗理由を組み立てる共通ヘルパー。
 *
 * 本番事故の教訓: 以前は各呼出元が result.errorMessage（formatAiGatewayHttpError が組み立てる
 * `raw=` 付きの生のプロバイダ応答本文を含む自由文字列）をそのまま埋め込んでいたため、
 * 429 応答に含まれる組織ID等が字幕ファイルにそのまま漏洩していた。
 * このヘルパーは errorCode（+ 該当すれば httpStatus）だけから短い分類コードを組み立て、
 * プロバイダの生応答本文を一切含めない。呼出元（translateEn.ts / correct.ts /
 * documentGlossaryGenerator.ts）はマーカー・失敗理由を組み立てる際、必ずこの関数を経由すること。
 */
export function buildLlmFailureCode(args: { errorCode?: string; httpStatus?: number }): string {
  if (args.errorCode === 'http_error' && args.httpStatus) return `http_${args.httpStatus}`
  if (args.errorCode) return args.errorCode
  if (args.httpStatus) return `http_${args.httpStatus}`
  return 'unknown_error'
}

export function formatAiGatewayHttpError(args: {
  context: AiGatewayContext
  status: number
  detail: string
}): string {
  const raw = args.detail.slice(0, 200)
  if (isContextSizeExceededHttpError(args.status, args.detail)) {
    const profile = resolveApiCompatibilityProfile(args.context.settings)
    return [
      `http_${args.status}: context_size_exceeded`,
      `apiProfile=${profile.id}`,
      'LM Studio / local OpenAI-compatible server context length is too small for this request.',
      'Increase the loaded model context length, then rerun the pipeline.',
      `raw=${raw}`,
    ].join(' ')
  }
  return `http_${args.status}: ${raw}`
}
