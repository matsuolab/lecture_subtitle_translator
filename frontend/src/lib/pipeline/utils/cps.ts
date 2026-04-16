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
 * テキストと期間から CPS / 行長チェックを行う。
 *
 * charCount: 全文字数（\n を除く）→ CPS 計算に使用
 * maxLineLength: 最長行の文字数 → 行長制約チェックに使用
 *
 * 注: maxChars は「1行あたりの上限」であり、テキスト全体の長さではない。
 *     2行字幕は各行が maxChars 以内であれば OK。
 */
export function checkBlock(text: string, durationSec: number, maxCps: number, maxChars: number): {
  cps: number
  cpsOk: boolean
  charCount: number
  maxLineLength: number
} {
  const lines = text.split('\n')
  // CPS は全文字数（改行を除く）で計算
  const charCount = lines.reduce((sum, l) => sum + l.length, 0)
  // 行長制約は最長行で判定
  const maxLineLength = Math.max(...lines.map(l => l.length))
  const cps = calcCps(charCount, durationSec)
  return {
    cps,
    cpsOk: maxLineLength <= maxChars && cps <= maxCps,
    charCount,
    maxLineLength,
  }
}
