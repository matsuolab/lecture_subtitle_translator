/**
 * LLM 呼出（chatText / chatVision / embeddings）全体の同時実行数を上限で抑える module-level
 * セマフォ。
 *
 * 背景: 各パイプラインノードは `mapWithConcurrency(n, concurrency, ...)` でノード単体の並列度を
 * 守っているが、その内側で再帰的に追加の LLM 呼出が発生するケースがある
 * （`detectIncompleteEnds.ts` の processBatch は truncated 時に左右半分へ再帰、
 * `translateEn.ts` の translateBatchWithFallback も同様）。この再帰は各ノードの並列枠の外側で
 * 発生するため、設定上の並列度（例: 7）を守っているつもりでも実際の同時リクエスト数が
 * 3〜4倍に膨れ上がる（実測で「API応答待ち 20〜24件」）。
 *
 * ローカル LLM サーバ（LM Studio 等）は並列スロット数だけ KV キャッシュ（コンテキスト）を
 * 分割するため、同時リクエストが増えるほど 1 リクエストあたりの使えるコンテキストが小さくなり、
 * context_size_exceeded や過負荷による 5xx を引き起こす。各ノードのローカルな並列制御とは別に、
 * gateway 層（chatText / chatVision / embeddings の fetch 呼出そのもの）で全体の同時実行数を
 * 一元的に絞ることで、ノード側の再帰構造に関わらず実際の同時リクエスト数を設定値以下に保つ。
 *
 * 設計理由（`llmActivity.ts` / `llmUsageSink.ts` と同じ判断）:
 *   - 各呼出ヘルパー・各ノードにセマフォを引数で引き回すと、chatText / chatVision /
 *     embeddings とその呼出元すべてのシグネチャ変更が必要になり、テスト・将来の拡張が重くなる。
 *   - このアプリは local desktop で 1 パイプライン同時実行のみ（React app の特性）なので、
 *     module-level のカウンタ・キューで十分安全に運用できる。
 *
 * 運用ルール:
 *   - パイプライン orchestrator は実行開始時に setLlmConcurrencyLimit(settings.apiRequestConcurrency)
 *     を呼ぶ（src/api/pipelineClient.ts の runPipelineViaApi 参照）
 *   - 実行終了時（成功・失敗を問わず finally）に resetLlmConcurrency() で必ずクリアする
 *     （戻し忘れると次回実行に前回の上限が残る、または待機中の Promise が残留する）
 *   - 各 gateway 呼出ヘルパーは fetch 呼出全体を acquireLlmSlot() で確保した区間に収め、
 *     **必ず try/finally で解放する**（解放漏れはスロットが永久に空かず全体がデッドロックする
 *     最も危険な事故に直結する）
 *
 * デッドロック安全性についての設計上の保証:
 *   acquireLlmSlot() はこのファイル内で完結する待機であり、他のリソースを保持したまま
 *   待つことはない。gateway 呼出ヘルパー（chatText / chatVision / embeddings）はスロットを
 *   確保してから fetch を行い、レスポンス確定（成功・エラー・例外いずれか）を待たずに
 *   スロットを解放することはない一方、**スロットを保持したまま別の LLM 呼出（＝別の
 *   acquireLlmSlot() 待機）を挟むことも一切ない**（gateway 呼出ヘルパーは末端の HTTP 呼出のみを
 *   行い、他の gateway 呼出を内部で待たない）。呼出元（detectIncompleteEnds.ts /
 *   translateEn.ts 等）の再帰・並列処理はすべて gateway 呼出の「外側」で行われるため、
 *   スロット保持中に別スロットの獲得を待つ循環待機は構造的に発生しない。
 */
export interface LlmConcurrencyState {
  /**
   * 現在「実際に適用されている」同時実行数上限。0 以下は「制限なし」を意味する。
   * レート制限検知で動的に下げた場合はその値がここに反映される（= 実効上限の観測用途を兼ねる。
   * setLlmConcurrencyLimit で設定した本来の値は configuredLimit として内部にのみ保持する）。
   */
  limit: number
  /** 現在実行中（スロット確保済み）の件数 */
  active: number
  /** スロット確保待ちで並んでいる件数 */
  queued: number
  /**
   * 直近にレート制限を検知した時刻 (epoch ms)。1度も検知していなければ null。
   * 時間ベースの回復判定（TIME_BASED_RECOVERY_COOLDOWN_MS 参照）の観測用途。
   */
  lastRateLimitAt: number | null
}

