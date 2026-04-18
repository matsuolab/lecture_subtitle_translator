/**
 * Embedding ユーティリティ。
 * コサイン類似度・距離の計算。
 */

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  let dot = 0, normA = 0, normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  if (normA === 0 || normB === 0) return 1
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

export function cosineDistance(a: readonly number[], b: readonly number[]): number {
  return 1 - cosineSimilarity(a, b)
}

/**
 * テキストのリストをバッチ Embed してコサイン距離行列を返す。
 * 入力: [[textA1, textA2], [textB1, textB2], ...] のペアリスト
 * 出力: 各ペアのコサイン距離
 */
export async function batchPairDistances(
  pairs: ReadonlyArray<readonly [string, string]>,
  embed: (texts: readonly string[]) => Promise<readonly number[][]>,
): Promise<readonly number[]> {
  if (pairs.length === 0) return []

  const flat = pairs.flatMap(([a, b]) => [a, b])
  const embeddings = await embed(flat)

  return pairs.map((_, i) => cosineDistance(embeddings[i * 2], embeddings[i * 2 + 1]))
}

/**
 * テキストトリプレット [A, B, C] をバッチ Embed して
 * A→B 距離と B→C 距離を返す。
 * 用途: [jaText, en_orig, en_modified] → 翻訳品質・変換品質を1回で計測
 */
export async function batchTripletDistances(
  triplets: ReadonlyArray<readonly [string, string, string]>,
  embed: (texts: readonly string[]) => Promise<readonly number[][]>,
): Promise<ReadonlyArray<{ distAB: number; distBC: number; distAC: number }>> {
  if (triplets.length === 0) return []

  const flat = triplets.flatMap(([a, b, c]) => [a, b, c])
  const embeddings = await embed(flat)

  return triplets.map((_, i) => {
    const a = embeddings[i * 3]
    const b = embeddings[i * 3 + 1]
    const c = embeddings[i * 3 + 2]
    return {
      distAB: cosineDistance(a, b),   // 例: JA→EN_orig（翻訳品質）
      distBC: cosineDistance(b, c),   // 例: EN_orig→EN_modified（変換品質）
      distAC: cosineDistance(a, c),   // 例: JA→EN_modified（最終翻訳品質）
    }
  })
}
