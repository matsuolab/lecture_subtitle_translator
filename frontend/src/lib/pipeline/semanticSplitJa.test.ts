import { describe, expect, it } from 'vitest'
import { __testing } from './semanticSplitJa'
import { buildAsrCharStream, buildAsrCharStreamWithRanges, findSilenceBoundaries } from './asrAlignment'
import { DEFAULT_PIPELINE_THRESHOLDS, type PipelineThresholds } from './blockTypes'
import type { CorrectedSegmentLite } from './correct'
import type { TranscriptSegment } from './types'
import { getDefaultAdminSettings } from '@/api/adminSettings'

declare const require: (id: string) => { readFileSync: (p: string, e: string) => string }
declare const process: { cwd: () => string }
const { readFileSync } = require('fs')

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

interface FixtureWord { word: string; start: number; end: number; score: number }
interface FixtureSegment { id: number; start: number; end: number; text: string; words: FixtureWord[] }

/**
 * seg6/seg7 の実単語（147.48-201.65秒）。旧実装（27秒窓の文字数比例配分）では
 * セグメント跨ぎの融合ユニットが誤った時刻（バグ値 174.913 / 174.833）になっていた
 * 実データ。asrAlignment.test.ts と同じフィクスチャを使う。
 */
function loadSeg6Seg7Fixture(): TranscriptSegment[] {
  const path = `${process.cwd()}/src/lib/pipeline/__fixtures__/asrAlignment.seg6seg7.json`
  const raw = readFileSync(path, 'utf-8')
  const parsed = JSON.parse(raw) as { segments: FixtureSegment[] }
  return parsed.segments.map(segment => ({
    id: segment.id,
    start: segment.start,
    end: segment.end,
    text: segment.text,
    words: segment.words,
  }))
}

function makeRawUnit(sourceSegmentId: number, jaText: string, unitId: string) {
  return { unitId, sourceSegmentId, jaText, canMergeWithNext: false }
}

describe('semanticSplitJa 統合: セグメント跨ぎのアライメント（実データフィクスチャ）', () => {
  const segments = loadSeg6Seg7Fixture()
  const { stream: asrStream, ranges: segmentRanges } = buildAsrCharStreamWithRanges(segments)
  const units = [
    makeRawUnit(6, '講座の受講料は無料です。', 'u1'),
    makeRawUnit(6, '講座終了後もさらなる学びやさ', 'u2'),
    makeRawUnit(6, 'まざまな機会を提供しています。', 'u3'),
    makeRawUnit(6, '松尾県独自のコミュニティへの参加機会として、継続的な講座の受講や実践経験を積む企業との共同研究プロジェクト、インターンシップなどが用意されています。', 'u4'),
    makeRawUnit(7, '2022年にGCIを受講した三重大学の修了生あいさんは、', 'u5'),
    makeRawUnit(7, 'その後、大学で電子工学を学ぶ傍ら、ティーチングアシスタントとして受講生のサポートを行っています。', 'u6'),
  ]
  // 4件目のユニット（融合文）は約14.6秒あり、デフォルトの mergedLongDurationSec(7.0秒)を
  // 超えるため実運用では splitOverlongUnit で分割される。この統合テストの主眼は
  // 「セグメント跨ぎの時刻が正しく求まること」であり、分割ロジック自体は semanticSplitJa.ts
  // で変更していない（既存ロジックをそのまま流用）ため、ここでは分割を無効化した
  // 閾値を使い、タスク仕様書の受け入れ基準にあるユニット番号と1:1で対応させて検証する。
  // 分割込みの end-to-end 挙動は下の別 describe で確認する。
  const noSplitThresholds: PipelineThresholds = { ...DEFAULT_PIPELINE_THRESHOLDS, mergedLongDurationSec: 300 }

  const aligned = __testing.alignUnitsGlobally(units, asrStream, segmentRanges, noSplitThresholds, []).units
  const blocks = __testing.buildJaBlocks(aligned)

  it('6ユニット分のブロックが1:1で返る', () => {
    expect(blocks).toHaveLength(6)
  })

  it('融合ユニット（4件目）の start が163.5-163.9に入る（旧実装のバグ値174.913ではない）', () => {
    expect(blocks[3].start).toBeGreaterThanOrEqual(163.5)
    expect(blocks[3].start).toBeLessThanOrEqual(163.9)
    expect(blocks[3].start).not.toBeCloseTo(174.913, 0)
  })

  it('3件目「まざまな機会を提供しています。」の end が161.7-162.2に入る（旧実装のバグ値174.833ではない）', () => {
    expect(blocks[2].end).toBeGreaterThanOrEqual(161.7)
    expect(blocks[2].end).toBeLessThanOrEqual(162.2)
    expect(blocks[2].end).not.toBeCloseTo(174.833, 0)
  })

  it('全ブロックで重なりが無い（blocks[i].end <= blocks[i+1].start）', () => {
    for (let i = 0; i < blocks.length - 1; i += 1) {
      expect(blocks[i].end).toBeLessThanOrEqual(blocks[i + 1].start)
    }
  })

  it('全ブロックの alignConf が exact（interpolated=no_words に落ちない）', () => {
    for (const block of blocks) {
      expect(block.alignConf).toBe('exact')
    }
  })

  it('各ブロックに words（ASR文字から復元した WordTimestamp[]）が入る', () => {
    for (const block of blocks) {
      expect(block.words).toBeDefined()
      expect((block.words ?? []).length).toBeGreaterThan(0)
    }
  })
})

