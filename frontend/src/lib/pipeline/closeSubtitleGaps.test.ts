import { describe, expect, it } from 'vitest'
import type { EnBlock } from './blockTypes'
import { closeSubtitleGaps, formatCloseSubtitleGapsSummary } from './closeSubtitleGaps'
import { detectGapViolations, tightenTiming } from './tightenTiming'

interface BlockSeed {
  id: number
  start: number
  end: number
}

function block(seed: BlockSeed): EnBlock {
  return {
    id: seed.id,
    start: seed.start,
    end: seed.end,
    jaText: 'テスト',
    jaChars: 2,
    alignConf: 'exact',
    enText: 'test',
    enChars: 4,
    cps: 4 / Math.max(0.001, seed.end - seed.start),
    maxLineLen: 4,
    violation: 'ok',
    expandCount: 0,
    compressCount: 0,
  }
}

describe('closeSubtitleGaps', () => {
  it('extends the previous cue end to the next cue start when the gap is short (<= maxGapSec)', () => {
    // gap = 10.3 - 10.0 = 0.3s <= maxGapSec(0.5)
    const blocks = [block({ id: 1, start: 5, end: 10.0 }), block({ id: 2, start: 10.3, end: 12 })]

    const result = closeSubtitleGaps(blocks, 0.5)

    expect(result.closedCount).toBe(1)
    expect(result.totalExtendedSec).toBeCloseTo(0.3, 4)
    const a = result.blocks.find((b) => b.id === 1)!
    const b = result.blocks.find((b) => b.id === 2)!
    // 前のキューの終了が次の開始まで延びる
    expect(a.end).toBeCloseTo(10.3, 4)
    // 次のキューの開始は絶対に動かない
    expect(b.start).toBe(10.3)
    expect(b.end).toBe(12)
  })

  it('does nothing when the gap exceeds maxGapSec (real silence stays blank)', () => {
    // gap = 1.5s > maxGapSec(0.5)
    const blocks = [block({ id: 1, start: 0, end: 10 }), block({ id: 2, start: 11.5, end: 13 })]

    const result = closeSubtitleGaps(blocks, 0.5)

    expect(result.closedCount).toBe(0)
    expect(result.totalExtendedSec).toBe(0)
    const a = result.blocks.find((b) => b.id === 1)!
    const b = result.blocks.find((b) => b.id === 2)!
    expect(a.end).toBe(10)
    expect(b.start).toBe(11.5)
  })

  it('does nothing when cues overlap (gap <= 0); overlap resolution is not this function\'s job', () => {
    const blocks = [block({ id: 1, start: 0, end: 10.2 }), block({ id: 2, start: 10.0, end: 13 })]

    const result = closeSubtitleGaps(blocks, 0.5)

    expect(result.closedCount).toBe(0)
    const a = result.blocks.find((b) => b.id === 1)!
    expect(a.end).toBe(10.2)
  })

  it('skips all processing when maxGapSec is 0', () => {
    const blocks = [block({ id: 1, start: 0, end: 10 }), block({ id: 2, start: 10.1, end: 13 })]

    const result = closeSubtitleGaps(blocks, 0)

    expect(result.closedCount).toBe(0)
    expect(result.blocks).toBe(blocks) // 参照そのまま返す（unchanged early return）
  })

  it('never closes the gap below minGapSec, so it does not reintroduce a gap_too_short violation that tightenTiming just fixed', () => {
    const minGapSec = 0.08
    // tightenTiming が minGapSec ちょうどまで広げた直後の状態を想定（gap=0.08）。
    // その上に、さらに maxGapSec=0.5 以下の短いギャップと組み合わせたケースを検証する。
    const blocks = [block({ id: 1, start: 0, end: 10.0 }), block({ id: 2, start: 10.3, end: 13 })]

    const result = closeSubtitleGaps(blocks, 0.5, minGapSec)

    const a = result.blocks.find((b) => b.id === 1)!
    const b = result.blocks.find((b) => b.id === 2)!
    // gap = 0 まで閉じず、minGapSec ちょうどを残す
    expect(b.start - a.end).toBeCloseTo(minGapSec, 4)
    expect(b.start).toBe(10.3)
    expect(detectGapViolations(result.blocks, minGapSec)).toHaveLength(0)
  })

  it('does not conflict with tightenTiming when run in sequence (tightenTiming widens, then closeSubtitleGaps narrows back down to minGapSec)', () => {
    const minGapSec = 0.08
    const minDurationSec = 0.833
    // block 1→2 の gap がわずかに minGapSec を下回る（gap_too_short）ケース。
    // tightenTiming がまず minGapSec まで広げ、その後 closeSubtitleGaps が
    // maxGapSec 以下のギャップとして「閉じよう」とするが、minGapSec を割らない。
    const blocks = [block({ id: 1, start: 0, end: 10.05 }), block({ id: 2, start: 10.1, end: 13 })]

    const tightened = tightenTiming(blocks, minGapSec, minDurationSec)
    expect(detectGapViolations(tightened.blocks, minGapSec)).toHaveLength(0)
    // tightenTiming は B.start を後ろ倒しすることがある（gap_too_short 解消のため、
    // closeSubtitleGaps とは異なる既存の仕様）。closeSubtitleGaps の責務は
    // 「tightenTiming が確定させた B.start をこれ以上動かさないこと」なので、
    // tightenTiming 後の値を基準に比較する。
    const bStartAfterTighten = tightened.blocks.find((bl) => bl.id === 2)!.start

    const closed = closeSubtitleGaps(tightened.blocks, 0.5, minGapSec)

    // 閉じた後も gap_too_short 違反が再発しない
    expect(detectGapViolations(closed.blocks, minGapSec)).toHaveLength(0)
    // closeSubtitleGaps は B.start を絶対に動かさない
    const b = closed.blocks.find((bl) => bl.id === 2)!
    expect(b.start).toBe(bStartAfterTighten)
  })

  it('reports the closed count and total extended seconds via formatCloseSubtitleGapsSummary', () => {
    const blocks = [
      block({ id: 1, start: 0, end: 10.0 }),
      block({ id: 2, start: 10.3, end: 15.0 }), // closes 0.3s
      block({ id: 3, start: 15.5, end: 20.0 }), // closes 0.5s
    ]

    const result = closeSubtitleGaps(blocks, 0.6)

    expect(result.closedCount).toBe(2)
    expect(result.totalExtendedSec).toBeCloseTo(0.8, 4)
    expect(formatCloseSubtitleGapsSummary(result)).toBe('ギャップ閉じ=2件 / 合計0.8秒')
  })

  it('returns undefined from formatCloseSubtitleGapsSummary when nothing was closed', () => {
    const blocks = [block({ id: 1, start: 0, end: 10 }), block({ id: 2, start: 12, end: 13 })]
    const result = closeSubtitleGaps(blocks, 0.5)
    expect(formatCloseSubtitleGapsSummary(result)).toBeUndefined()
  })
})
