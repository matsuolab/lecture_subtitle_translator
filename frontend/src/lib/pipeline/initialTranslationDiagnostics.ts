import type { EnBlock } from './blockTypes'
import {
  classifyTranslationRisk,
  type TranslationRiskBand,
  type TranslationRiskObservation,
} from './translationRiskClassifier'

export interface InitialTranslationObservation extends TranslationRiskObservation {
  blockId: number
}

export interface InitialTranslationDiagnostics {
  totalBlocks: number
  observedBlockCount: number
  riskBandCounts: Record<TranslationRiskBand, number>
  observations: InitialTranslationObservation[]
}

/**
 * `translateEn` 直後の本文を読むだけの観測Module。
 * 戻り値は stage snapshot 用で、block 配列や後段の分岐を変更しない。
 */
export function analyzeInitialTranslations(
  blocks: readonly EnBlock[],
  glossaryTerms: string[] = [],
): InitialTranslationDiagnostics {
  const riskBandCounts: Record<TranslationRiskBand, number> = {
    none: 0,
    low: 0,
    medium: 0,
    high: 0,
  }
  const observations: InitialTranslationObservation[] = []

  for (const block of blocks) {
    const risk = classifyTranslationRisk(block.jaText, block.enText, glossaryTerms)
    riskBandCounts[risk.riskBand] += 1
    if (risk.riskBand !== 'none') observations.push({ blockId: block.id, ...risk })
  }

  return {
    totalBlocks: blocks.length,
    observedBlockCount: observations.length,
    riskBandCounts,
    observations,
  }
}