describe('semanticSplitJa 統合: オーバーロングユニットの分割が実閾値でも end-to-end で動く', () => {
  const segments = loadSeg6Seg7Fixture()
  const { stream: asrStream, ranges: segmentRanges } = buildAsrCharStreamWithRanges(segments)
  const overlongText = '松尾県独自のコミュニティへの参加機会として、継続的な講座の受講や実践経験を積む企業との共同研究プロジェクト、インターンシップなどが用意されています。'
  const units = [
    makeRawUnit(6, '講座の受講料は無料です。', 'u1'),
    makeRawUnit(6, 'まざまな機会を提供しています。', 'u2'),
    makeRawUnit(6, overlongText, 'u3'),
    makeRawUnit(7, '2022年にGCIを受講した三重大学の修了生あいさんは、', 'u4'),
  ]

  it('mergedLongDurationSec を超えるユニットは分割され、分割後も重なりなく元テキストを保持する', () => {
    const aligned = __testing.alignUnitsGlobally(units, asrStream, segmentRanges, DEFAULT_PIPELINE_THRESHOLDS, []).units
    const blocks = __testing.buildJaBlocks(aligned)

    // 4ユニットのうち1つ（overlongText, 約14.6秒）が分割されるため、ブロック数は4より増える。
    expect(blocks.length).toBeGreaterThan(units.length)

    for (let i = 0; i < blocks.length - 1; i += 1) {
      expect(blocks[i].end).toBeLessThanOrEqual(blocks[i + 1].start)
    }

    // 修正前は分割断片をユニット列全体で ASR ストリーム全体へ再アラインしていたため、
    // 断片が遠方のキューと誤対応し、分割前の親スパン（約14.704秒）より長い
    // 11.924秒のブロックが実際に発生していた（分割の目的＝「長すぎるキューを短くする」
    // に反する不具合）。修正後は断片を親スパンのASR範囲に閉じ込めるため、実測では
    // 全断片が mergedLongDurationSec(7.0秒) 以下になる
    // （実測: [2.401, 3.502, 1.180, 5.604, 3.742, 4.178, 6.064]、最大 6.064秒）。
    for (const block of blocks) {
      expect(block.end - block.start).toBeLessThanOrEqual(DEFAULT_PIPELINE_THRESHOLDS.mergedLongDurationSec)
    }

    // 分割前後でテキストが失われていないこと（結合すれば元の4ユニットの原文と一致）。
    const concatenated = blocks.map(block => block.jaText).join('')
    expect(concatenated).toBe(units.map(unit => unit.jaText).join(''))
  })

  it('分割断片は分割前の親スパン内に収まる（分割前の親スパンより長くならない）', () => {
    // 分割を発生させない極端に大きい閾値で、overlongText 単体（u3）の分割前の
    // 親スパンを求める（実測: [163.688, 178.392]、約14.704秒）。
    const noSplitThresholds: PipelineThresholds = { ...DEFAULT_PIPELINE_THRESHOLDS, mergedLongDurationSec: 300 }
    const unsplitAligned = __testing.alignUnitsGlobally(units, asrStream, segmentRanges, noSplitThresholds, []).units
    const parent = unsplitAligned.find(item => item.unit.unitId === 'u3')
    expect(parent).toBeDefined()

    const splitAligned = __testing.alignUnitsGlobally(units, asrStream, segmentRanges, DEFAULT_PIPELINE_THRESHOLDS, []).units
    const fragments = splitAligned.filter(item => item.unit.unitId.startsWith('u3_'))
    // overlongText は分割されるはず（4断片、実測）。
    expect(fragments.length).toBeGreaterThan(1)

    for (const fragment of fragments) {
      expect(fragment.start).toBeGreaterThanOrEqual(parent!.start)
      expect(fragment.end).toBeLessThanOrEqual(parent!.end)
    }
  })

  it('断片同士は重ならず、元の順序を保つ（単調性）', () => {
    const splitAligned = __testing.alignUnitsGlobally(units, asrStream, segmentRanges, DEFAULT_PIPELINE_THRESHOLDS, []).units
    const fragments = splitAligned.filter(item => item.unit.unitId.startsWith('u3_'))
    expect(fragments.length).toBeGreaterThan(1)
    for (let i = 0; i < fragments.length - 1; i += 1) {
      expect(fragments[i].end).toBeLessThanOrEqual(fragments[i + 1].start)
      expect(fragments[i].start).toBeLessThanOrEqual(fragments[i + 1].start)
    }
  })

  it('exact な断片の words は、その断片自身の start/end 範囲に収まる（スライスのオフセット加算漏れがあれば失敗する）', () => {
    // firstCharIndex/lastCharIndex にスライス開始位置のオフセットを加算し忘れると、
    // asrStream 上の全く別の位置（典型的には序盤）を指してしまい、words の
    // start/end がその断片自身の時刻範囲から大きく外れる。
    const splitAligned = __testing.alignUnitsGlobally(units, asrStream, segmentRanges, DEFAULT_PIPELINE_THRESHOLDS, []).units
    const fragments = splitAligned.filter(item => item.unit.unitId.startsWith('u3_'))
    const exactFragmentsWithWords = fragments.filter(f => f.alignConf === 'exact' && f.words.length > 0)
    expect(exactFragmentsWithWords.length).toBeGreaterThan(0)
    for (const fragment of exactFragmentsWithWords) {
      const firstWord = fragment.words[0]
      const lastWord = fragment.words[fragment.words.length - 1]
      expect(firstWord.start).toBeGreaterThanOrEqual(fragment.start - 0.5)
      expect(lastWord.end).toBeLessThanOrEqual(fragment.end + 0.5)
    }
  })
})

