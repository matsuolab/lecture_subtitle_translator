import { describe, expect, it } from 'vitest'
import { __testing } from './semanticSplitJa'
import type { CorrectedSegmentLite } from './correct'

function makeSegment(id: number, text: string): CorrectedSegmentLite {
  return {
    id,
    start: id * 10,
    end: id * 10 + 5,
    text,
    correctedText: text,
    correctionDistance: 0,
    correctionFlagged: false,
  }
}

function makeUnit(sourceSegmentId: number, jaText: string) {
  return {
    unitId: `u${sourceSegmentId}`,
    sourceSegmentId,
    jaText,
    canMergeWithNext: false,
  }
}

describe('filterUnitsToBatch', () => {
  const segments = [
    makeSegment(487, 'それではこれから最適化アルゴリズムの説明を始めます'),
    makeSegment(488, 'ミニバッチ勾配降下法とはデータ集合の一部のみを使う方法です'),
  ]

  it('バッチ内セグメントに正しく帰属するユニットは残す', () => {
    const units = [
      makeUnit(487, 'それではこれから最適化アルゴリズムの説明を始めます'),
      makeUnit(488, 'ミニバッチ勾配降下法とは'),
      makeUnit(488, 'データ集合の一部のみを使う方法です'),
    ]
    expect(__testing.filterUnitsToBatch(units, segments)).toEqual(units)
  })

  it('バッチに存在しないsource_segment_idのユニットは捨てる（スキーマ例の id:1 鸚鵡返し事故）', () => {
    // T7本走行で観測: E2Bが output_schema の例 source_segment_id: 1 をそのまま返し、
    // 講義全体のユニットがセグメント1へ集積して巨大ブロックになった
    const units = [makeUnit(1, 'それではこれから最適化アルゴリズムの説明を始めます')]
    expect(__testing.filterUnitsToBatch(units, segments)).toEqual([])
  })

  it('IDはバッチ内でもテキストが当該セグメントと重ならないユニットは捨てる', () => {
    const units = [makeUnit(487, '全く関係のない講義後半の正規化についての文章です')]
    expect(__testing.filterUnitsToBatch(units, segments)).toEqual([])
  })

  it('句読点や空白の差異があっても本来のユニットは残す', () => {
    const units = [makeUnit(487, 'それでは、これから最適化アルゴリズムの説明を始めます。')]
    expect(__testing.filterUnitsToBatch(units, segments)).toHaveLength(1)
  })
})
