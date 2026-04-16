/**
 * mergeShort ノード。
 * MIN_DURATION 未満または JA テキストが短すぎるブロックを隣接ブロックにマージする。
 *
 * 設計思想:
 *   splitJa の直後に1回だけ実行する（リトライループの外）。
 *   「マージ」と「分割リトライ」は対立する操作なので同じループに入れない。
 *
 * マージアルゴリズム（docs/research/20260415_pipeline_redesign_v2.md §4 参照）:
 *   左から右へ1パス。マージ後もまだ短ければ連鎖マージ。
 *   マージ先: ギャップが小さい方を優先（prev vs next）。
 *   MAX_DURATION 超過時は超過量が小さい方で強制マージ + durationTooLong フラグ。
 *   両側がMAX_GAP_TO_MERGE を超える孤立ブロック → マージしない（durationTooShort フラグ）。
 *
 * LLM 不使用。純粋 TypeScript。
 */

import type { NodeContract, NodeContext } from '../nodeContract'
import type { JapaneseSentenceBlock } from '../types'

const MIN_DURATION      = 1.0   // 秒：推奨最短（Netflix/Amazon 共通）
const MAX_DURATION      = 7.0   // 秒：推奨最長
const MIN_JA_CHARS      = 8     // 文字：これ未満は意味単位として不完全
const MAX_GAP_TO_MERGE  = 1.0   // 秒：これを超えるギャップは孤立扱い

function shouldMerge(block: JapaneseSentenceBlock): boolean {
  const duration = block.end - block.start
  const jaChars  = block.jaText.replace(/\s/g, '').length
  return duration < MIN_DURATION || jaChars < MIN_JA_CHARS
}

function mergeTwo(
  a: JapaneseSentenceBlock,
  b: JapaneseSentenceBlock,
  newId: number,
  attempt: number,
): JapaneseSentenceBlock {
  // 時刻順にテキストを結合
  const [first, second] = a.start <= b.start ? [a, b] : [b, a]
  return {
    id: newId,
    start: Math.min(a.start, b.start),
    end:   Math.max(a.end,   b.end),
    jaText: first.jaText + second.jaText,
    sourceSegmentIds: [
      ...new Set([...a.sourceSegmentIds, ...b.sourceSegmentIds]),
    ],
    alignConfidence: 'merged',
    attempt,
    blockKey: `a${attempt}s${newId}`,
  }
}

export const mergeShortNode: NodeContract<
  readonly JapaneseSentenceBlock[],
  readonly JapaneseSentenceBlock[]
> = {
  id: 'mergeShort',
  schemaVersion: '1.0',

  async run(
    input: readonly JapaneseSentenceBlock[],
    ctx: NodeContext,
  ): Promise<readonly JapaneseSentenceBlock[]> {
    ctx.onProgress('mergeShort: 短ブロックをマージ中...')

    if (input.length === 0) return input

    const attempt = input[0]?.attempt ?? 1
    // 作業用配列（ミュータブル）
    const work: JapaneseSentenceBlock[] = [...input]
    let idCounter = 1

    let i = 0
    while (i < work.length) {
      const block = work[i]

      if (!shouldMerge(block)) {
        work[i] = { ...block, id: idCounter++, blockKey: `a${attempt}s${idCounter - 1}` }
        i++
        continue
      }

      // マージ候補を評価
      const prevBlock = i > 0 ? work[i - 1] : null
      const nextBlock = i < work.length - 1 ? work[i + 1] : null

      const gapToPrev = prevBlock ? block.start - prevBlock.end : Infinity
      const gapToNext = nextBlock ? nextBlock.start - block.end : Infinity

      // どちらも遠すぎる → 孤立ブロック、マージしない
      const prevOk = gapToPrev <= MAX_GAP_TO_MERGE
      const nextOk = gapToNext <= MAX_GAP_TO_MERGE

      if (!prevOk && !nextOk) {
        // 孤立：マージ不可、そのまま（finalQA が durationTooShort をflagする）
        work[i] = { ...block, id: idCounter++, blockKey: `a${attempt}s${idCounter - 1}` }
        i++
        continue
      }

      // マージ後の duration を試算して候補を選択
      const durWithPrev = prevBlock ? (Math.max(block.end, prevBlock.end) - Math.min(block.start, prevBlock.start)) : Infinity
      const durWithNext = nextBlock ? (Math.max(block.end, nextBlock.end) - Math.min(block.start, nextBlock.start)) : Infinity

      // まず MAX_DURATION 以内の候補を優先
      const prevFits = prevOk && durWithPrev <= MAX_DURATION
      const nextFits = nextOk && durWithNext <= MAX_DURATION

      let mergeWithPrev: boolean

      if (prevFits && nextFits) {
        // 両方収まる → ギャップが小さい方
        mergeWithPrev = gapToPrev <= gapToNext
      } else if (prevFits) {
        mergeWithPrev = true
      } else if (nextFits) {
        mergeWithPrev = false
      } else {
        // 両方 MAX 超過 → 超過量が小さい方（durationTooLong は finalQA がflag）
        if (!prevOk) {
          mergeWithPrev = false
        } else if (!nextOk) {
          mergeWithPrev = true
        } else {
          mergeWithPrev = durWithPrev <= durWithNext
        }
      }

      if (mergeWithPrev && prevBlock) {
        const merged = mergeTwo(prevBlock, block, idCounter++, attempt)
        // 前ブロックを置き換え、現在のブロックを削除
        work[i - 1] = merged
        work.splice(i, 1)
        // 前ブロックに戻って再評価（連続マージ対応）
        i = Math.max(0, i - 1)
      } else if (!mergeWithPrev && nextBlock) {
        const merged = mergeTwo(block, nextBlock, idCounter++, attempt)
        work[i] = merged
        work.splice(i + 1, 1)
        // 同じ位置で再評価（マージ後もまだ短い可能性）
      } else {
        work[i] = { ...block, id: idCounter++, blockKey: `a${attempt}s${idCounter - 1}` }
        i++
      }
    }

    // id を振り直して返す（blockKey は attempt + 連番）
    return work.map((b, idx) => ({
      ...b,
      id: idx + 1,
      blockKey: `a${attempt}s${idx + 1}`,
    }))
  },
}