describe('semanticSplitJa 統合: 親スパンが interpolated（firstCharIndex が null）の場合の分割断片按分', () => {
  // ASR側に全く一致しないテキストを持つオーバーロングユニットを、確定した前後アンカーの
  // 間に置く。全体アラインの結果このユニットは前後キューの時刻から按分される
  // 'interpolated'（firstCharIndex/lastCharIndex が null）になる。分割時にこのケースを
  // ASR文字インデックスでスライスできないため、文字数比按分にフォールバックすることを検証する。
  const anchorBeforeText = 'あ'.repeat(10)
  const anchorAfterText = 'い'.repeat(10)
  // ASRに存在しない40文字のテキスト（'あ'/'い' と一切重ならない漢字の繰り返し）。
  const unrelatedOverlongText = '無関係'.repeat(10)
  // アンカー間を埋める「発話はあるがキューのテキストと一致しない」ASR（LLMが大きく書き換えた区間の再現）。
  // ここにトークンを置かないと 5〜21秒が完全な無音になり、補間はその区間を配分対象にしない
  // （実データで304秒の休憩区間にキューが配置された不具合の修正による正しい挙動）。
  // このテストが検証したいのは「発話がある区間で対応が付かなかったキュー」の分割挙動なので、
  // 無音ではなく未一致の発話としてフィクスチャを組む。
  const unmatchedSpeechText = 'ゑ'.repeat(100)

  const segments: TranscriptSegment[] = [
    {
      id: 1,
      start: 0,
      end: 1,
      text: anchorBeforeText,
      words: [{ word: anchorBeforeText, start: 0, end: 1, score: 1 }],
    },
    {
      id: 2,
      start: 5,
      end: 15,
      text: unmatchedSpeechText,
      // 1単語にまとめると duration が 0.6秒でCAPされ（wordToChars 参照）100文字が
      // 5.0〜5.6秒に圧縮されてしまうため、0.1秒刻みの個別トークンとして与える。
      words: Array.from({ length: unmatchedSpeechText.length }, (_, i) => ({
        word: 'ゑ',
        start: 5 + i * 0.1,
        end: 5 + i * 0.1 + 0.08,
        score: 1,
      })),
    },
    {
      id: 3,
      start: 21,
      end: 22,
      text: anchorAfterText,
      words: [{ word: anchorAfterText, start: 21, end: 22, score: 1 }],
    },
  ]
  const { stream: asrStream, ranges: segmentRanges } = buildAsrCharStreamWithRanges(segments)
  const units = [
    makeRawUnit(1, anchorBeforeText, 'anchorBefore'),
    makeRawUnit(1, unrelatedOverlongText, 'mid'),
    makeRawUnit(3, anchorAfterText, 'anchorAfter'),
  ]

  it('前提: mid ユニットは interpolated（ASR実測にアンカーできない）で、閾値超過になる', () => {
    const noSplitThresholds: PipelineThresholds = { ...DEFAULT_PIPELINE_THRESHOLDS, mergedLongDurationSec: 300 }
    const aligned = __testing.alignUnitsGlobally(units, asrStream, segmentRanges, noSplitThresholds, []).units
    const mid = aligned.find(item => item.unit.unitId === 'mid')
    expect(mid).toBeDefined()
    expect(mid!.alignConf).toBe('no_words')
    expect(mid!.end - mid!.start).toBeGreaterThan(DEFAULT_PIPELINE_THRESHOLDS.mergedLongDurationSec)
  })

  it('分割後、断片は文字数比で按分され、親スパン内（アンカー間）に収まる', () => {
    const aligned = __testing.alignUnitsGlobally(units, asrStream, segmentRanges, DEFAULT_PIPELINE_THRESHOLDS, []).units
    const anchorBefore = aligned.find(item => item.unit.unitId === 'anchorBefore')
    const anchorAfter = aligned.find(item => item.unit.unitId === 'anchorAfter')
    const fragments = aligned.filter(item => item.unit.unitId.startsWith('mid_'))
    expect(fragments.length).toBeGreaterThan(1)

    for (const fragment of fragments) {
      expect(fragment.alignConf).toBe('no_words')
      expect(fragment.words).toHaveLength(0)
      expect(fragment.start).toBeGreaterThanOrEqual(anchorBefore!.end)
      expect(fragment.end).toBeLessThanOrEqual(anchorAfter!.start)
    }
    for (let i = 0; i < fragments.length - 1; i += 1) {
      expect(fragments[i].end).toBeLessThanOrEqual(fragments[i + 1].start)
    }
    // 元の40文字のテキストが失われていないこと。
    expect(fragments.map(f => f.unit.jaText).join('')).toBe(unrelatedOverlongText)
  })
})

