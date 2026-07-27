/**
 * OpenAI 互換 API がモデル単位で特定のリクエストパラメータ（temperature 等のサンプリング系）を
 * HTTP 400 で拒否するケースに、決め打ちのハードコードではなく**実行中の学習**で適応するための
 * module-level 状態。
 *
 * 背景（重要な注意）: 推論系モデルが temperature 等の非既定値を 400 で拒否する、という仮説は
 * 実データで確認できていない未検証の仮説である。ユーザーのグローバル規約により「LLMモデルの
 * 仕様に関する自己の知識を信用してコードを断定的に変えること」は禁止されている。そのため
 * 「特定モデル名だから temperature を送らない」という決め打ちは一切行わない。代わりに、
 * サーバが実際に「このパラメータは非対応」と 400 で答えたときにだけ、そのパラメータを
 * その baseUrl+model の組み合わせについて以後送らないよう学習する。これならどのプロバイダ・
 * どのモデルでも正しく動作し、上記の仮説が外れていても（＝実際には無関係な理由で 400 が
 * 返っていても）誤ってパラメータを除去することはない（許可リスト + エラーコード判定の両方が
 * 一致した場合のみ学習するため）。
 *
 * 設計理由（llmActivity.ts / llmConcurrency.ts と同じ判断）:
 *   - 各呼出ヘルパーに学習状態を引数で引き回すとシグネチャ変更が広範囲に及ぶため、
 *     module-level の器で完結させる。
 *   - このアプリは local desktop で 1 パイプライン同時実行のみなので、module-level で十分安全。
 *
 * 運用ルール:
 *   - パイプライン orchestrator は実行開始時に resetParamCompat() を呼ぶ
 *     （src/api/pipelineClient.ts の runPipelineViaApi 参照。前回実行の学習結果を持ち越さない。
 *     モデル設定やプロバイダ設定が変わりうるため、実行を跨いで学習結果を保持しない）
 *   - gateway 層（chatText.ts / chatVision.ts）はリクエスト構築時に
 *     stripLearnedUnsupportedParams() で学習済みパラメータを事前に除去する
 *   - HTTP 400 応答を受けたら learnUnsupportedParam() で学習を試み、成立すれば当該パラメータを
 *     外して同一リクエストを1回だけ即時再試行する（レート制限のバックオフとは別枠。
 *     決定的エラーなので待機は不要）
 */

/**
 * 除去してよいパラメータの許可リスト。サンプリング系のみに限定する。
 * `model` や `messages` のような必須フィールドは対象外にする（誤検知でリクエストが
 * 壊れる、あるいはサーバが 400 の理由として無関係な必須フィールド名を message に含めていた
 * 場合に誤って必須フィールドを消してしまう事故を防ぐため）。
 */
const REMOVABLE_SAMPLING_PARAMS: ReadonlySet<string> = new Set([
  'temperature',
  'top_p',
  'presence_penalty',
  'frequency_penalty',
])

/**
 * OpenAI 形式のエラー本文で「このパラメータの値が非対応」を示す error.code の値。
 * この2つ以外（invalid_request_error 全般等）は温度非対応のような値レベルの拒否とは限らない
 * ため学習対象にしない（誤検知防止）。
 */
const UNSUPPORTED_PARAM_ERROR_CODES: ReadonlySet<string> = new Set([
  'unsupported_value',
  'unsupported_parameter',
])

interface OpenAiStyleErrorBody {
  error?: {
    message?: string
    param?: string
    code?: string
  }
}

function buildKey(baseUrl: string, model: string): string {
  return `${baseUrl}|${model}`
}

/** baseUrl + model 単位で「送らないと学習したパラメータ名」の集合を保持する。 */
let unsupportedParamsByKey: Map<string, Set<string>> = new Map()

export function getLearnedUnsupportedParams(baseUrl: string, model: string): ReadonlySet<string> {
  return unsupportedParamsByKey.get(buildKey(baseUrl, model)) ?? new Set()
}

/**
 * リクエスト構築時に、これまで学習済みの非対応パラメータを事前に取り除く。
 * 学習が無ければ body をそのまま返す（新規オブジェクトを作らない最小限の変更）。
 */
export function stripLearnedUnsupportedParams<T extends Record<string, unknown>>(
  baseUrl: string,
  model: string,
  body: T,
): T {
  const learned = getLearnedUnsupportedParams(baseUrl, model)
  if (learned.size === 0) return body
  const next = { ...body }
  for (const param of learned) {
    delete next[param]
  }
  return next
}

/**
 * HTTP 400 応答本文から「除去可能な非対応パラメータ」を検出する。
 * 許可リスト外のパラメータ（`model` 等）は検出対象にしない。
 * error.param が無い場合は error.message からの正規表現フォールバックで抽出を試みる
 * （プロバイダによっては param フィールドを返さず message 文中にのみパラメータ名を含めることがある）。
 */
export function detectUnsupportedParam(detail: string): string | null {
  let parsed: OpenAiStyleErrorBody
  try {
    parsed = JSON.parse(detail) as OpenAiStyleErrorBody
  } catch {
    return null
  }
  const error = parsed.error
  if (!error?.code || !UNSUPPORTED_PARAM_ERROR_CODES.has(error.code)) return null

  if (error.param && REMOVABLE_SAMPLING_PARAMS.has(error.param)) return error.param

  if (error.message) {
    for (const candidate of REMOVABLE_SAMPLING_PARAMS) {
      if (new RegExp(`\\b${candidate}\\b`).test(error.message)) return candidate
    }
  }
  return null
}

/**
 * HTTP 400 応答から非対応パラメータを学習し、以後同一 baseUrl+model の組み合わせの
 * リクエストから除去されるようにする。学習が成立した場合はそのパラメータ名を返す
 * （呼出元はこれを使って同一リクエストから即座に除去し、1回だけ再試行する）。
 * 学習が成立しなければ null を返す（呼出元は通常どおり http_error として扱う）。
 */
export function learnUnsupportedParam(baseUrl: string, model: string, detail: string): string | null {
  const param = detectUnsupportedParam(detail)
  if (!param) return null
  const key = buildKey(baseUrl, model)
  const existing = unsupportedParamsByKey.get(key) ?? new Set<string>()
  existing.add(param)
  unsupportedParamsByKey.set(key, existing)
  return param
}

/**
 * テスト・パイプライン開始時のリセット用。前回実行の学習結果が残らないようにする。
 */
export function resetParamCompat(): void {
  unsupportedParamsByKey = new Map()
}