/** setLlmConcurrencyLimit で設定された「本来の」上限。回復時にこの値まで戻す目標値として使う。 */
let configuredLimit = 0
/**
 * 現在実際に適用されている上限（実効上限）。通常は configuredLimit と同じだが、
 * レート制限（429 等）を検知すると一時的にこれより低い値へ下げる。
 */
let limit = 0
let active = 0
const queue: Array<() => void> = []

/**
 * レート制限からの回復判定用カウンタ。reportLlmRateLimitEncountered() でリセットされ、
 * reportLlmCallSucceeded() が呼ばれるたびに増える。RECOVERY_SUCCESS_STREAK に達したら
 * 実効上限を1段階戻す。
 */
let consecutiveSuccessesSinceThrottle = 0

/**
 * 実効上限を1段階戻すために必要な連続成功回数。
 * 小さすぎると、レート制限の原因（サーバ側の輻輳）がまだ解消していないうちに上限を戻して
 * しまい 429 を再発させる。かといって大きすぎると回復が遅く、いつまでも低速なままになる。
 * 「体感で数秒〜十数秒以内には次の成功が積み上がる」実運用のリクエスト間隔を踏まえ、
 * 5 回を初期値として採用する（固定値の根拠が薄いため、実運用で調整の余地を残す）。
 */
const RECOVERY_SUCCESS_STREAK = 5

/**
 * レート制限検知時に下げる下限。0 まで下げると「無制限」の意味に反転してしまうため、
 * 常に 1 以上を維持する（1 なら直列実行になるだけで、リクエストが完全に止まることはない）。
 */
const MIN_EFFECTIVE_LIMIT = 1

/**
 * 直近のレート制限検知時刻 (epoch ms)。reportLlmRateLimitEncountered() で更新される。
 * 一度もレート制限を検知していなければ null。時間ベースの回復判定（下記
 * TIME_BASED_RECOVERY_COOLDOWN_MS 参照）に使う。
 */
let lastRateLimitAt: number | null = null

/**
 * 「輻輳はもう終わっている」とみなし、成功1回ごとに1段階ずつ即座に回復させるための
 * 経過時間しきい値 (ms)。
 *
 * 背景（本番事故の実測）: RECOVERY_SUCCESS_STREAK（連続成功5回）方式は、失敗が疎らに混ざり
 * 続ける状況（実測: gpt-5.4-mini + 同時実行7 で translateEn 実行中の同時実行数が平均0.7・
 * 最大1のまま張り付いた）では「5連続成功」が永久に成立せず、実効上限が下限の 1 に貼り付いた
 * ままになってしまう。ストリーク条件は「輻輳が続いている最中の慎重な回復」には有効だが、
 * 輻輳が実際にはとっくに解消しているケースまで過度に足を引っ張る。
 *
 * そこで、最後にレート制限を検知してから一定時間が経過していれば「輻輳はもう解消している」と
 * みなし、ストリーク条件を待たず成功1回ごとに1段階戻す経路を別に設ける。15秒という値の根拠:
 * 実運用のレート制限バックオフ（rateLimitRetry.ts）は数秒〜十数秒オーダーで再送されるため、
 * 「レート制限が実際に続いているなら 15 秒以内に次の失敗が起きるはず」という経験則を基準にした
 * （固定値の根拠が薄いため、実運用で調整の余地を残す。RECOVERY_SUCCESS_STREAK と同様）。
 */
const TIME_BASED_RECOVERY_COOLDOWN_MS = 15_000

/**
 * 同時実行数の上限を設定する。パイプライン開始時に settings.apiRequestConcurrency で設定する。
 * 0 以下を渡すと「制限なし」になる（既存テスト・単体実行を壊さないためのデフォルト）。
 * 上限を緩めた場合、待機中のリクエストがあれば即座に進められる分だけ進める。
 * 実効上限（limit）もここで configuredLimit と同じ値にリセットする
 * （新しいパイプライン実行の開始時に前回のレート制限による絞り込みを持ち越さないため）。
 */
export function setLlmConcurrencyLimit(newLimit: number): void {
  configuredLimit = Number.isFinite(newLimit) ? Math.max(0, Math.trunc(newLimit)) : 0
  limit = configuredLimit
  consecutiveSuccessesSinceThrottle = 0
  lastRateLimitAt = null
  drainQueue()
}