describe('alignUnitsProportionalFallback: words を持たないセグメントのみのフォールバック', () => {
  const segments: CorrectedSegmentLite[] = [
    {
      id: 1,
      start: 10.0,
      end: 25.0,
      text: 'あいうえおかきくけこさしすせそ',
      correctedText: 'あいうえおかきくけこさしすせそ',
      correctionDistance: 0,
      correctionFlagged: false,
      // words を意図的に未設定にする（WhisperXアライメント総崩れを想定）
    },
    {
      id: 2,
      start: 25.0,
      end: 30.0,
      text: '短い発話',
      correctedText: '短い発話',
      correctionDistance: 0,
      correctionFlagged: false,
    },
  ]
  const units = [
    makeRawUnit(1, 'あいうえお', 'u1'),
    makeRawUnit(1, 'かきくけこさしすせそ', 'u2'),
    makeRawUnit(2, '短い発話', 'u3'),
  ]

  it('前提: このセグメント群からは ASR 文字ストリームが空になる', () => {
    expect(buildAsrCharStream(segments)).toHaveLength(0)
  })

  const aligned = __testing.alignUnitsProportionalFallback(units, segments, DEFAULT_PIPELINE_THRESHOLDS, [])
  const blocks = __testing.buildJaBlocks(aligned)

  it('全ブロックの alignConf が no_words になる', () => {
    expect(blocks).toHaveLength(3)
    for (const block of blocks) {
      expect(block.alignConf).toBe('no_words')
    }
  })

  it('各ブロックの時刻が対応するセグメント範囲内に収まる', () => {
    // u1, u2 はセグメント1(10.0-25.0)、u3 はセグメント2(25.0-30.0)の範囲内。
    expect(blocks[0].start).toBeGreaterThanOrEqual(10.0)
    expect(blocks[1].end).toBeLessThanOrEqual(25.0)
    expect(blocks[2].start).toBeGreaterThanOrEqual(25.0)
    expect(blocks[2].end).toBeLessThanOrEqual(30.0)
  })

  it('文字数比（5:10）でセグメント1内の境界が決まる', () => {
    // duration=15.0, 5文字:10文字 → 境界は 10 + 15*(5/15) = 15.0
    expect(blocks[0].end).toBeCloseTo(15.0, 5)
    expect(blocks[1].start).toBeCloseTo(15.0, 5)
  })
})

describe('resolveTranscriptScript: alignTokenMode による書きおこしトークン単位の決定', () => {
  // 日本語相当（1文字トークン中心）の入力。alignTokenMode: 'auto' なら detectAsrScriptDetail が
  // 'japanese' と判定するはずのデータで、'word' 設定が優先されることを確認する。
  const japaneseLikeSegments: CorrectedSegmentLite[] = [
    {
      id: 1,
      start: 0,
      end: 5,
      text: 'あいうえお',
      correctedText: 'あいうえお',
      correctionDistance: 0,
      correctionFlagged: false,
      words: Array.from('あいうえお', (char, i) => ({ word: char, start: i, end: i + 1 })),
    },
  ]

  it("alignTokenMode: 'word' を指定すると、日本語相当の入力でも単語単位(latin)が使われる（設定上書きが効く）", () => {
    const settings = { ...getDefaultAdminSettings(), alignTokenMode: 'word' as const }
    const resolution = __testing.resolveTranscriptScript(settings, japaneseLikeSegments)
    expect(resolution.script).toBe('latin')
    expect(resolution.source).toBe('setting_word')
  })

  it("alignTokenMode: 'char' を指定すると常に japanese になる", () => {
    const settings = { ...getDefaultAdminSettings(), alignTokenMode: 'char' as const }
    const resolution = __testing.resolveTranscriptScript(settings, japaneseLikeSegments)
    expect(resolution.script).toBe('japanese')
    expect(resolution.source).toBe('setting_char')
  })

  it("alignTokenMode: 'auto'（既定）では、日本語相当の入力から自動判定で japanese になる", () => {
    const settings = { ...getDefaultAdminSettings(), alignTokenMode: 'auto' as const }
    const resolution = __testing.resolveTranscriptScript(settings, japaneseLikeSegments)
    expect(resolution.script).toBe('japanese')
    expect(resolution.source).toBe('auto_detected')
  })

  it('判定に使えるトークンが0件のときのみ languageProfileConfig にフォールバックする', () => {
    const settings = { ...getDefaultAdminSettings(), alignTokenMode: 'auto' as const }
    const noWordsSegments: CorrectedSegmentLite[] = [
      { id: 1, start: 0, end: 5, text: 'あいうえお', correctedText: 'あいうえお', correctionDistance: 0, correctionFlagged: false },
    ]
    const resolution = __testing.resolveTranscriptScript(settings, noWordsSegments)
    expect(resolution.source).toBe('fallback_profile')
    expect(resolution.script).toBe('japanese')
  })
})

