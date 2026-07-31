import { describe, expect, it } from 'vitest'
import type { JaBlock, PipelineThresholds } from './blockTypes'
import { mergeShort } from './mergeShort'

/**
 * mergeShort の回帰テスト。
 *
 * 背景（本番事故）: 117分の実講義を処理した結果、1ブロックに1,175文字
 * （最終的に2,322文字）の字幕が生成され、CPSが491.4、補正LLMへのリクエストが
 * 43万トークンに達して失敗した。原因は mergeShort の停止条件が「結合後の
 * duration が shortDurationSec 以上になったか」だけで、テキスト量にも結合回数
 * にも上限が無かったこと。さらに duration が 0 秒付近に潰れた cue が連続すると
 * duration 側の条件では永久に停止できず、結合が無限に連鎖した（実機データで
 * アライナ直後に長さ0.1秒未満のキューが38件あった）。
 *
 * このテストでは、既存の結合戦略（gapの小さい方へ寄せる／SHORT_MERGE_MAX_GAP_SEC
 * を超える無音は跨がない）が非退行であることに加え、新設した3つの歯止め
 * （duration上限 / jaChars上限 / 結合回数上限）が機能することを検証する。
 */

const thresholds: PipelineThresholds = {
  shortDurationSec: 1.5,
  longDurationSec: 10,
  mergedLongDurationSec: 7,
  overCompressedRatio: 0.25,
  overCompressedJaChars: 15,
  verboseEnRatio: 1.5,
  verboseCps: 17,
  maxLineLen: 42,
  slowCps: 3,
  maxExpandPerBlock: 3,
  maxCompressPerBlock: 5,
}

function makeBlock(id: number, start: number, end: number, jaChars = 1, extra: Partial<JaBlock> = {}): JaBlock {
  return {
    id,
    start,
    end,
    jaText: 'あ'.repeat(jaChars),
    jaChars,
    alignConf: 'exact',
    ...extra,
  }
}

describe('mergeShort — 既存の結合戦略（非退行）', () => {
  it('通常の短い cue は従来どおり隣と結合される', () => {
    const blocks = [
      makeBlock(1, 0, 0.5, 1),
      makeBlock(2, 0.6, 3.0, 10),
    ]

    const result = mergeShort(blocks, thresholds)

    expect(result).toHaveLength(1)
    expect(result[0].contextGroupSourceIds).toEqual([1, 2])
    expect(result[0].start).toBe(0)
    expect(result[0].end).toBe(3.0)
    expect(result[0].jaChars).toBe(11)
  })

  it('SHORT_MERGE_MAX_GAP_SEC(0.8秒)を超える無音は跨がず、独立した cue として残す', () => {
    const blocks = [
      makeBlock(1, 0, 0.5, 1),
      // gap = 1.6 - 0.5 = 1.1 秒 > 0.8 秒 → 結合しない
      makeBlock(2, 1.6, 4.0, 10),
    ]

    const result = mergeShort(blocks, thresholds)

    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({ id: 1, start: 0, end: 0.5 })
    expect(result[1]).toMatchObject({ id: 2, start: 1.6, end: 4.0 })
  })
})

describe('mergeShort — duration 上限（mergedLongDurationSec）', () => {
  it('結合すると duration が mergedLongDurationSec を超える場合は結合しない', () => {
    const blocks = [
      makeBlock(1, 0, 0.5, 1),
      // 結合すると duration = 8 - 0 = 8 秒 > mergedLongDurationSec(7秒) → 結合しない
      makeBlock(2, 0.6, 8.0, 10),
    ]

    const result = mergeShort(blocks, thresholds)

    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({ id: 1, start: 0, end: 0.5 })
    expect(result[1]).toMatchObject({ id: 2, start: 0.6, end: 8.0 })
  })
})

