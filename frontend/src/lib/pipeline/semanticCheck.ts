import type { AdminSettings } from '@/types/adminSettings'
import { createAiGateway } from '@/lib/aiGateway'
import { requireAiConnection } from './aiProvider'

const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-small'

/**
 * Embedding 計算が利用可能かを判定。
 * - OpenAI / Gemini は API キーが必要
 * - Local OpenAI Compatible は API キーなしでも /embeddings が応答すれば利用可能
 */
export function isSemanticCheckAvailable(settings: AdminSettings): boolean {
  if (settings.semanticCheckMode === 'off') return false
  try {
    const connection = requireAiConnection(settings, 'semantic check')
    return connection.provider === 'local_openai' || Boolean(connection.apiKey)
  } catch {
    return false
  }
}

/**
 * 複数テキストをまとめて Embedding API に投げる。
 * 失敗時は null を返す（caller 側で「チェック不能」として扱う）。
 */
export async function fetchEmbeddings(
  texts: string[],
  settings: AdminSettings,
): Promise<number[][] | null> {
  if (texts.length === 0) return []
  if (!isSemanticCheckAvailable(settings)) return null

  const model = settings.embeddingModel?.trim() || DEFAULT_EMBEDDING_MODEL
  return createAiGateway(settings).embeddings({ model, input: texts })
}

/**
 * 2 ベクトルの cosine similarity を計算。
 * 0 ベクトル等の異常時は 0 を返す。
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

/**
 * 2 テキストの意味類似度を計算。
 * Embedding 取得失敗 / 設定無効時は null を返す。
 */
export async function computeSimilarity(
  textA: string,
  textB: string,
  settings: AdminSettings,
): Promise<number | null> {
  const normalizedA = textA.trim()
  const normalizedB = textB.trim()
  if (!normalizedA || !normalizedB) return null
  if (normalizedA === normalizedB) return 1.0

  const vecs = await fetchEmbeddings([normalizedA, normalizedB], settings)
  if (!vecs || vecs.length !== 2) return null
  return cosineSimilarity(vecs[0], vecs[1])
}

/**
 * 複数テキスト群をまとめて投げて、ペアごとの類似度を返す。
 * pairs: [[textA, textB], ...]
 * 結果: 各ペアの類似度（取得失敗時はそのインデックスは null）
 */
export async function computeSimilaritiesBatch(
  pairs: Array<[string, string]>,
  settings: AdminSettings,
): Promise<Array<number | null>> {
  if (pairs.length === 0) return []

  // 重複排除して投げる
  const uniqueTexts = new Map<string, number>()
  for (const [a, b] of pairs) {
    const ta = a.trim()
    const tb = b.trim()
    if (ta && !uniqueTexts.has(ta)) uniqueTexts.set(ta, uniqueTexts.size)
    if (tb && !uniqueTexts.has(tb)) uniqueTexts.set(tb, uniqueTexts.size)
  }

  const inputs = [...uniqueTexts.keys()]
  if (inputs.length === 0) return pairs.map(() => null)

  const vectors = await fetchEmbeddings(inputs, settings)
  if (!vectors) return pairs.map(() => null)

  return pairs.map(([a, b]) => {
    const ta = a.trim()
    const tb = b.trim()
    if (!ta || !tb) return null
    if (ta === tb) return 1.0
    const ia = uniqueTexts.get(ta)
    const ib = uniqueTexts.get(tb)
    if (ia === undefined || ib === undefined) return null
    return cosineSimilarity(vectors[ia], vectors[ib])
  })
}

/**
 * 類似度判定の閾値による分類。
 * - passed: threshold 以上（意味保持OK）
 * - borderline: threshold-0.05 〜 threshold（境界）
 * - failed: threshold-0.05 未満（破壊疑い）
 */
export type SemanticCheckResult = 'passed' | 'borderline' | 'failed'

export function classifySemanticResult(
  similarity: number,
  threshold: number,
): SemanticCheckResult {
  if (similarity >= threshold) return 'passed'
  if (similarity >= threshold - 0.05) return 'borderline'
  return 'failed'
}