interface TestAlignedUnitInput {
  unitId?: string
  jaText: string
  start: number
  end: number
  alignConf?: 'exact' | 'no_words'
  words?: FixtureWord[]
  matchRate?: number
}

/**
 * `AlignedUnit`（semanticSplitJa.ts 内部型）と構造的に一致するテスト用フィクスチャ。
 * `AlignedUnit` は非公開型のため import せず、`__testing.resolveCollapsedUnits` の
 * パラメータ型との構造的互換性のみに依拠する。
 */
function makeAlignedUnit(input: TestAlignedUnitInput) {
  return {
    unit: {
      unitId: input.unitId ?? `u_${input.start}`,
      sourceSegmentId: 1,
      jaText: input.jaText,
      canMergeWithNext: false,
    },
    start: input.start,
    end: input.end,
    alignConf: input.alignConf ?? 'exact',
    words: input.words ?? [],
    matchRate: input.matchRate ?? 1,
  }
}

describe('isCollapsedUnit: 「物理的にあり得ないキュー」の判定（毎秒50文字を超える話速）', () => {
  it('正当な短いキュー（2文字, 0.3秒＝毎秒約6.7文字）は潰れていると判定されない（誤検知しない）', () => {
    const unit = makeAlignedUnit({ jaText: 'はい', start: 10, end: 10.3 })
    expect(__testing.isCollapsedUnit(unit)).toBe(false)
  })

  it('潰れたキュー（40文字, 0.06秒＝毎秒約667文字）は潰れていると判定される', () => {
    const unit = makeAlignedUnit({ jaText: 'あ'.repeat(40), start: 10, end: 10.06 })
    expect(__testing.isCollapsedUnit(unit)).toBe(true)
  })

  it('end <= start（duration<=0）は文字数によらず常に潰れていると判定される', () => {
    const unit = makeAlignedUnit({ jaText: 'あ', start: 10, end: 10 })
    expect(__testing.isCollapsedUnit(unit)).toBe(true)
  })
})