describe('mergeShort — jaChars 上限（MAX_MERGED_JA_CHARS）', () => {
  it('結合後 jaChars が上限(200)を超える場合は結合しない', () => {
    const blocks = [
      makeBlock(1, 0, 0.5, 150),
      // 150 + 100 = 250 > 200 → 結合しない
      makeBlock(2, 0.6, 1.0, 100),
    ]

    const result = mergeShort(blocks, thresholds)

    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({ id: 1, jaChars: 150 })
    expect(result[1]).toMatchObject({ id: 2, jaChars: 100 })
  })

  it('結合後 jaChars が上限(200)以内なら従来どおり結合する', () => {
    const blocks = [
      makeBlock(1, 0, 0.5, 100),
      makeBlock(2, 0.6, 1.0, 90),
    ]

    const result = mergeShort(blocks, thresholds)

    expect(result).toHaveLength(1)
    expect(result[0].jaChars).toBe(190)
  })
})

describe('mergeShort — 結合回数上限（MAX_MERGE_CHAIN）', () => {
  it('結合回数が上限(4)に達したらそれ以上結合しない', () => {
    // 5件連続した極短 cue。durationもjaCharsも上限に引っかからないため、
    // 結合回数の上限だけが歯止めになるケース。
    const blocks = [
      makeBlock(1, 0.0, 0.05, 1),
      makeBlock(2, 0.1, 0.15, 1),
      makeBlock(3, 0.2, 0.25, 1),
      makeBlock(4, 0.3, 0.35, 1),
      makeBlock(5, 0.4, 0.45, 1),
    ]

    const result = mergeShort(blocks, thresholds)

    // 先頭4件が1つに結合され、5件目はそれ以上取り込めず独立して残る。
    expect(result.length).toBeGreaterThanOrEqual(2)
    for (const block of result) {
      expect(block.contextGroupSourceIds?.length ?? 1).toBeLessThanOrEqual(4)
    }
    const totalSourceIds = result.reduce((sum, block) => sum + (block.contextGroupSourceIds?.length ?? 1), 0)
    expect(totalSourceIds).toBe(5)
  })
})

describe('mergeShort — duration 0秒付近の cue が連続しても暴走しない（1,175文字事故の再現防止）', () => {
  it('長さ0のキューが100件連続していても、結合が有限で止まり、各上限を超えない', () => {
    const blocks: JaBlock[] = []
    for (let i = 0; i < 100; i += 1) {
      const t = i * 0.01
      // duration 0（アライナ直後の異常系を模した「長さが伸びない」キュー列）
      blocks.push(makeBlock(i + 1, t, t, 1))
    }

    const result = mergeShort(blocks, thresholds)

    // 暴走していれば1ブロックに全件が取り込まれるが、結合回数上限により
    // 複数ブロックに分割されて残るはず。
    expect(result.length).toBeGreaterThan(1)
    expect(result.length).toBeLessThan(blocks.length)

    for (const block of result) {
      const duration = block.end - block.start
      expect(duration).toBeLessThanOrEqual(thresholds.mergedLongDurationSec)
      expect(block.jaChars).toBeLessThanOrEqual(200)
      expect(block.contextGroupSourceIds?.length ?? 1).toBeLessThanOrEqual(4)
    }

    // 全元キューがちょうど1回ずつ結果に取り込まれていること（消失・重複が無いこと）。
    const totalSourceIds = result.reduce((sum, block) => sum + (block.contextGroupSourceIds?.length ?? 1), 0)
    expect(totalSourceIds).toBe(blocks.length)
  })

  it('無限ループにならない（極端な入力でも同期的に完了する）', () => {
    const blocks: JaBlock[] = []
    for (let i = 0; i < 100; i += 1) {
      const t = i * 0.01
      blocks.push(makeBlock(i + 1, t, t, 1))
    }

    // 無限ループであればテスト自体がタイムアウトする。完了すること自体が検証。
    expect(() => mergeShort(blocks, thresholds)).not.toThrow()
  })
})
