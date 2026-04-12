/**
 * コサイン距離ユーティリティ（Embedding 乖離チェック用）。
 */

/**
 * 2つのベクトル間のコサイン類似度を返す（-1〜1）。
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) return 0

  let dot = 0
  let normA = 0
  let normB = 0

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  if (denom === 0) return 0
  return dot / denom
}

/**
 * 2つのベクトル間のコサイン距離を返す（0〜2、0が最も近い）。
 */
export function cosineDistance(a: readonly number[], b: readonly number[]): number {
  return 1 - cosineSimilarity(a, b)
}