describe('resolveCollapsedUnits: 潰れたキューを隣へ統合する', () => {
  it('潰れたキューは結果から消え、その本文が隣（信頼度の高い側）のキューに統合される', () => {
    const prev = makeAlignedUnit({
      unitId: 'prev',
      jaText: '前の文です。',
      start: 0,
      end: 1,
      alignConf: 'exact',
      words: [{ word: '前の文です。', start: 0, end: 1, score: 1 }],
    })
    const collapsed = makeAlignedUnit({
      unitId: 'collapsed',
      jaText: '潰れて範囲を失った本文'.repeat(4), // 44文字
      start: 1,
      end: 1.06,
      alignConf: 'exact',
      words: [{ word: '潰れ', start: 1, end: 1.06, score: 1 }],
    })
    const next = makeAlignedUnit({ unitId: 'next', jaText: '後の文です。', start: 1.06, end: 2, alignConf: 'no_words' })

    const { units, collapsedMerged } = __testing.resolveCollapsedUnits([prev, collapsed, next])

    expect(units.map(u => u.unit.unitId)).toEqual(['prev', 'next'])
    expect(collapsedMerged).toBe(1)
    const mergedPrev = units.find(u => u.unit.unitId === 'prev')!
    // 前へ統合する場合は本文の末尾に追加する。
    expect(mergedPrev.unit.jaText).toBe(prev.unit.jaText + collapsed.unit.jaText)
    // 時刻は統合先（prev）のものをそのまま使う。
    expect(mergedPrev.start).toBe(prev.start)
    expect(mergedPrev.end).toBe(prev.end)
    // words も統合元の words を引き継ぐ。
    expect(mergedPrev.words.length).toBe(prev.words.length + collapsed.words.length)
  })

  it('統合の前後で全キューの本文を連結した文字列が一致する（本文が失われないことの担保。連続する潰れたキューも含む）', () => {
    const a = makeAlignedUnit({ unitId: 'a', jaText: 'あああ', start: 0, end: 1, alignConf: 'exact' })
    // 連続する2件の潰れたキュー（どちらも前後アンカーが exact でタイ → 前(a)へ統合される）。
    const b = makeAlignedUnit({ unitId: 'b', jaText: '潰れ本文いち'.repeat(4), start: 1, end: 1.05, alignConf: 'no_words' })
    const c = makeAlignedUnit({ unitId: 'c', jaText: '潰れ本文にい'.repeat(4), start: 1.05, end: 1.09, alignConf: 'no_words' })
    const d = makeAlignedUnit({ unitId: 'd', jaText: 'いいい', start: 1.09, end: 2, alignConf: 'exact' })
    const original = [a, b, c, d]

    // 前提: b, c は実際に潰れている。
    expect(__testing.isCollapsedUnit(b)).toBe(true)
    expect(__testing.isCollapsedUnit(c)).toBe(true)

    const originalConcat = original.map(u => u.unit.jaText).join('')
    const { units, collapsedMerged } = __testing.resolveCollapsedUnits(original)
    const resultConcat = units.map(u => u.unit.jaText).join('')

    expect(collapsedMerged).toBe(2)
    expect(resultConcat).toBe(originalConcat)
  })

  it('前後の alignConf 信頼度に応じて統合先が選ばれる（exact を優先し、後ろへ統合する場合は本文の先頭に追加する）', () => {
    const prevNoWords = makeAlignedUnit({ unitId: 'prev', jaText: '前', start: 0, end: 1, alignConf: 'no_words' })
    const collapsed = makeAlignedUnit({ unitId: 'mid', jaText: '潰れ本文'.repeat(10), start: 1, end: 1.05, alignConf: 'no_words' })
    const nextExact = makeAlignedUnit({ unitId: 'next', jaText: '後', start: 1.05, end: 2, alignConf: 'exact' })

    const { units } = __testing.resolveCollapsedUnits([prevNoWords, collapsed, nextExact])

    expect(units.map(u => u.unit.unitId)).toEqual(['prev', 'next'])
    const mergedNext = units.find(u => u.unit.unitId === 'next')!
    expect(mergedNext.unit.jaText).toBe(collapsed.unit.jaText + nextExact.unit.jaText)
    expect(mergedNext.start).toBe(nextExact.start)
    expect(mergedNext.end).toBe(nextExact.end)
  })

  it('前後の alignConf が同順位（同じ exact）なら前を選ぶ（読み順を保つ）', () => {
    const prevExact = makeAlignedUnit({ unitId: 'prev', jaText: '前', start: 0, end: 1, alignConf: 'exact' })
    const collapsed = makeAlignedUnit({ unitId: 'mid', jaText: '潰れ本文'.repeat(10), start: 1, end: 1.05, alignConf: 'no_words' })
    const nextExact = makeAlignedUnit({ unitId: 'next', jaText: '後', start: 1.05, end: 2, alignConf: 'exact' })

    const { units } = __testing.resolveCollapsedUnits([prevExact, collapsed, nextExact])

    expect(units.map(u => u.unit.unitId)).toEqual(['prev', 'next'])
    const mergedPrev = units.find(u => u.unit.unitId === 'prev')!
    expect(mergedPrev.unit.jaText).toBe(prevExact.unit.jaText + collapsed.unit.jaText)
  })

  it('隣が1つも無い場合（ユニットが1件のみ等）は統合されずそのまま残る（本文を失わないことを最優先する）', () => {
    const onlyUnit = makeAlignedUnit({ unitId: 'solo', jaText: '潰れ本文'.repeat(10), start: 0, end: 0.05, alignConf: 'no_words' })
    expect(__testing.isCollapsedUnit(onlyUnit)).toBe(true)

    const { units, collapsedMerged } = __testing.resolveCollapsedUnits([onlyUnit])

    expect(units).toHaveLength(1)
    expect(units[0].unit.jaText).toBe(onlyUnit.unit.jaText)
    expect(collapsedMerged).toBe(0)
  })

  it('潰れたキューが1件も無ければ何も変わらず、統合件数は0件になる', () => {
    const a = makeAlignedUnit({ unitId: 'a', jaText: 'あああ', start: 0, end: 1 })
    const b = makeAlignedUnit({ unitId: 'b', jaText: 'いいい', start: 1, end: 2 })

    const { units, collapsedMerged } = __testing.resolveCollapsedUnits([a, b])

    expect(units.map(u => u.unit.unitId)).toEqual(['a', 'b'])
    expect(collapsedMerged).toBe(0)
  })
})

