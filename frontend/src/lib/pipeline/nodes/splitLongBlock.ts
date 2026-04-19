/**
 * splitLongBlock ノード。
 * long_segment（duration > 10s, CPS < 4）ブロックを「、」で分割して再翻訳する。
 *
 * 対象条件:
 *   - duration > 10s かつ CPS < 4
 *   - jaText に「、」が存在する（分割ポイントがある）
 *
 * 処理フロー:
 *   1. jaText を「、」で分割（2〜N サブブロック）
 *   2. 各サブブロックに文字数比例でタイムスタンプを割り当て（alignConfidence = 'proportional'）
 *   3. 各サブブロックを translateEn → expandEn → formatLines → compressEn で処理
 *   4. 元の長ブロックを分割済みブロック群に置き換える
 *
 * トレードオフ:
 *   - 「、」がない場合は分割不可 → フラグのみ
 *   - 分割後のタイムスタンプは推定値（alignConfidence = 'proportional'）
 *   - 分割後のブロックも finalQA で品質チェックされる
 *
 * Phase 2 ループ後、finalQA の前に1回だけ実行される。
 */

import type { NodeContract, NodeContext } from '../nodeContract'
import type { PipelineSubtitleBlock, JapaneseSentenceBlock } from '../types'
import type { EmbedProvider } from '../providers/openaiEmbedProvider'
import { translateEnNode } from './translateEn'
import { expandEnNode } from './expandEn'
import { formatLinesNode } from './formatLines'
import { compressEnNode } from './compressEn'

/** この duration（秒）を超えるブロックが対象 */
const LONG_SEGMENT_DURATION = 10.0

/** この CPS 未満のブロックが対象（話者速度が低い = WhisperX長発話の特徴） */
const LONG_SEGMENT_CPS = 4.0

export interface SplitLongBlockInput {
  readonly blocks: readonly PipelineSubtitleBlock[]
  readonly embedProvider?: EmbedProvider
}

export interface SplitLongBlockStats {
  readonly total: number           // 入力ブロック数
  readonly longSegments: number    // 対象 long_segment ブロック数
  readonly splitBlocks: number     // 「、」があり実際に分割したブロック数
  readonly skipped: number         // 「、」がなく分割不可だったブロック数
  readonly newBlocks: number       // 分割によって生成された新ブロック数（合計）
}

export interface SplitLongBlockOutput {
  readonly blocks: readonly PipelineSubtitleBlock[]
  readonly stats: SplitLongBlockStats
}

/**
 * JA テキストを「、」で分割し、各パートの末尾に「、」を復元する。
 * 例: "A、B、C" → ["A、", "B、", "C"]
 */
function splitAtComma(jaText: string): readonly string[] {
  const rawParts = jaText.split('、')
  return rawParts
    .map((p, i) => (i < rawParts.length - 1 ? p + '、' : p))
    .filter(p => p.trim().length > 0)
}

/**
 * 文字数比例でタイムスタンプを割り当て、JapaneseSentenceBlock[] を生成する。
 */
function createProportionalBlocks(
  parts: readonly string[],
  originalBlock: PipelineSubtitleBlock,
): readonly JapaneseSentenceBlock[] {
  const totalChars = parts.reduce((s, p) => s + p.replace(/\s/g, '').length, 0)
  const totalDuration = originalBlock.end - originalBlock.start

  let currentStart = originalBlock.start
  return parts.map((part, i) => {
    const partChars = part.replace(/\s/g, '').length
    const partDuration =
      totalChars > 0 ? totalDuration * (partChars / totalChars) : totalDuration / parts.length
    const partEnd = i < parts.length - 1 ? currentStart + partDuration : originalBlock.end

    const block: JapaneseSentenceBlock = {
      id: originalBlock.id * 1000 + i,    // 一時ID（finalQA で振り直し）
      start: currentStart,
      end: partEnd,
      jaText: part,
      sourceSegmentIds: originalBlock.sourceSegmentIds,
      alignConfidence: 'proportional',
      attempt: originalBlock.attempt,
      parentBlockId: originalBlock.id,
      blockKey: `${originalBlock.blockKey}_split${i}`,
    }
    currentStart = partEnd
    return block
  })
}

