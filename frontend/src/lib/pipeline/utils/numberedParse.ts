/**
 * "[id] text" 形式の LLM レスポンスパーサ。
 *
 * LLM に番号付きバッチ処理をさせる際のフォーマット:
 *   [1] テキスト1
 *   [2] テキスト2
 *
 * LLM 出力が崩れた場合（欠落・重複・余分なテキスト）も安全に処理する。
 */

export interface NumberedEntry {
  readonly id: number
  readonly text: string
}

/**
 * LLM レスポンス文字列から [id] text エントリを抽出する。
 *
 * - 欠落した ID はスキップ（呼び出し側でフォールバック処理）
 * - 同じ ID が複数回現れた場合は最初のものを使用
 * - ID 間のテキストは前のエントリに連結する
 */
export function parseNumbered(response: string): NumberedEntry[] {
  const result: NumberedEntry[] = []
  const seen = new Set<number>()

  // [数字] で行を分割する
  const parts = response.split(/(?=\[\d+\])/)

  for (const part of parts) {
    const match = part.match(/^\[(\d+)\]\s*(.*)$/s)
    if (!match) continue

    const id = Number(match[1])
    const text = match[2].trim()

    if (seen.has(id)) continue
    seen.add(id)

    if (text.length > 0) {
      result.push({ id, text })
    }
  }

  return result
}

/**
 * 元テキストのマップと LLM レスポンスをマージする。
 * LLM が返さなかった ID は元テキストで補完する。
 *
 * @param originalTexts - id → 元テキストのマップ
 * @param response - LLM レスポンス文字列
 * @returns id → 結果テキストのマップ
 */
export function mergeWithFallback(
  originalTexts: ReadonlyMap<number, string>,
  response: string,
): Map<number, string> {
  const parsed = parseNumbered(response)
  const parsedMap = new Map(parsed.map(e => [e.id, e.text]))

  const result = new Map<number, string>()
  for (const [id, original] of originalTexts) {
    result.set(id, parsedMap.get(id) ?? original)
  }
  return result
}

/**
 * テキストマップを "[id] text\n[id] text\n..." 形式に変換する（LLM への入力用）。
 */
export function formatNumberedInput(texts: ReadonlyMap<number, string>): string {
  return Array.from(texts.entries())
    .map(([id, text]) => `[${id}] ${text}`)
    .join('\n')
}
