/**
 * fetch (tauriFetch) が投げた例外がタイムアウト由来かどうかを判定する共通ヘルパー。
 *
 * 判定対象:
 *   - ブラウザ経路: AbortSignal.timeout() が発火して fetch が reject した DOMException
 *     （実装によって name は 'TimeoutError' または 'AbortError' になる）
 *   - Tauri経路: src-tauri/src/lib.rs の http_request コマンドが reqwest の
 *     is_timeout() を検知して返す専用メッセージ
 *     （`HTTP request to {url} timed out after {ms}ms` 形式。他のネットワークエラーとは
 *     文字列を分けているため、ここでパターンマッチできる）
 *
 * errorCode==='timeout' はリトライ対象の一時的失敗として扱われる（fetch_failed と同様）。
 * 呼出元 (chatText.ts / chatVision.ts) がここで判定した結果を errorCode に反映する。
 */
const RUST_TIMEOUT_MESSAGE_PATTERN = /timed out after \d+ms/

export function isTimeoutError(err: unknown): boolean {
  if (err instanceof DOMException) {
    return err.name === 'TimeoutError' || err.name === 'AbortError'
  }
  if (err instanceof Error) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') return true
    return RUST_TIMEOUT_MESSAGE_PATTERN.test(err.message)
  }
  return typeof err === 'string' && RUST_TIMEOUT_MESSAGE_PATTERN.test(err)
}