export const splitLongBlockNode: NodeContract<SplitLongBlockInput, SplitLongBlockOutput> = {
  id: 'splitLongBlock',
  schemaVersion: '1.0',

  async run(input: SplitLongBlockInput, ctx: NodeContext): Promise<SplitLongBlockOutput> {
    const { blocks, embedProvider } = input
    const { maxCps } = ctx.config.subtitleConstraints

    // 対象: duration > 10s AND CPS < 4
    const longSegmentIndices = blocks
      .map((b, i) => ({ b, i }))
      .filter(({ b }) => {
        const dur = b.end - b.start
        return dur > LONG_SEGMENT_DURATION && b.cps < LONG_SEGMENT_CPS
      })
      .map(({ i }) => i)

    if (longSegmentIndices.length === 0) {
      ctx.onProgress('splitLongBlock: long_segment なし')
      return {
        blocks,
        stats: { total: blocks.length, longSegments: 0, splitBlocks: 0, skipped: 0, newBlocks: 0 },
      }
    }

    // 「、」がある → 分割対象 / ない → スキップ
    const toSplit = longSegmentIndices.filter(i => blocks[i].jaText.includes('、'))
    const skippedCount = longSegmentIndices.length - toSplit.length

    ctx.onProgress(`splitLongBlock: ${toSplit.length}件 分割中（スキップ: ${skippedCount}件）...`)

    // インデックス → 置換ブロック群のマップ
    const replacements = new Map<number, readonly PipelineSubtitleBlock[]>()
    let newBlocksTotal = 0

    for (const idx of toSplit) {
      const original = blocks[idx]
      const parts = splitAtComma(original.jaText)

      if (parts.length < 2) {
        // 実質分割できない場合（理論上ここには来ない）
        continue
      }

      // 比例 TS で JapaneseSentenceBlock[] を生成
      const jaSentenceBlocks = createProportionalBlocks(parts, original)

      // translateEn → expandEn → formatLines → compressEn
      const enBlocks = await translateEnNode.run(jaSentenceBlocks, ctx)
      const { blocks: expandedBlocks } = await expandEnNode.run(
        { blocks: enBlocks, embedProvider }, ctx,
      )
      const formattedBlocks = await formatLinesNode.run(expandedBlocks, ctx)
      const { blocks: compressedBlocks } = await compressEnNode.run(
        { blocks: formattedBlocks, embedProvider }, ctx,
      )

      // EnglishBlock → PipelineSubtitleBlock に変換
      const subPipelineBlocks: PipelineSubtitleBlock[] = compressedBlocks.map(eb => {
        const ebDur = eb.end - eb.start
        const charCount = eb.enText.replace(/\n/g, '').length
        const cps = ebDur > 0 ? charCount / ebDur : 0
        return {
          id: 0,                             // finalQA で振り直し
          start: eb.start,
          end: eb.end,
          text: eb.enText,
          jaText: eb.jaText,
          charCount,
          cps,
          cpsOk: cps <= maxCps,
          sourceSegmentId: original.sourceSegmentIds[0] ?? 0,
          flagged: eb.translationFlagged,
          attempt: original.attempt,
          sourceSegmentIds: eb.sourceSegmentIds,
          blockKey: eb.blockKey,
          alignConfidence: 'proportional',   // 比例 TS のため
          qaViolations: [],                  // finalQA で付与
          violationPriority: null,           // finalQA で付与
          diagPattern: 'ok',                 // finalQA で付与
        }
      })

      replacements.set(idx, subPipelineBlocks)
      newBlocksTotal += subPipelineBlocks.length
    }

    // replacements を適用してブロックリストを再構築
    const finalBlocks: PipelineSubtitleBlock[] = []
    for (let i = 0; i < blocks.length; i++) {
      const replacement = replacements.get(i)
      if (replacement != null) {
        finalBlocks.push(...replacement)
      } else {
        finalBlocks.push(blocks[i])
      }
    }

    return {
      blocks: finalBlocks,
      stats: {
        total: blocks.length,
        longSegments: longSegmentIndices.length,
        splitBlocks: toSplit.length,
        skipped: skippedCount,
        newBlocks: newBlocksTotal,
      },
    }
  },
}
