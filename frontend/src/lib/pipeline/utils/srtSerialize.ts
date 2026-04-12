/**
 * SRT タイムスタンプのシリアライズ。
 * pysubs2 の代替（純粋関数）。
 */

/**
 * 秒数を SRT タイムスタンプ形式（HH:MM:SS,mmm）に変換する。
 */
export function secondsToSrtTimestamp(seconds: number): string {
  const totalMs = Math.round(seconds * 1000)
  const ms = totalMs % 1000
  const totalSec = Math.floor(totalMs / 1000)
  const sec = totalSec % 60
  const totalMin = Math.floor(totalSec / 60)
  const min = totalMin % 60
  const hour = Math.floor(totalMin / 60)

  return (
    String(hour).padStart(2, '0') + ':' +
    String(min).padStart(2, '0') + ':' +
    String(sec).padStart(2, '0') + ',' +
    String(ms).padStart(3, '0')
  )
}

/**
 * SRT タイムスタンプ文字列（HH:MM:SS,mmm）を秒数に変換する。
 */
export function srtTimestampToSeconds(ts: string): number {
  const match = ts.match(/^(\d{2}):(\d{2}):(\d{2}),(\d{3})$/)
  if (!match) throw new Error(`Invalid SRT timestamp: ${ts}`)
  const [, h, m, s, ms] = match
  return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000
}

export interface SrtBlock {
  readonly id: number
  readonly start: number  // 秒
  readonly end: number    // 秒
  readonly text: string
}

/**
 * SrtBlock[] から SRT ファイル文字列を生成する。
 */
export function serializeToSrt(blocks: readonly SrtBlock[]): string {
  return blocks
    .map(b =>
      `${b.id}\n` +
      `${secondsToSrtTimestamp(b.start)} --> ${secondsToSrtTimestamp(b.end)}\n` +
      `${b.text}\n`
    )
    .join('\n')
}
