/**
 * CPS（Characters Per Second）計算ユーティリティ。
 */

/**
 * CPS を計算する。durationSec が 0 以下の場合は 0 を返す。
 */
export function calcCps(charCount: number, durationSec: number): number {
  if (durationSec <= 0) return 0
  return Math.round((charCount / durationSec) * 10) / 10
}

/**
 * CPS が制約内かチェックする。
 */
export function isCpsOk(charCount: number, durationSec: number, maxCps: number, maxChars: number): boolean {
  if (charCount > maxChars) return false
  const cps = calcCps(charCount, durationSec)
  return cps <= maxCps
}

/**
 * テキストと期間から CPS 違反かどうかを判定する。
 */
export function checkBlock(text: string, durationSec: number, maxCps: number, maxChars: number): {
  cps: number
  cpsOk: boolean
  charCount: number
} {
  const charCount = text.length
  const cps = calcCps(charCount, durationSec)
  return {
    cps,
    cpsOk: charCount <= maxChars && cps <= maxCps,
    charCount,
  }
}