describe('semanticSplitJa: 探索範囲を由来セグメント±1に限定する', () => {
  // 実測（117分・788ユニット）で 99.7% が由来セグメント1つに収まり、跨ぐのは隣接2つまで
  // （3セグメント以上に跨る例はゼロ）。したがって探索範囲を由来セグメント±1に限定できる。
  // 全体探索では「同じ言い回しが講義中に何度も出る」ことで遠方へ誤マッチしていた。
  const repeated = 'こちらをご覧ください'

  /** 1文字0.1秒のトークン列を持つセグメントを作る（0.6秒CAPを避けるため個別トークンにする）。 */
  function makeWordSegment(id: number, text: string, startSec: number): TranscriptSegment {
    return {
      id,
      start: startSec,
      end: startSec + text.length * 0.1,
      text,
      words: Array.from({ length: text.length }, (_, i) => ({
        word: text[i],
        start: startSec + i * 0.1,
        end: startSec + i * 0.1 + 0.08,
        score: 1,
      })),
    }
  }

  it('同じ文字列が遠方の別セグメントにもある場合でも、由来セグメント側に対応付けられる', () => {
    // セグメント1（0秒付近）とセグメント9（3000秒付近）に全く同じ文字列を置く。
    const segments = [
      makeWordSegment(1, repeated, 0),
      makeWordSegment(2, 'つぎのはなしにうつります', 30),
      makeWordSegment(9, repeated, 3000),
    ]
    const { stream, ranges } = buildAsrCharStreamWithRanges(segments)
    const units = [makeRawUnit(9, repeated, 'far')]

    const aligned = __testing.alignUnitsGlobally(units, stream, ranges, DEFAULT_PIPELINE_THRESHOLDS, []).units

    // 由来セグメント9（3000秒付近）に対応付けられ、冒頭（0秒付近）へは飛ばない。
    expect(aligned[0].start).toBeGreaterThanOrEqual(2999)
    expect(aligned[0].start).toBeLessThan(3002)
  })

  it('セグメント間に長い無音があっても、その無音を跨いで配置されない', () => {
    // セグメント1（0〜1秒）とセグメント2（300秒〜）の間に約299秒の無音がある。
    const segments = [
      makeWordSegment(1, 'ぜんはんのはなし', 0),
      makeWordSegment(2, 'こうはんのはなし', 300),
    ]
    const { stream, ranges } = buildAsrCharStreamWithRanges(segments)
    // ASRに一致しない本文（対応が付かず補間になる）を、セグメント1のユニットとして与える。
    const units = [
      makeRawUnit(1, 'ぜんはんのはなし', 'u1'),
      makeRawUnit(1, '無関係無関係無関係', 'u2'),
    ]

    const aligned = __testing.alignUnitsGlobally(units, stream, ranges, DEFAULT_PIPELINE_THRESHOLDS, []).units

    // 無音（約1〜300秒）に引き伸ばされていないこと。
    for (const item of aligned) {
      expect(item.end - item.start).toBeLessThan(30)
    }
  })

  it('sourceSegmentId が存在しない値でも、最も近いセグメントへ丸められて処理が続く', () => {
    const segments = [makeWordSegment(10, 'じっさいのほんぶん', 0)]
    const { stream, ranges } = buildAsrCharStreamWithRanges(segments)
    const units = [makeRawUnit(999, 'じっさいのほんぶん', 'unknown')]

    const result = __testing.alignUnitsGlobally(units, stream, ranges, DEFAULT_PIPELINE_THRESHOLDS, [])

    expect(result.units).toHaveLength(1)
    expect(result.clampedSegmentIds).toBeGreaterThan(0)
    expect(result.units[0].start).toBeLessThan(2)
  })

  it('グループ境界で重なった場合、後ろのユニットが押し出され前は動かない', () => {
    const segments = [
      makeWordSegment(1, 'まえのせぐめんと', 0),
      makeWordSegment(2, 'あとのせぐめんと', 1),
    ]
    const { stream, ranges } = buildAsrCharStreamWithRanges(segments)
    const units = [
      makeRawUnit(1, 'まえのせぐめんと', 'a'),
      makeRawUnit(2, 'あとのせぐめんと', 'b'),
    ]

    const aligned = __testing.alignUnitsGlobally(units, stream, ranges, DEFAULT_PIPELINE_THRESHOLDS, []).units

    expect(aligned[0].end).toBeLessThanOrEqual(aligned[1].start)
  })
})

interface SilenceSpanFixture {
  description: string
  segments: Array<FixtureSegment & { correctedText: string }>
}

/**
 * 無音を内部に含むセグメントの実データ（seg181/182/183、4383.17-4462.38秒）。
 * seg182 はクランプ後のASR文字ストリーム上で 4420.63-4422.21（1.58秒）の無音を含む。
 */
function loadSilenceSpanFixture(): SilenceSpanFixture {
  const path = `${process.cwd()}/src/lib/pipeline/__fixtures__/semanticSplitJa.silenceSpan.json`
  return JSON.parse(readFileSync(path, 'utf-8')) as SilenceSpanFixture
}

/**
 * ASR文字ストリームの索引範囲 [fromIdx, toIdx] を、無音境界で区切った発話ラン
 * （実際に声が出ている時間区間）の配列にする。
 */
