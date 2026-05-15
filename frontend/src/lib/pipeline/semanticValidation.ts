import type { AdminSettings } from '@/types/adminSettings'
import type { EnBlock } from './blockTypes'
import {
  classifySemanticResult,
  computeSimilaritiesBatch,
  isSemanticCheckAvailable,
} from './semanticCheck'
import type { PipelineSemanticCheckOutcome } from '@/types/pipeline'

type OnWarning = (blockId: string, message: string) => void

/**
 * 最終 semantic check ノード。
 * - 各ブロックの「元の初期翻訳 (enTextOriginal)」と「最終翻訳 (enText)」を比較
 * - similarity スコアを記録（log_only / enforce 両モード）
 * - enforce モードで failed なら enText を enTextOriginal に戻して flagged にする
 *
 * 注意: ここで block.embeddingDistances を埋める。既存の embedding 結果と
 * 衝突しないよう finalSemanticScore は独立フィールドとして埋め込む。
 */
export async function semanticValidation(
  blocks: EnBlock[],
  settings: AdminSettings,
  onWarning?: OnWarning,
): Promise<EnBlock[]> {
  if (settings.semanticCheckMode === 'off') return blocks
  if (!isSemanticCheckAvailable(settings)) return blocks

  // チェック対象: enTextOriginal が記録されており（=どこかで圧縮された）、
  // かつ最終 enText と異なるブロック
  const targetIndices: number[] = []
  const pairs: Array<[string, string]> = []
  blocks.forEach((b, i) => {
    const original = (b.enTextOriginal ?? '').trim()
    const current = b.enText.trim()
    if (!original || !current) return
    if (original === current) return
    targetIndices.push(i)
    pairs.push([original, current])
  })

  if (pairs.length === 0) return blocks

  const similarities = await computeSimilaritiesBatch(pairs, settings)

  const threshold = Math.max(0, Math.min(1, settings.qualityCorrectionThreshold ?? 0.7))

  const result = [...blocks]
  targetIndices.forEach((idx, k) => {
    const sim = similarities[k]
    if (sim === null) return
    const outcome: PipelineSemanticCheckOutcome = classifySemanticResult(sim, threshold)

    // 型補強: 既存 EnBlock を維持しつつメタを埋める
    const annotated = {
      ...result[idx],
      finalSemanticScore: sim,
      finalSemanticOutcome: outcome,
    } as EnBlock & {
      finalSemanticScore?: number
      finalSemanticOutcome?: PipelineSemanticCheckOutcome
    }

    // enforce モードで failed → 元に戻して flagged
    if (settings.semanticCheckMode === 'enforce' && outcome === 'failed') {
      const restored = (annotated.enTextOriginal ?? annotated.enText)
      onWarning?.(
        String(annotated.id),
        `semanticValidation: restored original (sim=${sim.toFixed(3)} < ${threshold.toFixed(3)})`,
      )
      result[idx] = {
        ...annotated,
        enText: restored,
        enRaw: restored,
      }
    } else {
      result[idx] = annotated
    }
  })

  return result
}
