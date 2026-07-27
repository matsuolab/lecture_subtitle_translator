import { getLlmActivitySnapshot } from '@/lib/aiGateway/llmActivity'
import { throwIfPipelineAborted } from './pipelineAbort'

/**
 * runNodeWithHeartbeat のハートビート間隔。ノード開始時にしか進捗が出ないと、「時間のかかる段階を
 * 正常に処理中」なのか「本当にフリーズしている」のか UI 側で判断できない
 * （本番で contextGroupCueBlocks が42分かかった際に区別できなかった実例あり）。
 * 15秒はポーリング頻度として UI 更新には十分短く、かつログを埋め尽くさない程度に長い値として選定。
 */
export const HEARTBEAT_INTERVAL_MS = 15_000

export interface LocalPipelineProgressDetail {
  /** 現在のノードの経過秒数 */
  elapsedSec: number
  /** 応答待ちの LLM リクエスト数 */
  inFlightLlmCalls: number
  /** 直近に LLM 応答が返ってからの経過秒数。まだ1件も返っていなければ null */
  secondsSinceLastLlmResponse: number | null
}

/**
 * ノード実行中、HEARTBEAT_INTERVAL_MS ごとに進捗（経過秒数・LLM 呼出アクティビティ）を
 * onStep で通知しながら run() を実行する。
 *
 * localPipeline.ts の runNode から「タイマー管理」だけを切り出したもの。record / stageSnapshot
 * 等のトレース記録責務とは分離することで、フェイクタイマーを使った単体テストをしやすくしている。
 *
 * ノード完了後にタイマーが残ると誤情報を出し続けるため、finally で必ず clearInterval する
 * （このタイマーリークが今回のバグ再発の最有力候補のため、変更時は特に注意すること）。
 */
export async function runNodeWithHeartbeat<T>(
  nodeId: string,
  run: () => Promise<T> | T,
  onStep?: (step: string, detail?: LocalPipelineProgressDetail) => void,
): Promise<T> {
  // 協調的キャンセルの検知点。中断済みなら次のノードを始めない。
  throwIfPipelineAborted()
  onStep?.(nodeId)
  const startedAt = Date.now()

  const heartbeat = setInterval(() => {
    const snapshot = getLlmActivitySnapshot()
    onStep?.(nodeId, {
      elapsedSec: Math.round((Date.now() - startedAt) / 1000),
      inFlightLlmCalls: snapshot.inFlight,
      secondsSinceLastLlmResponse: snapshot.lastCompletedAt === null
        ? null
        : Math.round((Date.now() - snapshot.lastCompletedAt) / 1000),
    })
  }, HEARTBEAT_INTERVAL_MS)

  try {
    return await run()
  } finally {
    clearInterval(heartbeat)
  }
}
