import type { AiConnection } from '@/lib/pipeline/aiProvider'
import type { AiGatewayContext } from './connection'
import { requireGatewayConnection } from './connection'
import { BUILTIN_API_COMPATIBILITY_PROFILES, resolveApiCompatibilityProfile } from './apiCompatibilityProfile'

/**
 * LM Studio の拡張 REST API（`/api/v0/models`）から、実行時に実際にロードされているコンテキスト長
 * （loaded_context_length）を取得する。
 *
 * 背景（実機検証で確定済み。詳細は modelProfile.ts の CONSERVATIVE_CONTEXT_LENGTH_CEILING_TOKENS
 * の JSDoc も参照）:
 *   - LM Studio は `/v1/chat/completions` へのリクエストに `context_length` を含めても無視する
 *     （8192 を指定しても 16384 を指定しても JIT ロード既定値の 8192 のまま追従しないことを
 *     対照実験で確認済み）。
 *   - JIT ロード時のコンテキスト長の既定値は 8192。ユーザーが `lms load -c 32768` 等で
 *     明示的に大きいコンテキストでロードしていても、モデルプロファイルの contextLength 宣言値
 *     （カタログ上の理論最大。例: gemma プリセットは 128000）だけを見ていては検知できない。
 *   - そのため実際のコンテキスト長は、この拡張エンドポイントから実行時に取得するしかない。
 *
 * レスポンス形式（実機で確認済み）:
 *   `{ data: [ { id, state: 'loaded' | 'not-loaded', loaded_context_length, max_context_length, ... } ] }`
 *
 * 取得できない場合（OpenAI / Gemini 等 `/api/v0` を持たない提供元、ネットワーク失敗・タイムアウト、
 * 対象モデルが `not-loaded`、レスポンス形式が想定外など）は例外を投げず undefined を返す。
 * 呼出元（modelProfile.ts のクランプ計算）は undefined を「フォールバック値
 * (CONSERVATIVE_CONTEXT_LENGTH_CEILING_TOKENS) を使う」の意味として扱うこと。
 *
 * パイプライン1回の実行中に同じモデルへ何度も叩かないよう、モデル単位（baseUrl + model）で
 * 結果をキャッシュする（進行中の Promise 自体をキャッシュするため、同時に複数呼ばれても
 * fetch は1回だけになる）。パイプライン開始時に resetLmStudioContextLengthCache() でクリアすること
 * （llmConcurrency.ts / llmActivity.ts と同じ module-level state のリセット運用に倣う）。
 */

interface LmStudioModelsApiEntry {
  id?: unknown
  state?: unknown
  loaded_context_length?: unknown
}

interface LmStudioModelsApiResponse {
  data?: unknown
}

const cache = new Map<string, Promise<number | undefined>>()

/**
 * baseUrl（例: `http://127.0.0.1:1234/v1`）から LM Studio 拡張 API のオリジン
 * （`/v1` を含まないオリジン直下）を導く。`/api/v0/models` は `/v1` パスの外側にある。
 */
function toApiV0Origin(baseUrl: string): string {
  return baseUrl.replace(/\/v1\/?$/, '')
}

/**
 * 「LM Studio 系プロファイルか」の判定。Ollama 等 `/api/v0/models` を持たない実装まで
 * 巻き込んで無駄な失敗リクエストを送らないよう、確認済みの LM Studio プロファイルに限定する。
 */
function isLmStudioProfile(context: AiGatewayContext): boolean {
  try {
    return resolveApiCompatibilityProfile(context.settings).id === BUILTIN_API_COMPATIBILITY_PROFILES.lmStudio.id
  } catch {
    return false
  }
}

async function fetchLoadedContextLength(
  context: AiGatewayContext,
  connection: AiConnection,
  model: string,
): Promise<number | undefined> {
  const response = await context.fetch(`${toApiV0Origin(connection.baseUrl)}/api/v0/models`, {
    headers: connection.apiKey ? { Authorization: `Bearer ${connection.apiKey}` } : {},
    timeoutMs: context.settings.llmRequestTimeoutSec * 1000,
  })
  if (!response.ok) return undefined

  const payload = await response.json() as LmStudioModelsApiResponse
  const entries = Array.isArray(payload.data) ? payload.data as LmStudioModelsApiEntry[] : []
  const entry = entries.find((item) => typeof item.id === 'string' && item.id === model)
  if (!entry || entry.state !== 'loaded') return undefined

  const loaded = entry.loaded_context_length
  if (typeof loaded !== 'number' || !Number.isFinite(loaded) || loaded <= 0) return undefined
  return Math.trunc(loaded)
}

/**
 * 実行時に実際にロードされているコンテキスト長を取得する。
 * LM Studio 系プロファイル以外・接続情報が解決できない場合は即座に undefined を返す
 * （余計なネットワーク呼出をしない）。取得失敗（ネットワーク・タイムアウト・不正レスポンス等）も
 * 例外を投げず undefined に丸める。
 */
export function resolveLmStudioLoadedContextLength(
  context: AiGatewayContext,
  model: string,
): Promise<number | undefined> {
  if (!model.trim() || !isLmStudioProfile(context)) return Promise.resolve(undefined)

  let connection: AiConnection
  try {
    connection = requireGatewayConnection(context, 'lmStudioContextLength')
  } catch {
    return Promise.resolve(undefined)
  }

  const cacheKey = `${connection.baseUrl}::${model}`
  const cached = cache.get(cacheKey)
  if (cached) return cached

  // 取得失敗で例外を投げない: ネットワーク失敗・タイムアウト・非対応エンドポイント・
  // 不正なレスポンス形式等はすべて undefined（＝呼出元がフォールバック値を使う）に丸める。
  const promise = fetchLoadedContextLength(context, connection, model).catch(() => undefined)
  cache.set(cacheKey, promise)
  return promise
}

/**
 * テスト・パイプライン開始時のリセット用。前回実行のキャッシュが残らないようにする
 * （llmConcurrency.ts の resetLlmConcurrency() / llmActivity.ts の resetLlmActivity() と同じ運用）。
 */
export function resetLmStudioContextLengthCache(): void {
  cache.clear()
}