function speechRuns(
  asrStream: readonly { start: number; end: number }[],
  silenceAfter: ReadonlySet<number>,
  fromIdx: number,
  toIdx: number,
): Array<{ start: number; end: number }> {
  const runs: Array<{ start: number; end: number }> = []
  let runStart = fromIdx
  for (let i = fromIdx; i <= toIdx; i += 1) {
    if (i === toIdx || silenceAfter.has(i)) {
      runs.push({ start: asrStream[runStart].start, end: asrStream[i].end })
      runStart = i + 1
    }
  }
  return runs
}

/** 発話ラン run のうち、どのキューのスパンにも覆われていない秒数。*/
function uncoveredSec(
  run: { start: number; end: number },
  spans: ReadonlyArray<{ start: number; end: number }>,
): number {
  const covered = spans
    .map(span => ({ start: Math.max(span.start, run.start), end: Math.min(span.end, run.end) }))
    .filter(part => part.end > part.start)
    .sort((a, b) => a.start - b.start)
  let total = 0
  let cursor = run.start
  for (const part of covered) {
    if (part.start > cursor) total += part.start - cursor
    cursor = Math.max(cursor, part.end)
  }
  return total + Math.max(0, run.end - cursor)
}

describe('semanticSplitJa: 無音を跨ぐユニットは切り詰めず分割する（実データフィクスチャ）', () => {
  const fixture = loadSilenceSpanFixture()
  const segments: TranscriptSegment[] = fixture.segments.map(segment => ({
    id: segment.id,
    start: segment.start,
    end: segment.end,
    text: segment.text,
    words: segment.words,
  }))
  const { stream: asrStream, ranges: segmentRanges } = buildAsrCharStreamWithRanges(segments)
  // duration超過による分割（別欠陥）を無効化し、「発話を覆えていない」ことだけを
  // 分割の契機として検証する。
  const noOverlongSplit: PipelineThresholds = { ...DEFAULT_PIPELINE_THRESHOLDS, mergedLongDurationSec: 300 }

  // 実運用と同じ状況: 補正LLMの分割カバレッジが不足し、セグメント全文が1ユニットになる。
  const units = fixture.segments.map(segment =>
    makeRawUnit(segment.id, segment.correctedText, `u_fallback_${segment.id}`))

  it('前提: seg182 のASR範囲は内部に無音を1つ含む', () => {
    const range = segmentRanges.find(r => r.segmentId === 182)!
    const silenceAfter = findSilenceBoundaries(asrStream)
    const runs = speechRuns(asrStream, silenceAfter, range.startIdx, range.endIdx)

    expect(runs).toHaveLength(2)
    expect(runs[0].end).toBeCloseTo(4420.63, 1)
    expect(runs[1].start).toBeCloseTo(4422.21, 1)
    expect(runs[1].end).toBeCloseTo(4432.09, 1)
  })

  it('seg182 の発話区間は、そのセグメント由来のキューで漏れなく覆われる', () => {
    const result = __testing.alignUnitsGlobally(units, asrStream, segmentRanges, noOverlongSplit, [])
    const range = segmentRanges.find(r => r.segmentId === 182)!
    const silenceAfter = findSilenceBoundaries(asrStream)
    const runs = speechRuns(asrStream, silenceAfter, range.startIdx, range.endIdx)
    const spans = result.units
      .filter(unit => unit.unit.sourceSegmentId === 182)
      .map(unit => ({ start: unit.start, end: unit.end }))

    // 実測（修正前）: 後半ラン 4422.21-4432.09 の 9.88秒が丸ごと無字幕になる。
    for (const run of runs) {
      expect(uncoveredSec(run, spans)).toBeLessThan(1.0)
    }
  })

  it('無音を跨ぐユニットは2つ以上のキューに分割され、本文は失われない', () => {
    const result = __testing.alignUnitsGlobally(units, asrStream, segmentRanges, noOverlongSplit, [])
    const seg182Units = result.units.filter(unit => unit.unit.sourceSegmentId === 182)

    expect(seg182Units.length).toBeGreaterThanOrEqual(2)
    const joined = seg182Units.map(unit => unit.unit.jaText).join('')
    expect(joined).toBe(fixture.segments.find(segment => segment.id === 182)!.correctedText)
  })

  it('分割後のどのキューも無音区間を跨がない（既存の不変条件を壊さない）', () => {
    const result = __testing.alignUnitsGlobally(units, asrStream, segmentRanges, noOverlongSplit, [])
    const silenceAfter = findSilenceBoundaries(asrStream)
    const silences = [...silenceAfter].map(i => ({ start: asrStream[i].end, end: asrStream[i + 1].start }))

    for (const unit of result.units) {
      for (const silence of silences) {
        const overlap = Math.min(unit.end, silence.end) - Math.max(unit.start, silence.start)
        expect(overlap).toBeLessThan(0.5)
      }
    }
  })
})
