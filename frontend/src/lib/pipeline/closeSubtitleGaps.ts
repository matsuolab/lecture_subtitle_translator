import type { EnBlock } from './blockTypes'

/**
 * closeSubtitleGaps が実際に閉じた 1 ペア分のログ。
 */
export interface GapCloseEntry {
  /** 先行 cue */
  blockAId: number
  /** 後続 cue */
  blockBId: number
  /** 閉じる前の gap（秒） */
  beforeGapSec: number
  /** 閉じた後の gap（秒） */
  afterGapSec: number
  /** A.end を後ろへ延ばした量（秒） */
  extendSec: number
  beforeAEnd: number
  afterAEnd: number
}

export interface CloseSubtitleGapsResult {
  closedCount: number
  /** 閉じた分の合計延長秒数 */
  totalExtendedSec: number
  blocks: EnBlock[]
  entries: GapCloseEntry[]
}

/**
 * 隣接 cue 間の「短い空白」を閉じ、発話中に画面がちらつくのを防ぐ（決定的処理・LLM不要）。
 *
 * 背景: asrAlignment.ts を「実際に話された区間」を正確に返すよう作り直した結果、
 * キューとキューの間に短い空白が生じるようになった（実測: LLMが訳文を削除した箇所や
 * 実質的な無音箇所など）。放送・配信の字幕慣行では、
 *   - 短いギャップ（ちらつきの原因になる程度）は前の cue を延ばして閉じる
 *   - 長い間（実質的な無音）はそのまま空白にしておく
 *   - 次の cue の開始は絶対に前倒ししない（まだ話されていないテキストを先に見せない）
 * とされる。この関数はその規則をそのまま実装する。
 *
 * タイミングの正しさ（アライメント層 = asrAlignment.ts）と表示の連続性（表示層）は
 * 別レイヤーとして扱う方針のため、この関数は EnBlock の start を一切変更しない。
 *
 * @param blocks 対象ブロック（start 昇順である必要はない。内部でソートして処理する）
 * @param maxGapSec これ以下の gap だけを閉じる対象にする。0 以下なら処理全体をスキップする
 *   （「0 にすると閉じません」という設定 UI の説明どおりの挙動）。
 * @param minGapSec 閉じた後も残す最低 gap（秒）。tightenTiming（gap_too_short の解消）が
 *   要求する最低 gap を下回らないようにするための下駄。省略時は 0（完全に閉じる＝
 *   A.end を B.start まで延ばす）。tightenTiming と組み合わせて使う場合は、
 *   tightenTiming に渡した minGapSec と同じ値を渡すことで、閉じた後に
 *   gap_too_short 違反を再発させないことを保証できる。
 */
export function closeSubtitleGaps(
  blocks: EnBlock[],
  maxGapSec: number,
  minGapSec = 0,
): CloseSubtitleGapsResult {
  if (maxGapSec <= 0 || blocks.length < 2) {
    return { closedCount: 0, totalExtendedSec: 0, blocks, entries: [] }
  }

  const sorted = [...blocks].sort((a, b) => a.start - b.start)

  // 修正中の block を id→end でトラッキング（tightenTiming.ts と同じ手法）。
  // start は変更しないので end だけで十分。
  const endById = new Map<number, number>()
  for (const b of blocks) endById.set(b.id, b.end)

  const entries: GapCloseEntry[] = []

  for (let i = 0; i < sorted.length - 1; i += 1) {
    const aId = sorted[i].id
    const bId = sorted[i + 1].id
    const aEnd = endById.get(aId)
    const bStart = sorted[i + 1].start
    if (aEnd === undefined) continue

    const gap = bStart - aEnd
    // 重なり（gap<=0）は既存の重なり解消（tightenTiming 等）の責務。ここでは触らない。
    if (gap <= 0) continue
    // 長い間（実質的な無音）はそのまま空白が正しい。閉じない。
    if (gap > maxGapSec) continue

    // B.start は絶対に動かさない。A.end だけを「B.start - minGapSec」まで延ばす。
    const targetAEnd = bStart - minGapSec
    if (targetAEnd <= aEnd) continue // 既に minGapSec 以内 → 閉じる余地なし

    endById.set(aId, targetAEnd)
    entries.push({
      blockAId: aId,
      blockBId: bId,
      beforeGapSec: Math.round(gap * 10000) / 10000,
      afterGapSec: Math.round((bStart - targetAEnd) * 10000) / 10000,
      extendSec: Math.round((targetAEnd - aEnd) * 10000) / 10000,
      beforeAEnd: aEnd,
      afterAEnd: targetAEnd,
    })
  }

  const updatedBlocks = blocks.map((b) => {
    const newEnd = endById.get(b.id)
    if (newEnd === undefined || newEnd === b.end) return b
    return { ...b, end: newEnd }
  })

  return {
    closedCount: entries.length,
    totalExtendedSec: Math.round(entries.reduce((sum, e) => sum + e.extendSec, 0) * 10000) / 10000,
    blocks: updatedBlocks,
    entries,
  }
}

/**
 * CloseSubtitleGapsResult を localPipeline.ts のトレース summary 用に整形する。
 * 例: 'ギャップ閉じ=12件 / 合計3.4秒'
 * 何も閉じなかった場合は undefined（partialFailureSummary.ts と同じ「報告不要なら省略」方針）。
 */
export function formatCloseSubtitleGapsSummary(result: CloseSubtitleGapsResult): string | undefined {
  if (result.closedCount === 0) return undefined
  return `ギャップ閉じ=${result.closedCount}件 / 合計${result.totalExtendedSec.toFixed(1)}秒`
}
