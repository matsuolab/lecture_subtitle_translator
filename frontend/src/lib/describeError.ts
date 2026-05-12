/**
 * 任意の値からユーザーに見せられる短い説明文字列を取り出す。
 *
 * `err instanceof Error ? err.message : '不明なエラー'` だと、
 * Tauri invoke が Rust 側 `Err(String)` で reject したケースや、
 * AWS SDK 等が独自オブジェクトを throw したケースで情報が完全に失われる。
 * テスター（非エンジニア）にスクショで原因報告してもらう前提なので、
 * できる限り正体不明値の中身を残すことを優先する。
 */
export function describeError(err: unknown): string {
  if (err instanceof Error) {
    return err.message || err.name || 'Error (no message)'
  }
  if (typeof err === 'string') {
    return err || 'Empty error string'
  }
  if (err === null) return 'null'
  if (err === undefined) return 'undefined'
  if (typeof err === 'object') {
    // よくある形: { message, code, name, status, $metadata } など
    const obj = err as Record<string, unknown>
    const candidates = [obj.message, obj.error, obj.reason, obj.code, obj.name]
    const firstString = candidates.find(v => typeof v === 'string' && v.length > 0)
    if (typeof firstString === 'string') return firstString
    try {
      const json = JSON.stringify(err)
      if (json && json !== '{}') return json
    } catch {
      // 循環参照などで JSON.stringify が失敗
    }
    return Object.prototype.toString.call(err)
  }
  return String(err)
}
