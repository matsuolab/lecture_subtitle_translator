/**
 * パイプライン実行の中断シグナル（module-level）。
 *
 * 設計判断: llmUsageSink / llmActivity と同じ module-level パターンを採る。
 * 中断シグナルを引数で引き回すと、パイプラインの全ノード関数（translateEn /
 * detectIncompleteEnds / documentGlossaryGenerator / 各 repair agent 等）と
 * gateway までシグネチャ変更が波及する。一方このアプリは local desktop で
 * 1 パイプライン同時実行のみなので、module-level の current controller で十分安全。
 *
 * 運用ルール:
 *   - パイプライン orchestrator は実行開始時に setCurrentPipelineAbortController(controller) する
 *   - **終了時（成功・失敗・中断すべて）に finally で必ず null に戻す**
 *     戻し忘れると次回実行が開始直後に中断され、アプリが実行不能になる
 *   - 各ノードは処理の切れ目で throwIfPipelineAborted() を呼ぶ
 *
 * キャンセルの性質: 協調的キャンセルであり、飛んでいる HTTP リクエストを
 * 即座に切るものではない。「新しい処理を始めない」ことで停止させる。
 * ブラウザ経路では signal がリクエストにも渡るので接続が切れるが、
 * Tauri 経路では signal が無視される（tauriFetch のコメント参照。Rust 側に
 * あるのはタイムアウトであってキャンセルではない）。
 */

/** 中断によって処理を打ち切ったことを示すエラー。失敗ではないので error 扱いしない */
export class PipelineAbortedError extends Error {
  constructor(message = 'pipeline_aborted_by_user') {
    super(message)
    this.name = 'PipelineAbortedError'
  }
}

let currentController: AbortController | null = null

export function setCurrentPipelineAbortController(controller: AbortController | null): void {
  currentController = controller
}

export function getCurrentPipelineAbortSignal(): AbortSignal | null {
  return currentController?.signal ?? null
}

export function isPipelineAborted(): boolean {
  return currentController?.signal.aborted ?? false
}

/**
 * 中断済みなら PipelineAbortedError を投げる。
 * ノードの開始前・次バッチの開始前など、処理の切れ目で呼ぶ。
 */
export function throwIfPipelineAborted(): void {
  if (isPipelineAborted()) throw new PipelineAbortedError()
}

export function isPipelineAbortedError(error: unknown): boolean {
  return error instanceof PipelineAbortedError
}

/**
 * 現在実行中のパイプラインに中断を要求する。
 * 実行中でなければ何もしない（false を返す）。
 */
export function abortCurrentPipeline(): boolean {
  if (!currentController || currentController.signal.aborted) return false
  currentController.abort()
  return true
}
