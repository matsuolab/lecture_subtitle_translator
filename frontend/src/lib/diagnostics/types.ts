export const DIAGNOSTIC_LOG_SCHEMA_VERSION = 1

/** 診断ログのファイル拡張子（1行1イベントの JSON Lines） */
export const DIAGNOSTIC_LOG_FILE_EXT = '.jsonl'

/**
 * WorkLog（編集履歴）とは別に、アプリ起動〜終了を通しで記録する診断用イベント。
 * ユーザー環境固有の不具合（localStorage異常・メインスレッド閉塞）を後から
 * 一次情報として追えるようにするためのもの。字幕編集セッションの有無に関わらず記録する。
 */
export type DiagnosticEventType =
  | 'console_error'
  | 'console_warn'
  | 'unhandled_error'
  | 'unhandled_rejection'
  | 'storage_error'
  | 'long_task'

export interface DiagnosticHeader {
  kind: 'header'
  schemaVersion: number
  runId: string
  startedAt: string
  appVersion?: string
  platform?: string
}

export interface DiagnosticEvent {
  kind: 'event'
  at: string
  type: DiagnosticEventType
  message: string
  detail?: Record<string, unknown>
}

export type DiagnosticLogLine = DiagnosticHeader | DiagnosticEvent
