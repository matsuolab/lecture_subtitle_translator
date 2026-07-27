/**
 * LLM 呼出（chatText / chatVision / embeddings）の実行中アクティビティを追跡する module-level state。
 *
 * 設計理由（`src/lib/pipeline/llmUsageSink.ts` の module-level current sink と同じ判断）:
 *   - 各呼出ヘルパーに「現在何件 in-flight か」を引数で引き回すと、chatText / chatVision /
 *     embeddings とその呼出元すべてのシグネチャ変更が必要になり、テスト・将来の拡張が重くなる。
 *   - 一方でこのアプリは local desktop で 1 パイプライン同時実行のみ（React app の特性）なので、
 *     module-level のカウンタで十分安全に運用できる。
 *
 * 用途: `src/lib/pipeline/localPipeline.ts` の runNode がハートビートで「今何件 API 応答待ちか」
 * 「最後の応答から何秒経ったか」を出すための情報源。ノード開始時にしか進捗ログが出ず、
 * 「時間のかかる段階を正常に処理中」なのか「本当にフリーズしている」のか区別できない問題を
 * 解消するために追加した。
 */
export interface LlmActivitySnapshot {
  /** 現在応答待ちの LLM リクエスト数 */
  inFlight: number
  /** 直近にレスポンスが返った時刻 (epoch ms)。1件も返っていなければ null */
  lastCompletedAt: number | null
  /** 累計開始数 */
  totalStarted: number
  /** 累計完了数（成功・失敗を問わずレスポンスが返った、またはエラーで終わった数） */
  totalCompleted: number
}

let inFlight = 0
let lastCompletedAt: number | null = null
let totalStarted = 0
let totalCompleted = 0

/**
 * LLM 呼出の開始を記録し、完了時に呼ぶ関数を返す。
 *
 * 呼出元は必ず try/finally で終了関数を呼ぶこと（例外・タイムアウト・HTTPエラーのどの経路でも
 * 呼ばれないと inFlight が減らず、フリーズ判定が誤動作する）。返された終了関数は複数回呼ばれても
 * 二重にカウントを減らさない。
 */
export function beginLlmCall(): () => void {
  inFlight += 1
  totalStarted += 1
  let ended = false
  return () => {
    if (ended) return
    ended = true
    inFlight = Math.max(0, inFlight - 1)
    totalCompleted += 1
    lastCompletedAt = Date.now()
  }
}

export function getLlmActivitySnapshot(): LlmActivitySnapshot {
  return { inFlight, lastCompletedAt, totalStarted, totalCompleted }
}

/**
 * テスト・パイプライン開始時のリセット用。前回実行のカウントが残らないようにする。
 */
export function resetLlmActivity(): void {
  inFlight = 0
  lastCompletedAt = null
  totalStarted = 0
  totalCompleted = 0
}