/**
 * レート制限（429 等）を検知した gateway 呼出ヘルパーが呼ぶ。実効上限を半減させる
 * （下限 MIN_EFFECTIVE_LIMIT）ことで、以後の acquireLlmSlot() が同時に走らせる本数を絞り、
 * 同じ 429 をすぐに再発させないようにする。
 * configuredLimit が「制限なし」(0以下) の場合は動的な絞り込みも行わない
 * （テスト・単体実行のような無制限運用の挙動を変えないため）。
 */
export function reportLlmRateLimitEncountered(): void {
  if (configuredLimit <= 0) return
  limit = Math.max(MIN_EFFECTIVE_LIMIT, Math.floor(limit / 2))
  consecutiveSuccessesSinceThrottle = 0
  lastRateLimitAt = Date.now()
}

/**
 * gateway 呼出が成功した（HTTP レスポンスが ok だった）ときに呼ぶ。実効上限が configuredLimit
 * まで絞り込まれている間だけ意味を持つ（絞り込まれていなければ何もしない）。
 *
 * 回復には2つの経路がある:
 *   1. 時間ベース回復: 最後にレート制限を検知してから TIME_BASED_RECOVERY_COOLDOWN_MS 以上
 *      経過していれば「輻輳はもう解消している」とみなし、成功1回ごとに即座に1段階戻す。
 *      失敗が疎らに混ざり続け「連続成功」が積み上がらない状況（本番実測: translateEn 実行中の
 *      同時実行数が平均0.7・最大1のまま張り付いた）でも回復できるようにするための経路
 *      （TIME_BASED_RECOVERY_COOLDOWN_MS の JSDoc 参照）。
 *   2. ストリークベース回復: cooldown 未経過（＝直近まで輻輳していた可能性が高い）場合は、
 *      従来どおり RECOVERY_SUCCESS_STREAK 回の連続成功を要求してから1段階だけ戻す
 *      （輻輳の原因が完全に解消していない状態でいきなり全開に戻すと再び 429 を招きやすいため）。
 * いずれの経路も一度に configuredLimit まで戻さず、1段階ずつ戻す。
 */
export function reportLlmCallSucceeded(): void {
  if (configuredLimit <= 0) return
  if (limit >= configuredLimit) return

  const cooledDown = lastRateLimitAt !== null && (Date.now() - lastRateLimitAt) >= TIME_BASED_RECOVERY_COOLDOWN_MS
  if (cooledDown) {
    limit = Math.min(configuredLimit, limit + 1)
    consecutiveSuccessesSinceThrottle = 0
    drainQueue()
    return
  }

  consecutiveSuccessesSinceThrottle += 1
  if (consecutiveSuccessesSinceThrottle >= RECOVERY_SUCCESS_STREAK) {
    limit = Math.min(configuredLimit, limit + 1)
    consecutiveSuccessesSinceThrottle = 0
    drainQueue()
  }
}

/**
 * スロットを確保する。上限に達していれば空くまで待つ。解放用の関数を返す。
 * 呼出元は必ず try/finally で解放関数を呼ぶこと（解放漏れは他の全呼出をブロックし続ける
 * デッドロックに直結する）。返された解放関数は複数回呼ばれても二重に解放しない。
 */
export function acquireLlmSlot(): Promise<() => void> {
  return new Promise((resolve) => {
    const grant = () => {
      active += 1
      resolve(createReleaser())
    }
    if (limit <= 0 || active < limit) {
      grant()
    } else {
      queue.push(grant)
    }
  })
}

function createReleaser(): () => void {
  let released = false
  return () => {
    if (released) return
    released = true
    active = Math.max(0, active - 1)
    drainQueue()
  }
}

function drainQueue(): void {
  while ((limit <= 0 || active < limit) && queue.length > 0) {
    const grant = queue.shift()
    if (grant) grant()
  }
}

export function getLlmConcurrencyState(): LlmConcurrencyState {
  return { limit, active, queued: queue.length, lastRateLimitAt }
}

/**
 * テスト・パイプライン開始/終了時のリセット用。前回実行の上限・待機列が残らないようにする。
 * 待機中の Promise を放置すると次回実行の判定に混入するため、キューも明示的に空にする。
 */
export function resetLlmConcurrency(): void {
  configuredLimit = 0
  limit = 0
  active = 0
  queue.length = 0
  consecutiveSuccessesSinceThrottle = 0
  lastRateLimitAt = null
}
