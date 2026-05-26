import type { AdminSettings } from '@/types/adminSettings'
import type { CorrectedSegmentLite } from './correct'
import { fetchEmbeddings, cosineSimilarity, isSemanticCheckAvailable } from './semanticCheck'

/**
 * correctJa の効果測定用デバッグ情報。
 * 各 segment ごとに original (WhisperX 生出力) と corrected (辞書補正後) の
 * 意味類似度を Embedding で測る。
 *
 * - 類似度が 1.0 に近い → 補正なし or 微小補正（句読点・空白・誤字 1-2 文字）
 * - 類似度が下がっている → 大きな書き換え（専門用語の置換・数式表記の補正など）
 *
 * 専門用語や数式の補正があった箇所は通常 0.85-0.95 程度に下がる。
 * 元と全く違う意味になってしまった場合は 0.7 未満になることがある。
 */
export interface CorrectionDebugEntry {
  segmentId: number
  originalText: string
  correctedText: string
  similarity: number | null
  correctionDistance: number
  flagged: boolean
  changed: boolean
}

export interface CorrectionDebugSummary {
  enabled: boolean
  totalSegments: number
  changedSegments: number
  measuredSegments: number
  avgSimilarity: number | null
  minSimilarity: number | null
  maxSimilarity: number | null
  entries: CorrectionDebugEntry[]
  note?: string
}

const EMPTY_SUMMARY: CorrectionDebugSummary = {
  enabled: false,
  totalSegments: 0,
  changedSegments: 0,
  measuredSegments: 0,
  avgSimilarity: null,
  minSimilarity: null,
  maxSimilarity: null,
  entries: [],
}

/**
 * デバッグ計測がアクティブかを判定。
 * master `debugModeEnabled` AND サブフラグ `correctionDebugEmbedding` の両方が必要。
 */
export function isCorrectionDebugEnabled(settings: AdminSettings): boolean {
  return settings.debugModeEnabled && settings.correctionDebugEmbedding
}

/**
 * correctJa デバッグ計測。
 *
 * - master switch `debugModeEnabled` AND サブフラグ `correctionDebugEmbedding`
 *   が両方 true でないと **API 呼出しせず即座に返す**（コスト節約）
 * - 補正で変化がない segment は API 呼出し対象外
 * - 補正で変化があった segment のみ Embedding を取って類似度を返す
 *
 * 結果は呼出側が PipelineStageSnapshot に保存することを想定（pipeline trace に残る）。
 */
export async function runCorrectionDebug(
  correctedSegments: CorrectedSegmentLite[],
  settings: AdminSettings,
): Promise<CorrectionDebugSummary> {
  if (!isCorrectionDebugEnabled(settings)) {
    return EMPTY_SUMMARY
  }

  if (!isSemanticCheckAvailable(settings)) {
    return {
      ...EMPTY_SUMMARY,
      enabled: true,
      totalSegments: correctedSegments.length,
      note: 'Embedding API unavailable (no API key or local provider lacks /embeddings)',
    }
  }

  const changed = correctedSegments.filter(
    (segment) => (segment.text ?? '').trim() !== (segment.correctedText ?? '').trim()
      && (segment.text ?? '').trim().length > 0
      && (segment.correctedText ?? '').trim().length > 0,
  )

  if (changed.length === 0) {
    return {
      ...EMPTY_SUMMARY,
      enabled: true,
      totalSegments: correctedSegments.length,
      changedSegments: 0,
    }
  }

  // 一括 Embedding 取得（[orig1, corr1, orig2, corr2, ...] の順）
  const texts: string[] = []
  for (const segment of changed) {
    texts.push(segment.text)
    texts.push(segment.correctedText)
  }

  const vectors = await fetchEmbeddings(texts, settings)
  if (!vectors) {
    return {
      ...EMPTY_SUMMARY,
      enabled: true,
      totalSegments: correctedSegments.length,
      changedSegments: changed.length,
      note: 'Embedding API call failed',
    }
  }

  const entries: CorrectionDebugEntry[] = changed.map((segment, idx) => {
    const origVec = vectors[idx * 2]
    const corrVec = vectors[idx * 2 + 1]
    const similarity = origVec && corrVec ? cosineSimilarity(origVec, corrVec) : null
    return {
      segmentId: segment.id,
      originalText: segment.text,
      correctedText: segment.correctedText,
      similarity,
      correctionDistance: segment.correctionDistance,
      flagged: segment.correctionFlagged,
      changed: true,
    }
  })

  const valid = entries
    .map((e) => e.similarity)
    .filter((sim): sim is number => typeof sim === 'number')

  return {
    enabled: true,
    totalSegments: correctedSegments.length,
    changedSegments: changed.length,
    measuredSegments: valid.length,
    avgSimilarity: valid.length > 0 ? valid.reduce((a, b) => a + b, 0) / valid.length : null,
    minSimilarity: valid.length > 0 ? Math.min(...valid) : null,
    maxSimilarity: valid.length > 0 ? Math.max(...valid) : null,
    entries,
  }
}
