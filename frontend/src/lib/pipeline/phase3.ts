import type { PipelineReviewItem } from '@/types/pipeline'
import type { SubtitleBlock } from '@/types/subtitle'
import type { AdminSettings } from '@/types/adminSettings'
import type { EnBlock } from './blockTypes'
import { toSubtitleBlocks } from './toSubtitleBlocks'
import { checkTerminology } from './terminologyCheck'
import type { PipelineThresholds } from './blockTypes'
import { buildReviewItemsForBlock } from './reviewDiagnostics'
import { normalizeEnBlocks, parseTextNormalizationConfig } from './textNormalization'
import { formatLines } from './formatLines'

type RunNode = <T>(nodeId: string, run: () => Promise<T> | T) => Promise<T>

export interface Phase3Result {
  blocks: SubtitleBlock[]
  terminologyMisses: string[]
  reviewItems: PipelineReviewItem[]
}

export async function runPhase3(
  enBlocks: EnBlock[],
  settings: AdminSettings,
  glossaryTerms: string[],
  thresholds: PipelineThresholds,
  runNode: RunNode,
): Promise<Phase3Result> {
  const reviewItems: PipelineReviewItem[] = []
  let normalizedBlocks = enBlocks

  if (settings.textNormalizationEnabled) {
    try {
      const config = parseTextNormalizationConfig(settings.textNormalizationRulesJson)
      normalizedBlocks = await runNode('normalizeSubtitleText', () => normalizeEnBlocks(enBlocks, config, thresholds))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      normalizedBlocks = await runNode('normalizeSubtitleText', () => enBlocks)
      reviewItems.push({
        id: 'text-normalization-invalid-rules',
        nodeId: 'normalizeSubtitleText',
        reason: `text normalization rules invalid: ${message}`,
        category: 'metadata',
        priority: 'should_review',
        disposition: 'manual_review',
        title: '正規化ルールが不正です',
        action: '正規化ルールJSONが不正なため、字幕テキストの正規化を適用しませんでした',
        details: [message],
        proposal: {
          kind: 'verify_terms',
          confidence: 1,
          rationale: '正規化ルールを読み込めなかったため、納品前に設定を修正してください',
        },
        score: 0,
      })
      console.warn(`Text normalization skipped: ${message}`)
    }
  }

  const finalFormattedBlocks = await runNode('finalFormatLines', () => formatLines(normalizedBlocks, thresholds))

  const terminology = await runNode('terminologyCheck', () => checkTerminology(finalFormattedBlocks, glossaryTerms))
  reviewItems.push(...finalFormattedBlocks.flatMap(block => buildReviewItemsForBlock(block, thresholds)))
  const blocks = await runNode('toSubtitleBlocks', () => toSubtitleBlocks(finalFormattedBlocks, reviewItems))

  terminology.misses.forEach((miss, index) => {
    reviewItems.push({
      id: `term-miss-${index}`,
      nodeId: 'terminologyCheck',
      reason: `term missing: ${miss}`,
      category: 'terminology',
      priority: 'should_review',
      disposition: 'manual_review',
      title: '用語が欠落している可能性があります',
      action: '用語辞書の期待表記が字幕に含まれているか確認してください',
      details: [miss],
      proposal: {
        kind: 'verify_terms',
        confidence: 0.45,
        rationale: '用語辞書が不完全なため、自動置換ではなく根拠付き確認に留める必要があります',
      },
      score: 0,
    })
  })

  return {
    blocks,
    terminologyMisses: terminology.misses,
    reviewItems,
  }
}
