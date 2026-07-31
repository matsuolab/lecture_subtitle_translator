import { describe, expect, it } from 'vitest'
import { alignCuesToAsr, buildAsrCharStream, detectAsrScript, detectAsrScriptDetail, __testing } from './asrAlignment'
import type { AsrChar } from './asrAlignment'
import type { TranscriptSegment } from './types'

declare const require: (id: string) => { readFileSync: (p: string, e: string) => string }
declare const process: { cwd: () => string }
const { readFileSync } = require('fs')

/**
 * asrAlignment.ts のテスト。
 *
 * ゴール: セグメント境界に縛られず、ASR文字ストリーム全体に対する diff ベースの
 * 大域アライメントで各キューの時刻を求められること。特に「セグメント跨ぎの融合」
 * （補正LLMが2つのWhisperXセグメントに跨る文を再構成するケース）で、現行の
 * semanticSplitJa.ts（27秒窓の文字数比例配分にフォールバックする）より大幅に
 * 正確な時刻が得られることを実データフィクスチャで検証する。
 */

function makeChar(char: string, start: number, end: number, score = 1): AsrChar {
  return { char, start, end, score }
}

// asrAlignment.ts の MIN_SPAN_SEC（非公開定数）と同じ値。借用後に直前/直後キューへ
// 最低限残るべき幅を検証するテストで使う（値そのものはモジュール側の定義が正）。
const MIN_SPAN_SEC_FOR_TEST = 0.05

interface FixtureWord {
  word: string
  start: number
  end: number
  score: number
}

interface FixtureSegment {
  id: number
  start: number
  end: number
  text: string
  words: FixtureWord[]
}

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

describe('buildAsrCharStream', () => {
  it('単語を1文字ごとに線形補間して展開する', () => {
    const segments: TranscriptSegment[] = [
      {
        id: 1,
        start: 0,
        end: 2,
        text: 'ABCD',
        words: [{ word: 'AB', start: 0, end: 1 }, { word: 'CD', start: 1, end: 2 }],
      },
    ]
    // このテストは「線形補間そのもの」を検証したいので、単語duration(1s)がCAPの
    // デフォルト(0.6s)で切られないよう maxWordDurationSec を明示的に緩めている。
    // CAPそのものの挙動は下の「単語durationのCAP」describeで検証する。
    const chars = buildAsrCharStream(segments, { maxWordDurationSec: 1 })
    expect(chars.map(c => c.char)).toEqual(['A', 'B', 'C', 'D'])
    expect(chars[0]).toEqual({ char: 'A', start: 0, end: 0.5, score: 1 })
    expect(chars[1]).toEqual({ char: 'B', start: 0.5, end: 1, score: 1 })
  })

  it('start/end が有限でない単語はスキップする', () => {
    const segments: TranscriptSegment[] = [
      {
        id: 1,
        start: 0,
        end: 2,
        text: 'AB',
        words: [
          { word: 'A', start: 0, end: 1 },
          { word: 'B', start: Number.NaN, end: 2 },
        ],
      },
    ]
    const chars = buildAsrCharStream(segments)
    expect(chars.map(c => c.char)).toEqual(['A'])
  })

  it('句読点や空白は正規化で除去され文字ストリームに含まれない', () => {
    const segments: TranscriptSegment[] = [
      { id: 1, start: 0, end: 1, text: '。', words: [{ word: '。', start: 0, end: 1 }] },
    ]
    expect(buildAsrCharStream(segments)).toEqual([])
  })

  describe('単語durationのCAP（maxWordDurationSec）', () => {
    it('デフォルトCAP(0.6s): 膨張した単語(1文字, start=10, end=18)はend=10.6に切られる', () => {
      const segments: TranscriptSegment[] = [
        { id: 1, start: 10, end: 18, text: 'あ', words: [{ word: 'あ', start: 10, end: 18 }] },
      ]
      const chars = buildAsrCharStream(segments)
      expect(chars).toHaveLength(1)
      expect(chars[0].start).toBeCloseTo(10, 5)
      expect(chars[0].end).toBeCloseTo(10.6, 5)
    })

    it('CAP未満の単語(duration=0.3s)はCAPの影響を受けず不変', () => {
      const segments: TranscriptSegment[] = [
        { id: 1, start: 5, end: 5.3, text: 'あ', words: [{ word: 'あ', start: 5, end: 5.3 }] },
      ]
      const chars = buildAsrCharStream(segments)
      expect(chars).toHaveLength(1)
      expect(chars[0].start).toBeCloseTo(5, 5)
      expect(chars[0].end).toBeCloseTo(5.3, 5)
    })

    it('複数文字の単語がCAPされる場合、CAP後のendまでを文字数で線形補間する', () => {
      // 'あい'(2文字), start=0, end=8 → effectiveEnd=0.6 → 1文字あたり0.3s
      const segments: TranscriptSegment[] = [
        { id: 1, start: 0, end: 8, text: 'あい', words: [{ word: 'あい', start: 0, end: 8 }] },
      ]
      const chars = buildAsrCharStream(segments)
      expect(chars).toHaveLength(2)
      expect(chars[0]).toEqual(expect.objectContaining({ char: 'あ', start: 0, end: 0.3 }))
      expect(chars[1]).toEqual(expect.objectContaining({ char: 'い', start: 0.3, end: 0.6 }))
    })

    it('オプションでCAPを変更できる（maxWordDurationSec=2）', () => {
      const segments: TranscriptSegment[] = [
        { id: 1, start: 10, end: 18, text: 'あ', words: [{ word: 'あ', start: 10, end: 18 }] },
      ]
      const chars = buildAsrCharStream(segments, { maxWordDurationSec: 2 })
      expect(chars).toHaveLength(1)
      expect(chars[0].start).toBeCloseTo(10, 5)
      expect(chars[0].end).toBeCloseTo(12, 5)
    })

    it('word.start は変更しない（CAPはendのみに適用される）', () => {
      const segments: TranscriptSegment[] = [
        {
          id: 1,
          start: 0,
          end: 20,
          text: 'あい',
          words: [
            { word: 'あ', start: 0, end: 0.1 },
            { word: 'い', start: 10, end: 18 },
          ],
        },
      ]
      const chars = buildAsrCharStream(segments)
      expect(chars[1].start).toBeCloseTo(10, 5)
      expect(chars[1].end).toBeCloseTo(10.6, 5)
    })
  })
})

describe('alignCuesToAsr 基本ケース', () => {
  it('1. 完全一致: 包絡がASRの時刻と一致し confidence は exact', () => {
    const asr: AsrChar[] = Array.from('これはテストです').map((char, i) => makeChar(char, i, i + 1))
    const spans = alignCuesToAsr(['これはテストです'], asr)

    expect(spans).toHaveLength(1)
    expect(spans[0].startSec).toBeCloseTo(0, 5)
    expect(spans[0].endSec).toBeCloseTo(8, 5)
    expect(spans[0].confidence).toBe('exact')
    expect(spans[0].matchRate).toBeCloseTo(1, 5)
  })

  it('2. 軽微な書き換え: 句読点追加・語尾変更でも包絡はほぼ元の時刻のまま', () => {
    // ASR原文: 「これはテストです」→ 補正後キュー: 「これはテストでした。」（語尾変更+句読点追加）
    const asr: AsrChar[] = Array.from('これはテストです').map((char, i) => makeChar(char, i, i + 1))
    const spans = alignCuesToAsr(['これはテストでした。'], asr)

    expect(spans).toHaveLength(1)
    // 先頭「これはテスト」までは完全一致するので start は 0 のまま。
    expect(spans[0].startSec).toBeCloseTo(0, 5)
    // 末尾「です」→「でした」で不一致が増えるが、一致した文字の範囲internal（0-7）は保たれる。
    expect(spans[0].endSec).toBeGreaterThanOrEqual(6)
    expect(spans[0].endSec).toBeLessThanOrEqual(8)
    expect(['exact', 'partial']).toContain(spans[0].confidence)
  })

  it('4. 繰り返しフレーズ: 同一フレーズが離れて2回出現し、後方の出現に正しく対応する', () => {
    // ASR: 「犬が吠えた」(t=0-5) + 「そしてまた」(t=5-10) + 「犬が吠えた」(t=10-15) + 「静かになった」(t=15-21)
    // cue1「そしてまた」（5文字。4文字未満だと最低文字数フロアでinterpolated扱いになるため5文字にしている）
    // cue2は繰り返しフレーズ本体。後方(t=10-15)の出現に対応するべき。
    const text = '犬が吠えたそしてまた犬が吠えた静かになった'
    const asr: AsrChar[] = Array.from(text).map((char, i) => makeChar(char, i, i + 1))
    const spans = alignCuesToAsr(['そしてまた', '犬が吠えた'], asr)

    expect(spans).toHaveLength(2)
    expect(spans[0].startSec).toBeCloseTo(5, 5)
    expect(spans[0].endSec).toBeCloseTo(10, 5)
    // バグがあれば前方(t=0-5)に誤対応する。後方(t=10-15)であることを確認する。
    expect(spans[1].startSec).toBeCloseTo(10, 5)
    expect(spans[1].endSec).toBeCloseTo(15, 5)
  })

  it('5. 一致不能: ASRに全く無いテキストは interpolated になり、前後キューの間に収まる', () => {
    const asr: AsrChar[] = Array.from('あいうえおかきくけこ').map((char, i) => makeChar(char, i, i + 1))
    const spans = alignCuesToAsr(['あいうえお', 'ゼンゼンチガウテキスト', 'かきくけこ'], asr)

    expect(spans).toHaveLength(3)
    expect(spans[0].confidence).not.toBe('interpolated')
    expect(spans[2].confidence).not.toBe('interpolated')
    expect(spans[1].confidence).toBe('interpolated')
    // 前後の確定済みキューの間（[5,5]の実質1点だが、境界を跨がない）に収まる。
    expect(spans[1].startSec).toBeGreaterThanOrEqual(spans[0].endSec)
    expect(spans[1].endSec).toBeLessThanOrEqual(spans[2].startSec)
  })

  it('6. 単調性: 複数キューの結果に重なりが無い', () => {
    const text = 'これはテストの文章です次にもう一つの文章が続きますさらに三つ目の文章もあります'
    const asr: AsrChar[] = Array.from(text).map((char, i) => makeChar(char, i, i + 1))
    const spans = alignCuesToAsr(
      ['これはテストの文章です', '次にもう一つの文章が続きます', 'さらに三つ目の文章もあります'],
      asr,
    )

    expect(spans).toHaveLength(3)
    for (let i = 0; i < spans.length - 1; i += 1) {
      expect(spans[i].endSec).toBeLessThanOrEqual(spans[i + 1].startSec)
    }
  })

  it('打ち切り安全弁: maxEditLength を極小にすると打ち切られ interpolated にフォールバックする', () => {
    // ASRとキューが共通文字を持たない（＝編集距離が非常に大きい）設定にして、
    // maxEditLength超過による打ち切り(diffChars が undefined を返す経路)を確実に踏ませる。
    const text = 'あ'.repeat(80)
    const asr: AsrChar[] = Array.from(text).map((char, i) => makeChar(char, i, i + 1))
    const spans = alignCuesToAsr(['犬猫鳥', '馬牛豚', '花月山'], asr, { maxEditLength: 5 })

    expect(spans).toHaveLength(3)
    for (const span of spans) {
      expect(span.confidence).toBe('interpolated')
      expect(span.matchedChars).toBe(0)
    }
    // 打ち切られても全体のASR範囲(0-80)に収まり、クラッシュしないこと。
    expect(spans[0].startSec).toBeGreaterThanOrEqual(0)
    expect(spans[spans.length - 1].endSec).toBeLessThanOrEqual(text.length)
  })

  it('ASR側の単語が丸ごと欠損している場合、マッチした範囲だけに包絡が絞られる（前倒し/後ろ倒しの誤爆をしない）', () => {
    // 旧実装(alignUnitsOnce)は「セグメント内で単語が1つでも脱落すると、境界探索が
    // 巻き戻ってキュー全体の時刻がずれる」バグを持っていた（timingFidelity参照）。
    // 新実装はキュー単位ではなくASR文字ストリーム全体に対してdiffするため、
    // 一部の単語がASR側に無くても、マッチした残りの文字だけで妥当な包絡が求まる。
    const asr: AsrChar[] = Array.from('これはテストの').map((char, i) => makeChar(char, i, i + 1))
    const spans = alignCuesToAsr(['これはテストの文章です'], asr)

    expect(spans).toHaveLength(1)
    // ASRが「これはテストの」までしか無いため、包絡はASR範囲(0-7)を超えない。
    expect(spans[0].startSec).toBeCloseTo(0, 5)
    expect(spans[0].endSec).toBeLessThanOrEqual(7)
    // 一致率が下がるため 'exact' には誤判定されない。
    expect(spans[0].confidence).not.toBe('exact')
    expect(spans[0].matchRate).toBeLessThan(1)
  })

  it('窓処理: windowChars を小さくしても複数窓に跨って正しく対応できる', () => {
    // 400文字超のASRを windowChars=50 で処理させ、後方のキューが正しい時刻に対応することを確認する。
    const filler = 'ん'.repeat(60)
    const target = '目印テキスト'
    const text = filler + target + filler
    const asr: AsrChar[] = Array.from(text).map((char, i) => makeChar(char, i, i + 1))
    const spans = alignCuesToAsr([target], asr, { windowChars: 50, windowMarginChars: 20 })

    expect(spans).toHaveLength(1)
    expect(spans[0].startSec).toBeCloseTo(60, 5)
    expect(spans[0].endSec).toBeCloseTo(66, 5)
  })

  it('空配列・空ASRでもクラッシュしない', () => {
    expect(alignCuesToAsr([], [])).toEqual([])
    expect(alignCuesToAsr(['テキスト'], [])).toHaveLength(1)
    expect(alignCuesToAsr(['テキスト'], [])[0].confidence).toBe('interpolated')
  })
})

describe('AlignedSpan.firstCharIndex / lastCharIndex', () => {
  it('完全一致: マッチしたASR文字の全区間を指す（0 〜 length-1）', () => {
    const text = 'これはテストです'
    const asr: AsrChar[] = Array.from(text).map((char, i) => makeChar(char, i, i + 1))
    const [span] = alignCuesToAsr([text], asr)

    expect(span.confidence).toBe('exact')
    expect(span.firstCharIndex).toBe(0)
    expect(span.lastCharIndex).toBe(asr.length - 1)
  })

  it('interpolated: ASR実測に対応しないため null になる', () => {
    const asr: AsrChar[] = Array.from('あいうえおかきくけこ').map((char, i) => makeChar(char, i, i + 1))
    const spans = alignCuesToAsr(['あいうえお', 'ゼンゼンチガウテキスト', 'かきくけこ'], asr)

    expect(spans[1].confidence).toBe('interpolated')
    expect(spans[1].firstCharIndex).toBeNull()
    expect(spans[1].lastCharIndex).toBeNull()
  })

  it('interpolated 以外（exact/partial）では null にならず、範囲を asr.slice でそのまま復元できる', () => {
    // 「これはテストです」→「これはテストでした。」（語尾変更）: 先頭側は完全一致するため
    // firstCharIndex は 0 になり、asr[firstCharIndex] は先頭文字と一致する。
    const asr: AsrChar[] = Array.from('これはテストです').map((char, i) => makeChar(char, i, i + 1))
    const [span] = alignCuesToAsr(['これはテストでした。'], asr)

    expect(span.confidence).not.toBe('interpolated')
    expect(span.firstCharIndex).not.toBeNull()
    expect(span.lastCharIndex).not.toBeNull()
    const sliced = asr.slice(span.firstCharIndex as number, (span.lastCharIndex as number) + 1)
    expect(sliced[0].char).toBe('こ')
    expect(sliced[0].start).toBeCloseTo(span.startSec, 5)
    expect(sliced[sliced.length - 1].end).toBeCloseTo(span.endSec, 5)
  })

  it('セグメント跨ぎの実データフィクスチャでも firstCharIndex/lastCharIndex から words を復元できる', () => {
    const segments = loadSeg6Seg7Fixture()
    const asr = buildAsrCharStream(segments)
    const [span] = alignCuesToAsr(['講座の受講料は無料です。'], asr)

    expect(span.confidence).toBe('exact')
    expect(span.firstCharIndex).not.toBeNull()
    expect(span.lastCharIndex).not.toBeNull()
    const words = asr
      .slice(span.firstCharIndex as number, (span.lastCharIndex as number) + 1)
      .map(c => ({ word: c.char, start: c.start, end: c.end, score: c.score }))
    expect(words.length).toBeGreaterThan(0)
    expect(words[0].start).toBeCloseTo(span.startSec, 5)
    expect(words[words.length - 1].end).toBeCloseTo(span.endSec, 5)
  })
})

describe('__testing.trimEnvelopeByScore', () => {
  it('端の文字が低スコアなら内側へ寄せる', () => {
    const asr: AsrChar[] = [
      makeChar('A', 0, 1, 0.1),
      makeChar('B', 1, 2, 0.9),
      makeChar('C', 2, 3, 0.9),
      makeChar('D', 3, 4, 0.05),
    ]
    expect(__testing.trimEnvelopeByScore(asr, 0, 3)).toEqual([1, 2])
  })

  it('全部低スコアなら元のまま', () => {
    const asr: AsrChar[] = [makeChar('A', 0, 1, 0.1), makeChar('B', 1, 2, 0.1)]
    expect(__testing.trimEnvelopeByScore(asr, 0, 1)).toEqual([0, 1])
  })

  it('修正1: 低スコアが大半を占めていても、削れる量は上限（左右合計50%）で止まり包絡が潰れない', () => {
    // 実測(Inside Anthropicのキュー id=350, 10文字)を模す: 一致範囲10文字のうち9文字が
    // LOW_SCORE_THRESHOLD(0.2)未満で、上限が無い実装だと単一の高スコア文字(index8)にまで
    // 潰れてしまう（旧実装では0.04秒相当まで潰れ、12.21秒あった包絡を失っていた）。
    const scores = [0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.9, 0.1]
    const asr: AsrChar[] = scores.map((score, i) => makeChar('x', i, i + 1, score))

    const [left, right] = __testing.trimEnvelopeByScore(asr, 0, 9)

    // 上限（片側 floor(10*0.25)=2文字）で止まるため、range長10のうち左2・右1文字しか
    // 削れず、7文字（70%）残る。上限が無ければ [8,8] （10%）まで潰れていた。
    expect(left).toBe(2)
    expect(right).toBe(8)
    expect(right - left + 1).toBeGreaterThanOrEqual(5) // 50%以上残ること
  })
})

describe('外れ値ガード（buildProvisionalSpans: 逆行除去・かたまり分割・包絡伸長）', () => {
  it('1. キュー末尾の数文字が遠方の同じ文字列にマッチしても、包絡は主かたまりだけで決まり膨張しない', () => {
    // 実データで観測された「55文字のうち53文字が正しく連続し、2文字だけが150秒以上
    // 手前へ飛んでいた」ケースを模す。cue1文字(55文字)のうち先頭53文字はASR上の
    // asrIndex 100-152 に正しく連続対応し、末尾2文字(cueCharIndex 53,54)だけが
    // 遠方の asrIndex 10,11（同じ短いフレーズの別出現）に誤対応している。
    const asr: AsrChar[] = Array.from({ length: 200 }, (_, i) => makeChar('x', i, i + 1))
    const globalMatches = new Map<number, number>()
    for (let k = 0; k < 53; k += 1) globalMatches.set(k, 100 + k)
    globalMatches.set(53, 10)
    globalMatches.set(54, 11)
    const cueBounds = [{ start: 0, end: 55 }]

    const [info] = __testing.buildProvisionalSpans(asr, cueBounds, globalMatches)

    // 主かたまり(53文字, asrIndex100-152)だけが採用され、遠方の2文字は捨てられる。
    expect(info.matchedChars).toBe(53)
    expect(info.firstCharIndex).toBe(100)
    // 末尾2文字は未対応文字として扱われ伸長対象になるが、遠方(10,11)へ引っ張られない。
    expect(info.lastCharIndex).toBeGreaterThanOrEqual(152)
    expect(info.lastCharIndex).toBeLessThan(160)
    expect(info.startSec).toBeCloseTo(100, 5)
    expect(info.endSec).toBeLessThan(160)
  })

  it('2a. 逆行するマッチが混じっても最長非減少部分列が正しく選ばれる（先頭が外れ値のケース）', () => {
    // 貪欲法（直前より小さい値を捨てる）だと先頭の外れ値(asrIndex=500)のせいで
    // 後続の正しい対応(10,11,12,13)を全部「直前より小さい」として捨ててしまう。
    const pairs = [
      { cueCharIndex: 0, asrIndex: 500 },
      { cueCharIndex: 1, asrIndex: 10 },
      { cueCharIndex: 2, asrIndex: 11 },
      { cueCharIndex: 3, asrIndex: 12 },
      { cueCharIndex: 4, asrIndex: 13 },
    ]
    const result = __testing.longestNonDecreasingSubsequence(pairs)
    expect(result).toEqual(pairs.slice(1))
  })

  it('2b. 逆行するマッチが混じっても最長非減少部分列が正しく選ばれる（中間が外れ値のケース）', () => {
    const pairs = [
      { cueCharIndex: 0, asrIndex: 10 },
      { cueCharIndex: 1, asrIndex: 11 },
      { cueCharIndex: 2, asrIndex: 5 }, // 逆行する外れ値
      { cueCharIndex: 3, asrIndex: 12 },
      { cueCharIndex: 4, asrIndex: 13 },
    ]
    const result = __testing.longestNonDecreasingSubsequence(pairs)
    expect(result).toEqual([pairs[0], pairs[1], pairs[3], pairs[4]])
  })

  it('3a. excessが閾値以下の飛び（キュー側も同じだけ進む長い書き換え）ではかたまりが分割されない', () => {
    // 前半10文字が連続対応、そこから cueCharIndex・asrIndex ともに200進んで
    // 後半10文字が連続対応する（LLMが長い区間を書き換えたケースを模す）。
    // 生の飛び(201)は大きいが、キュー側も同じだけ進むため excess は 0 で閾値以下。
    const first = Array.from({ length: 10 }, (_, i) => ({ cueCharIndex: i, asrIndex: i }))
    const rewritten = Array.from({ length: 10 }, (_, i) => ({ cueCharIndex: 210 + i, asrIndex: 210 + i }))
    const pairs = [...first, ...rewritten]

    const cluster = __testing.selectLargestCluster(pairs)
    expect(cluster).toEqual(pairs)
  })

  it('3b. excessが閾値を超える飛び（誤マッチ相当）ではかたまりが分割される', () => {
    // outlierはcueCharIndexが1しか進まないのにasrIndexが200進む（excess=199 > 30）。
    const first = Array.from({ length: 10 }, (_, i) => ({ cueCharIndex: i, asrIndex: i }))
    const outlier = [{ cueCharIndex: 10, asrIndex: 209 }]
    const rest = Array.from({ length: 10 }, (_, i) => ({ cueCharIndex: 11 + i, asrIndex: 210 + i }))
    const pairs = [...first, ...outlier, ...rest]

    const cluster = __testing.selectLargestCluster(pairs)
    // first(10件)とouter+rest(11件)に分割され、大きい方(11件)が採用される。
    expect(cluster.length).toBe(11)
    expect(cluster[0]).toEqual(outlier[0])
  })

  it('4. 採用かたまりが小さすぎる場合、既存の35%閾値により interpolated 相当（needsInterpolation）に落ちる', () => {
    // cue全体は20文字。かたまりA(5文字, asrIndex50-54)とかたまりB(5文字, asrIndex500-504)に
    // 分裂しており、生の一致数は10文字あるが、採用される最大のかたまりは5文字のみ。
    // 35%閾値(20*0.35=7文字)にもフロア(4文字)にも満たないため needsInterpolation になる。
    const asr: AsrChar[] = Array.from({ length: 600 }, (_, i) => makeChar('x', i, i + 1))
    const globalMatches = new Map<number, number>()
    for (let k = 0; k < 5; k += 1) globalMatches.set(k, 50 + k)
    for (let k = 0; k < 5; k += 1) globalMatches.set(10 + k, 500 + k)
    const cueBounds = [{ start: 0, end: 20 }]

    const [info] = __testing.buildProvisionalSpans(asr, cueBounds, globalMatches)

    expect(info.matchedChars).toBe(5)
    expect(info.needsInterpolation).toBe(true)
  })

  it('5. キュー先頭・末尾の未対応文字ぶん包絡が伸びる。ただし隣キューの採用範囲には食い込まない', () => {
    // cue0(chars0-9)は末尾3文字(7,8,9)が、cue1(chars10-19)は先頭2文字(10,11)が未対応。
    const asr: AsrChar[] = Array.from({ length: 200 }, (_, i) => makeChar('x', i, i + 1))
    const globalMatches = new Map<number, number>()
    for (let k = 0; k <= 6; k += 1) globalMatches.set(k, 100 + k) // cue0: chars0-6 -> asrIndex100-106
    for (let k = 12; k <= 19; k += 1) globalMatches.set(k, 110 + (k - 12)) // cue1: chars12-19 -> asrIndex110-117
    const cueBounds = [{ start: 0, end: 10 }, { start: 10, end: 20 }]

    const [span0, span1] = __testing.buildProvisionalSpans(asr, cueBounds, globalMatches)

    // cue0の末尾は元の採用範囲(106)より伸びるが、cue1の元の採用範囲(110以降)には届かない。
    expect(span0.lastCharIndex).toBeGreaterThan(106)
    expect(span0.lastCharIndex).toBeLessThan(110)
    // cue1の先頭は元の採用範囲(110)より前に伸びるが、cue0の元の採用範囲(〜106)より前には行かない。
    expect(span1.firstCharIndex).toBeGreaterThan(106)
    expect(span1.firstCharIndex).toBeLessThan(110)
  })

  it('5b. 前後のキューが補間対象（採用範囲を持たない）場合は隣接制約を課さずに伸ばす', () => {
    // cue0のみ。前後にキューが無い（配列の端）ケースで、伸長が asr.length-1 / 0 に
    // 正しくクランプされることを確認する。
    const asr: AsrChar[] = Array.from({ length: 20 }, (_, i) => makeChar('x', i, i + 1))
    const globalMatches = new Map<number, number>()
    for (let k = 2; k <= 8; k += 1) globalMatches.set(k, 2 + (k - 2)) // chars2-8 -> asrIndex2-8
    const cueBounds = [{ start: 0, end: 10 }]

    const [info] = __testing.buildProvisionalSpans(asr, cueBounds, globalMatches)

    // 先頭2文字(0,1)ぶん手前へ、末尾1文字(9)ぶん後ろへ伸びる。
    expect(info.firstCharIndex).toBe(0)
    expect(info.lastCharIndex).toBe(9)
  })
})

describe('修正3: 包絡伸長のギャップ吸収（extendEnvelopes / MAX_GAP_ABSORB_SEC）', () => {
  it('1. 未対応文字がある側で、2.0秒以内の空き領域が丸ごと取り込まれる', () => {
    // cue0(chars0-4)は5文字すべて一致(asrIndex0-4、各1秒)。cue1(chars5-9)は先頭1文字
    // (cueCharIndex5)だけ未対応で、残り4文字(6-9)がasrIndex11-14に一致する。
    // asrIndex5-10の6文字は誰にも対応しない「空き領域」で、合計1.5秒（各0.25秒）しかない。
    // 文字数ベースの伸長(未対応1文字ぶん)だけでは空き領域の一部しか埋まらないため、
    // 2.0秒以内の空き領域は丸ごと取り込む。
    const asr: AsrChar[] = [
      makeChar('a', 0, 1),
      makeChar('b', 1, 2),
      makeChar('c', 2, 3),
      makeChar('d', 3, 4),
      makeChar('e', 4, 5), // cue0 matched (asrIndex0-4)
      makeChar('f', 5, 5.25),
      makeChar('g', 5.25, 5.5),
      makeChar('h', 5.5, 5.75),
      makeChar('i', 5.75, 6.0),
      makeChar('j', 6.0, 6.25),
      makeChar('k', 6.25, 6.5), // asrIndex5-10: 空き領域(1.5秒)
      makeChar('l', 6.5, 7.5),
      makeChar('m', 7.5, 8.5),
      makeChar('n', 8.5, 9.5),
      makeChar('o', 9.5, 10.5), // cue1 matched (asrIndex11-14)
    ]
    const globalMatches = new Map<number, number>()
    for (let k = 0; k <= 4; k += 1) globalMatches.set(k, k) // cue0: chars0-4 -> asrIndex0-4
    for (let k = 6; k <= 9; k += 1) globalMatches.set(k, 11 + (k - 6)) // cue1: chars6-9 -> asrIndex11-14
    const cueBounds = [{ start: 0, end: 5 }, { start: 5, end: 10 }]

    const [span0, span1] = __testing.buildProvisionalSpans(asr, cueBounds, globalMatches)

    expect(span0.lastCharIndex).toBe(4) // cue0は完全一致(trailingUnmatched=0)なので伸びない
    // cue1の先頭は空き領域(asrIndex5)まで丸ごと伸びる（1.5秒 <= MAX_GAP_ABSORB_SEC）。
    expect(span1.firstCharIndex).toBe(5)
    expect(span1.startSec).toBeCloseTo(5.0, 5)
  })

  it('2. 空き領域が2.0秒を超える場合は、従来どおり未対応文字数ぶんの伸長にとどまる', () => {
    // 1と同じ構造だが、空き領域(asrIndex5-10)を各1秒・合計6秒にして2.0秒を超えさせる。
    const asr: AsrChar[] = [
      makeChar('a', 0, 1),
      makeChar('b', 1, 2),
      makeChar('c', 2, 3),
      makeChar('d', 3, 4),
      makeChar('e', 4, 5), // cue0 matched (asrIndex0-4)
      makeChar('f', 5, 6),
      makeChar('g', 6, 7),
      makeChar('h', 7, 8),
      makeChar('i', 8, 9),
      makeChar('j', 9, 10),
      makeChar('k', 10, 11), // asrIndex5-10: 空き領域(6秒 > 2.0秒)
      makeChar('l', 11, 12),
      makeChar('m', 12, 13),
      makeChar('n', 13, 14),
      makeChar('o', 14, 15), // cue1 matched (asrIndex11-14)
    ]
    const globalMatches = new Map<number, number>()
    for (let k = 0; k <= 4; k += 1) globalMatches.set(k, k)
    for (let k = 6; k <= 9; k += 1) globalMatches.set(k, 11 + (k - 6))
    const cueBounds = [{ start: 0, end: 5 }, { start: 5, end: 10 }]

    const [, span1] = __testing.buildProvisionalSpans(asr, cueBounds, globalMatches)

    // 未対応文字数(1文字)ぶんだけ伸びる: asrIndex11 -> 10（空き領域の全体(5)までは届かない）。
    expect(span1.firstCharIndex).toBe(10)
    expect(span1.startSec).toBeCloseTo(10, 5)
  })

  it('3. 未対応文字が0の側は、隣接に空き領域があっても絶対に伸びない', () => {
    // cue0は完全一致（trailingUnmatched=0）。直後に1.5秒の空き領域があっても、
    // 未対応文字を持たない側を伸ばすと二重表示や無音表示になるため伸びてはいけない。
    const asr: AsrChar[] = [
      makeChar('a', 0, 1),
      makeChar('b', 1, 2),
      makeChar('c', 2, 3),
      makeChar('d', 3, 4),
      makeChar('e', 4, 5), // cue0 matched (asrIndex0-4), 完全一致
      makeChar('f', 5, 5.5),
      makeChar('g', 5.5, 6.0),
      makeChar('h', 6.0, 6.5), // asrIndex5-7: 空き領域(1.5秒)
      makeChar('i', 6.5, 7.5),
      makeChar('j', 7.5, 8.5),
    ]
    const globalMatches = new Map<number, number>()
    for (let k = 0; k <= 4; k += 1) globalMatches.set(k, k) // cue0: chars0-4 -> asrIndex0-4（完全一致）
    const cueBounds = [{ start: 0, end: 5 }]

    const [span0] = __testing.buildProvisionalSpans(asr, cueBounds, globalMatches)

    expect(span0.lastCharIndex).toBe(4)
    expect(span0.endSec).toBeCloseTo(5, 5)
  })
})

describe('重なり解消の非対称化（enforceMonotonicSpans）', () => {
  it('6a. 重なり時、前のキューは不変で後ろのキューの開始が前のendSecに揃えられる', () => {
    const spans = [
      { startSec: 10, endSec: 50 },
      { startSec: 40, endSec: 60 }, // 前のキューと重なる(40 < 50)
    ]
    const result = __testing.enforceMonotonicSpans(spans)

    expect(result[0]).toEqual({ startSec: 10, endSec: 50 })
    expect(result[1]).toEqual({ startSec: 50, endSec: 60 })
  })

  it('6b. 後ろのキューのendSecが前のendSecより小さい場合、endSecも前のendSecまで拡張される（長さ0を防ぐ）', () => {
    // enforceMonotonicSpans導入前の中点分割だと、前のキューのendSecまで巻き込んで
    // 破壊し、finalizeSpanのMath.max(startSec,endSec)で長さ0のキューを生んでいた。
    const spans = [
      { startSec: 10, endSec: 50 },
      { startSec: 20, endSec: 30 }, // 完全に前のキューに包含される異常な重なり
    ]
    const result = __testing.enforceMonotonicSpans(spans)

    expect(result[0]).toEqual({ startSec: 10, endSec: 50 }) // 前のキューは長さ0にならない
    expect(result[1]).toEqual({ startSec: 50, endSec: 50 })
  })
})

interface ProvisionalOverrides {
  startSec?: number | null
  endSec?: number | null
  matchedChars?: number
  totalChars?: number
  needsInterpolation?: boolean
  firstCharIndex?: number | null
  lastCharIndex?: number | null
  leadingUnmatched?: number
  trailingUnmatched?: number
}

function makeProvisional(overrides: ProvisionalOverrides = {}) {
  return {
    startSec: null,
    endSec: null,
    matchedChars: 0,
    totalChars: 1,
    needsInterpolation: true,
    firstCharIndex: null,
    lastCharIndex: null,
    leadingUnmatched: 0,
    trailingUnmatched: 0,
    ...overrides,
  }
}

describe('修正2: 補間スロットの退化ガード（distributeRun / interpolateSpans、索引空間版）', () => {
  it('1. 索引の余地はあるが極小スロットに配分される場合、対象キューが有効な包絡を持っていればそちらが採用される', () => {
    // 索引空間で按分した結果、極小スロット（幅 < MIN_SPAN_SEC）になっても、対象キューが
    // provisionalに有効な包絡を持っていれば（一致率不足で補間対象に落ちただけの場合）、
    // そちらを優先する（resolveSlotのガード）。asr[0..2]の3トークン(2020-2020.03、幅0.03秒)
    // が索引の余地で、asr[3](2030-2035)が直後キューの採用トークン。
    const asr: AsrChar[] = [
      makeChar('a', 2020, 2020.01),
      makeChar('b', 2020.01, 2020.02),
      makeChar('c', 2020.02, 2020.03),
      makeChar('d', 2030, 2035),
    ]
    // 直前キューはlastCharIndexを持たない（rangeStartIdx=0）。直後キューはfirstCharIndex=3
    // を持つ（rangeEndIdx=2）ため、索引の余地(0-2の3トークン)自体はある。
    const provisional = [
      makeProvisional({ needsInterpolation: false, startSec: 2019, endSec: 2020, firstCharIndex: null, lastCharIndex: null }),
      makeProvisional({
        needsInterpolation: true,
        matchedChars: 10,
        totalChars: 31,
        startSec: 2026.584,
        endSec: 2028.645,
      }),
      makeProvisional({ needsInterpolation: false, startSec: 2030, endSec: 2035, firstCharIndex: 3, lastCharIndex: null }),
    ]

    const results = __testing.interpolateSpans(provisional, asr)

    // rangeStartIdx=0, rangeEndIdx=2（firstCharIndex(3)-1）で索引の余地はあるが、
    // 3トークン(2020-2020.03)の幅は0.03秒しかなくMIN_SPAN_SEC(0.05)未満の極小スロットに
    // なる。provisionalの有効な包絡[2026.584, 2028.645]が代わりに採用される。
    expect(results[1]).toEqual({ startSec: 2026.584, endSec: 2028.645 })
  })

  it('2. 補間対象キューが有効な包絡を持たない場合は、索引空間で区間内に比例配分される（非退行）', () => {
    const asr: AsrChar[] = [
      makeChar('a', 0, 5),
      makeChar('b', 5, 10),
      makeChar('c', 10, 15),
      makeChar('d', 15, 20),
      makeChar('e', 20, 25),
      makeChar('f', 25, 30),
    ]
    const provisional = [
      makeProvisional({ needsInterpolation: false, startSec: 0, endSec: 10, firstCharIndex: 0, lastCharIndex: 1 }),
      makeProvisional({ needsInterpolation: true, matchedChars: 0, totalChars: 5, startSec: null, endSec: null }),
      makeProvisional({ needsInterpolation: false, startSec: 20, endSec: 30, firstCharIndex: 4, lastCharIndex: 5 }),
    ]

    const results = __testing.interpolateSpans(provisional, asr)

    // rangeStartIdx=2(lastCharIndex1+1), rangeEndIdx=3(firstCharIndex4-1) の2トークン
    // (asrIndex2,3 = 10-20秒)がまるごとこの1キューに配分される。
    expect(results[1].startSec).toBeCloseTo(10, 5)
    expect(results[1].endSec).toBeCloseTo(20, 5)
  })

  it('3. distributeRun: 索引の余地がゼロのときは秒による按分へフォールバックせず、直前キューから借用する', () => {
    // rangeStartIdx(prevのlastCharIndex+1=1) > rangeEndIdx(nextのfirstCharIndex-1=0)
    // となり索引の余地が無いケース。直前キュー(results[0])から借用することを確認する。
    const provisional = [
      makeProvisional({ needsInterpolation: false, startSec: 0, endSec: 10, firstCharIndex: 0, lastCharIndex: 0 }),
      makeProvisional({ needsInterpolation: true, totalChars: 5, startSec: null, endSec: null }),
      makeProvisional({ needsInterpolation: false, startSec: 100, endSec: 110, firstCharIndex: 1, lastCharIndex: 1 }),
    ]
    const results: { startSec: number; endSec: number }[] = [
      { startSec: 0, endSec: 10 },
      { startSec: 0, endSec: 0 },
      { startSec: 100, endSec: 110 },
    ]
    const asr: AsrChar[] = [makeChar('x', 0, 10), makeChar('y', 100, 110)]

    const didBorrow = __testing.distributeRun(provisional, results, 1, 2, asr)

    expect(didBorrow).toBe(true)
    // 直前キュー(results[0])の末尾から借用するため、[1]は直前キューのendSec(10)を
    // 上限に配置され、直前キュー自身はMIN_SPAN_SEC以上を残して縮む。
    expect(results[1].endSec).toBeCloseTo(10, 5)
    expect(results[1].startSec).toBeLessThan(10)
    expect(results[0].endSec).toBeLessThanOrEqual(10)
    expect(results[0].endSec - results[0].startSec).toBeGreaterThanOrEqual(0.05 - 1e-9)
    // 直後キュー(results[2])は一切変更されない（借用元は直前のみ）。
    expect(results[2]).toEqual({ startSec: 100, endSec: 110 })
  })
})

describe('修正: 按分の座標系を索引空間へ（無音区間を跨がない）', () => {
  it('1. 最重要: トークン索引上は連番だが実時間には巨大な無音（実測304秒相当）があるケースで、補間対象キューが無音区間の中に配置されない', () => {
    // 実データ(117分講義)で観測された構造をそのまま再現する:
    // 「あいうえ」(0-5秒、4文字) と「かきくけ」(305-310秒、4文字) の間に300秒の無音がある。
    // 索引上は連番(3,4)なので、旧実装（秒で按分）だと補間対象キューの時刻が
    // (5,305)の無音区間の中に置かれてしまっていた。新実装は索引空間で按分するため、
    // 索引の余地(rangeEndIdx<rangeStartIdx)が無く、直前キュー('あいうえ')から借用する。
    // （cueは4文字以上でないとMIN_MATCHED_CHARS_FLOORにより常にinterpolated判定される
    // ため、あえて4文字の単語を使っている。）
    const prevText = 'あいうえ'
    const nextText = 'かきくけ'
    const asr: AsrChar[] = [
      ...Array.from(prevText).map((char, i) => makeChar(char, i * 1.25, (i + 1) * 1.25)),
      ...Array.from(nextText).map((char, i) => makeChar(char, 305 + i * 1.25, 305 + (i + 1) * 1.25)),
    ]
    const spans = alignCuesToAsr([prevText, '全然違う内容のテキストです', nextText], asr)

    expect(spans).toHaveLength(3)
    expect(spans[0].confidence).toBe('exact')
    expect(spans[2].confidence).toBe('exact')
    expect(spans[1].confidence).toBe('interpolated')
    // 無音区間(5, 305)の中に配置されていないこと（＝直前キューの範囲内・直後キューの
    // 開始より前に収まっていること）。
    expect(spans[1].startSec).toBeLessThanOrEqual(5)
    expect(spans[1].endSec).toBeLessThanOrEqual(5)
    expect(spans[1].startSec).toBeGreaterThanOrEqual(0)
    // 単調性も保たれる。
    expect(spans[0].endSec).toBeLessThanOrEqual(spans[1].startSec)
    expect(spans[1].endSec).toBeLessThanOrEqual(spans[2].startSec)
  })

  it('2. 索引空間の按分が正規化後の文字数比に従う', () => {
    // rangeStartIdx=0, rangeEndIdx=9（10トークン, 各1秒=合計10秒）を、
    // totalChars 2:8 の比で2キューに配分する。
    const asr: AsrChar[] = Array.from({ length: 10 }, (_, i) => makeChar('x', i, i + 1))
    const provisional = [
      makeProvisional({ needsInterpolation: true, totalChars: 2, startSec: null, endSec: null }),
      makeProvisional({ needsInterpolation: true, totalChars: 8, startSec: null, endSec: null }),
    ]
    const results: { startSec: number; endSec: number }[] = [{ startSec: 0, endSec: 0 }, { startSec: 0, endSec: 0 }]

    const didBorrow = __testing.distributeRun(provisional, results, 0, 2, asr)

    expect(didBorrow).toBe(false)
    expect(results[0]).toEqual({ startSec: 0, endSec: 2 })
    expect(results[1]).toEqual({ startSec: 2, endSec: 10 })
  })

  it('3. 小数索引の時刻換算はトークン内に収まり、トークン間（無音になり得る領域）を跨がない', () => {
    // asr[0]は0-1秒、asr[1]は100-101秒（間に99秒の無音）。
    const asr: AsrChar[] = [makeChar('a', 0, 1), makeChar('b', 100, 101)]

    // pos=0.5はトークン0の内側(0-1秒)の中間。
    expect(__testing.indexPosToSec(asr, 0.5)).toBeCloseTo(0.5, 5)
    // pos=1（整数境界）はトークン1の先頭(100)を指す。トークン0のend(1)と
    // トークン1のstart(100)の間（無音区間）を跨いだ補間にはならない。
    expect(__testing.indexPosToSec(asr, 1)).toBeCloseTo(100, 5)
    // pos=1.5はトークン1の内側(100-101秒)の中間で、無音区間には入らない。
    expect(__testing.indexPosToSec(asr, 1.5)).toBeCloseTo(100.5, 5)
  })

  it('4. 索引の余地がゼロのとき、直前キューから借用し、直前キューがMIN_SPAN_SEC未満にならない', () => {
    const provisional = [
      makeProvisional({ needsInterpolation: false, startSec: 0, endSec: 1, firstCharIndex: 0, lastCharIndex: 0 }),
      makeProvisional({ needsInterpolation: true, totalChars: 3, startSec: null, endSec: null }),
      makeProvisional({ needsInterpolation: false, startSec: 300, endSec: 301, firstCharIndex: 1, lastCharIndex: 1 }),
    ]
    const results: { startSec: number; endSec: number }[] = [
      { startSec: 0, endSec: 1 },
      { startSec: 0, endSec: 0 },
      { startSec: 300, endSec: 301 },
    ]
    const asr: AsrChar[] = [makeChar('x', 0, 1), makeChar('y', 300, 301)]

    __testing.distributeRun(provisional, results, 1, 2, asr)

    expect(results[0].endSec - results[0].startSec).toBeGreaterThanOrEqual(MIN_SPAN_SEC_FOR_TEST - 1e-9)
    expect(results[1].endSec).toBeLessThanOrEqual(1)
    expect(results[1].startSec).toBeGreaterThanOrEqual(0)
  })

  it('5. 借用できない場合（直前キューがすでにMIN_SPAN_SEC相当しか無い）、長さ0で並びクラッシュしない', () => {
    const provisional = [
      makeProvisional({ needsInterpolation: false, startSec: 0, endSec: 0.05, firstCharIndex: 0, lastCharIndex: 0 }),
      makeProvisional({ needsInterpolation: true, totalChars: 3, startSec: null, endSec: null }),
      makeProvisional({ needsInterpolation: false, startSec: 300, endSec: 301, firstCharIndex: 1, lastCharIndex: 1 }),
    ]
    const results: { startSec: number; endSec: number }[] = [
      { startSec: 0, endSec: 0.05 },
      { startSec: 0, endSec: 0 },
      { startSec: 300, endSec: 301 },
    ]
    const asr: AsrChar[] = [makeChar('x', 0, 0.05), makeChar('y', 300, 301)]

    expect(() => __testing.distributeRun(provisional, results, 1, 2, asr)).not.toThrow()

    // 直前キューはこれ以上削れない（すでにMIN_SPAN_SEC相当）ため、借用できず
    // 直前キューの終了時刻に長さ0で並ぶ。
    expect(results[1]).toEqual({ startSec: 0.05, endSec: 0.05 })
    expect(results[0]).toEqual({ startSec: 0, endSec: 0.05 })
  })

  it('6a. run が先頭（直前キューが存在しない）場合、直後キューから借用する', () => {
    const provisional = [
      makeProvisional({ needsInterpolation: true, totalChars: 3, startSec: null, endSec: null }),
      makeProvisional({ needsInterpolation: false, startSec: 300, endSec: 310, firstCharIndex: 0, lastCharIndex: 0 }),
    ]
    const results: { startSec: number; endSec: number }[] = [{ startSec: 0, endSec: 0 }, { startSec: 300, endSec: 310 }]
    const asr: AsrChar[] = [makeChar('x', 300, 310)]

    const didBorrow = __testing.distributeRun(provisional, results, 0, 1, asr)

    expect(didBorrow).toBe(true)
    // 直後キュー(results[1])の先頭から借用するため、[0]は直後キューのstartSec(300)を
    // 下限に配置され、直後キュー自身はMIN_SPAN_SEC以上を残して縮む。
    expect(results[0].startSec).toBeCloseTo(300, 5)
    expect(results[1].startSec).toBeGreaterThan(300)
    expect(results[1].endSec - results[1].startSec).toBeGreaterThanOrEqual(MIN_SPAN_SEC_FOR_TEST - 1e-9)
  })

  it('6b. run が末尾（直後キューが存在しない）場合、直前キューの索引を上限に索引空間で配分される（借用は起きない）', () => {
    const asr: AsrChar[] = Array.from({ length: 5 }, (_, i) => makeChar('x', i, i + 1))
    const provisional = [
      makeProvisional({ needsInterpolation: false, startSec: 0, endSec: 2, firstCharIndex: 0, lastCharIndex: 1 }),
      makeProvisional({ needsInterpolation: true, totalChars: 3, startSec: null, endSec: null }),
    ]
    const results: { startSec: number; endSec: number }[] = [{ startSec: 0, endSec: 2 }, { startSec: 0, endSec: 0 }]

    const didBorrow = __testing.distributeRun(provisional, results, 1, 2, asr)

    // rangeStartIdx=2, rangeEndIdx=asr.length-1=4 と索引の余地があるため、通常の
    // 索引按分になり借用は起きない。
    expect(didBorrow).toBe(false)
    expect(results[1]).toEqual({ startSec: 2, endSec: 5 })
  })

  it('7. 診断: interpolateSpansWithDiagnostics が借用したrun数を数えられる', () => {
    const prevText = 'あいうえ'
    const nextText = 'かきくけ'
    const asr: AsrChar[] = [
      ...Array.from(prevText).map((char, i) => makeChar(char, i * 1.25, (i + 1) * 1.25)),
      ...Array.from(nextText).map((char, i) => makeChar(char, 305 + i * 1.25, 305 + (i + 1) * 1.25)),
    ]
    const cueTexts = [prevText, '全然違う内容のテキストです', nextText]
    const resolved = __testing.resolveOptions(undefined, asr)
    const cueTokenLists = cueTexts.map(text => __testing.tokenizeCueText(text, resolved.script))
    let cursor = 0
    const cueBounds = cueTokenLists.map(tokens => {
      const bound = { start: cursor, end: cursor + tokens.length }
      cursor += tokens.length
      return bound
    })
    const globalMatches = new Map<number, number>()
    for (let k = 0; k < 4; k += 1) globalMatches.set(cueBounds[0].start + k, k) // cue0 -> asrIndex0-3
    for (let k = 0; k < 4; k += 1) globalMatches.set(cueBounds[2].start + k, 4 + k) // cue2 -> asrIndex4-7
    const provisional = __testing.buildProvisionalSpans(asr, cueBounds, globalMatches)

    const { borrowedRunCount } = __testing.interpolateSpansWithDiagnostics(provisional, asr)

    expect(borrowedRunCount).toBe(1)
  })
})

describe('3. セグメント跨ぎの融合（本命・実データフィクスチャ）', () => {
  const segments = loadSeg6Seg7Fixture()
  const asr = buildAsrCharStream(segments)
  const cueTexts = [
    '講座の受講料は無料です。',
    '講座終了後もさらなる学びやさ',
    'まざまな機会を提供しています。',
    '松尾県独自のコミュニティへの参加機会として、継続的な講座の受講や実践経験を積む企業との共同研究プロジェクト、インターンシップなどが用意されています。',
    '2022年にGCIを受講した三重大学の修了生あいさんは、',
    'その後、大学で電子工学を学ぶ傍ら、ティーチングアシスタントとして受講生のサポートを行っています。',
  ]
  const spans = alignCuesToAsr(cueTexts, asr)

  it('6キュー分の結果が返る', () => {
    expect(spans).toHaveLength(6)
  })

  it('単調性: 重なりが無い', () => {
    for (let i = 0; i < spans.length - 1; i += 1) {
      expect(spans[i].endSec).toBeLessThanOrEqual(spans[i + 1].startSec)
    }
  })

  it('cue4「松尾県独自の…」の開始は、旧実装のバグ値(174.913)ではなく、旧セグメント6(147.48-174.21)側に食い込む', () => {
    // 旧実装（現行 semanticSplitJa.ts）はセグメント境界に縛られるため、このキューの
    // 開始を174.913（セグメント7の頭）に誤って固定していた（タスク背景の受け入れ基準参照）。
    // 新実装はセグメント跨ぎの融合を正しく扱い、実際の発話時刻である旧セグメント6側
    // （174.21秒より前）まで開始を遡れる。
    expect(spans[3].startSec).toBeLessThan(174.21)
    expect(spans[3].startSec).toBeCloseTo(163.79, 0)
  })

  it('cue3「まざまな機会を提供しています。」の開始が約159.96秒に一致する（±0.5秒）', () => {
    expect(spans[2].startSec).toBeCloseTo(159.96, 0)
  })

  it('cue5「2022年にGCIを受講した…」の開始が約186.23秒に一致する（±0.5秒）', () => {
    expect(spans[4].startSec).toBeCloseTo(186.23, 0)
  })

  it('実測値の固定（characterization）: maxWordDurationSec CAP導入後の値で回帰を検知する', () => {
    // 受け入れ基準テーブル（タスク仕様書より、Python difflib実測、±0.5秒）:
    //   cue3: 約159.96-162.50 / cue4: 約163.79-181.97 / cue5: 約186.23-192.82
    //
    // 変更前（CAP導入前）の実測値と変更理由:
    //   cue3.end = 163.688 → 161.906 (CAP導入で-1.78s。末尾語「す」が177.792ではなく161.306
    //     start + CAP(0.6s) で161.906に頭打ちされたため)
    //   cue4.end = 186.138 → 178.392 (CAP導入で-7.75s。末尾語「す」が177.792-186.138という
    //     8.35秒の異常durationを持っていたが、177.792 + CAP(0.6s) = 178.392に頭打ちされたため)
    //   cue5.end = 194.044 → 192.202 (CAP導入で-1.84s。末尾語「ん」が191.602-194.044という
    //     2.44秒の異常durationを持っていたが、191.602 + CAP(0.6s) = 192.202に頭打ちされたため)
    //
    // 原因（変更前からの継続事実）: WhisperX生データ自体が、文間のポーズ（無音区間）を
    // 直前モーラの end に吸収しており、1文字の発話が8秒超（177.792-186.138「す」）や
    // 2.4秒超（191.602-194.044「ん」）に及ぶ異常なワードタイムスタンプが実在する（score自体は
    // 0.999-1.0 と高いため、score<0.2の端点補正だけでは検出できない）。
    // maxWordDurationSec CAP（デフォルト0.6s）はこの種の「スコアは高いがタイミングだけ
    // 壊れている」ケースを、単語duration自体を頭打ちすることで補正する。
    //
    // 新しい値はいずれもタスク仕様書の受け入れレンジ（cue3: 161.7-162.2 / cue4: 178.2-178.6 /
    // cue5: 192.0-192.5）に入っていることを確認済み（下の別テストでも検証）。
    expect(spans[2].endSec).toBeCloseTo(161.906, 2)
    expect(spans[3].endSec).toBeCloseTo(178.392, 2)
    expect(spans[4].endSec).toBeCloseTo(192.202, 2)
  })

  it('受け入れレンジ: CAP後の各キューの終端が仕様書のレンジに入る', () => {
    // タスク仕様書の受け入れレンジテーブル（__fixtures__/asrAlignment.seg6seg7.json）:
    //   cue3「まざまな機会を提供しています。」: end 161.7-162.2
    //   cue4「松尾県独自のコミュニティへの…」: end 178.2-178.6
    //   cue5「2022年にGCIを受講した修了生…」: end 192.0-192.5
    expect(spans[2].endSec).toBeGreaterThanOrEqual(161.7)
    expect(spans[2].endSec).toBeLessThanOrEqual(162.2)
    expect(spans[3].endSec).toBeGreaterThanOrEqual(178.2)
    expect(spans[3].endSec).toBeLessThanOrEqual(178.6)
    expect(spans[4].endSec).toBeGreaterThanOrEqual(192.0)
    expect(spans[4].endSec).toBeLessThanOrEqual(192.5)
  })

  it('物理妥当性: cue4「松尾県…」の発話速度(正規化74文字/秒)が4.0-8.5文字/秒に収まる', () => {
    const cue4NormalizedLength = __testing.normalizeTimingText(cueTexts[3]).length
    const durationSec = spans[3].endSec - spans[3].startSec
    const charsPerSec = cue4NormalizedLength / durationSec
    expect(charsPerSec).toBeGreaterThanOrEqual(4.0)
    expect(charsPerSec).toBeLessThanOrEqual(8.5)
  })
})

describe('ラテン文字（script: "latin"）のトークン化', () => {
  function makeWordChar(word: string, start: number, end: number, score = 1): AsrChar {
    return { char: word, start, end, score }
  }

  describe('__testing.normalizeLatinToken', () => {
    it('小文字化し、前後の句読点を除去する（末尾カンマ）', () => {
      expect(__testing.normalizeLatinToken('Today,')).toBe('today')
    })

    it('語中のアポストロフィは保持される（I\'m）', () => {
      expect(__testing.normalizeLatinToken("I'm")).toBe("i'm")
    })

    it('語中のハイフンは保持される（co-founder）', () => {
      expect(__testing.normalizeLatinToken('co-founder')).toBe('co-founder')
    })

    it('記号のみのトークンは空文字になる', () => {
      expect(__testing.normalizeLatinToken('...')).toBe('')
    })
  })

  describe('__testing.tokenizeCueText', () => {
    it('script=latin: 空白で分割してから正規化し、空になった語は捨てる', () => {
      expect(__testing.tokenizeCueText('Today, I am — excited!', 'latin')).toEqual([
        'today',
        'i',
        'am',
        'excited',
      ])
    })

    it('script=japanese: 既存どおり1文字ずつ（句読点・空白は除去）', () => {
      expect(__testing.tokenizeCueText('これは、テストです。', 'japanese')).toEqual(Array.from('これはテストです'))
    })

    it('script=generic: japaneseと同じ1文字ずつの扱い', () => {
      expect(__testing.tokenizeCueText('これは、テストです。', 'generic')).toEqual(Array.from('これはテストです'))
    })
  })

  describe('buildAsrCharStream: 単語トークンを分解しない', () => {
    it('WhisperXの単語をそのまま1エントリとして採用し、実測のstart/endを使う', () => {
      const segments: TranscriptSegment[] = [
        {
          id: 1,
          start: 0,
          end: 2,
          text: "Today, I'm excited",
          words: [
            { word: 'Today,', start: 0, end: 0.4, score: 0.9 },
            { word: "I'm", start: 0.4, end: 0.6, score: 0.9 },
            { word: 'excited', start: 0.6, end: 1.2, score: 0.9 },
          ],
        },
      ]
      const chars = buildAsrCharStream(segments, { script: 'latin' })
      // 分解されず、単語数と同じ3エントリのまま（日本語なら文字数ぶんに分解される）。
      expect(chars).toHaveLength(3)
      expect(chars[0]).toEqual({ char: 'Today,', start: 0, end: 0.4, score: 0.9 })
      expect(chars[1]).toEqual({ char: "I'm", start: 0.4, end: 0.6, score: 0.9 })
      expect(chars[2]).toEqual({ char: 'excited', start: 0.6, end: 1.2, score: 0.9 })
    })

    it('比較キーが空になるトークン（記号のみ）は捨てる', () => {
      const segments: TranscriptSegment[] = [
        { id: 1, start: 0, end: 1, text: '...', words: [{ word: '...', start: 0, end: 1 }] },
      ]
      expect(buildAsrCharStream(segments, { script: 'latin' })).toEqual([])
    })

    it('単語durationのCAP（maxWordDurationSec）はラテン文字でも適用される', () => {
      const segments: TranscriptSegment[] = [
        { id: 1, start: 10, end: 18, text: 'today', words: [{ word: 'today', start: 10, end: 18 }] },
      ]
      const chars = buildAsrCharStream(segments, { script: 'latin' })
      expect(chars).toHaveLength(1)
      expect(chars[0].start).toBeCloseTo(10, 5)
      expect(chars[0].end).toBeCloseTo(10.6, 5)
    })
  })

  describe('alignCuesToAsr: 大文字小文字・末尾句読点の差を吸収して一致する', () => {
    it('"Today," と "today" が一致し、confidence が exact になる', () => {
      const asr: AsrChar[] = [
        makeWordChar('Today', 0, 1),
        makeWordChar('I', 1, 2),
        makeWordChar('am', 2, 3),
        makeWordChar('excited', 3, 4),
      ]
      const spans = alignCuesToAsr(['today, I am excited.'], asr, { script: 'latin' })
      expect(spans).toHaveLength(1)
      expect(spans[0].confidence).toBe('exact')
      expect(spans[0].startSec).toBeCloseTo(0, 5)
      expect(spans[0].endSec).toBeCloseTo(4, 5)
    })

    it('語中のアポストロフィ・ハイフンを保持したまま一致する（I\'m / co-founder）', () => {
      // MIN_MATCHED_CHARS_FLOOR(4トークン)を満たすため、4トークン以上のキューで検証する。
      const asr: AsrChar[] = [
        makeWordChar("I'm", 0, 1),
        makeWordChar('a', 1, 2),
        makeWordChar('co-founder', 2, 3),
        makeWordChar('here', 3, 4),
      ]
      const spans = alignCuesToAsr(["I'm a co-founder here"], asr, { script: 'latin' })
      expect(spans).toHaveLength(1)
      expect(spans[0].confidence).toBe('exact')
      expect(spans[0].startSec).toBeCloseTo(0, 5)
      expect(spans[0].endSec).toBeCloseTo(4, 5)
    })

    it('空白分割が単語境界を保つため、短い単語（am）が正しい位置にマッチする', () => {
      // 旧実装の欠陥: normalizeTimingTextが空白も除去するため、
      // "Today I am sitting down" が "TodayIamsittingdown" に連結され、
      // "am" のような短い断片が遠方へ誤マッチしやすくなっていた。
      const asr: AsrChar[] = [
        makeWordChar('Today', 0, 1),
        makeWordChar('I', 1, 2),
        makeWordChar('am', 2, 3),
        makeWordChar('sitting', 3, 4),
        makeWordChar('down', 4, 5),
      ]
      const spans = alignCuesToAsr(['Today I am sitting down'], asr, { script: 'latin' })
      expect(spans).toHaveLength(1)
      expect(spans[0].confidence).toBe('exact')
      expect(spans[0].startSec).toBeCloseTo(0, 5)
      expect(spans[0].endSec).toBeCloseTo(5, 5)
    })
  })

  describe('日本語（既定）の非退行: script省略時はscript:"japanese"指定時と同じ結果', () => {
    it('buildAsrCharStream', () => {
      const segments: TranscriptSegment[] = [
        {
          id: 1,
          start: 0,
          end: 2,
          text: 'ABCD',
          words: [{ word: 'AB', start: 0, end: 1 }, { word: 'CD', start: 1, end: 2 }],
        },
      ]
      expect(buildAsrCharStream(segments)).toEqual(buildAsrCharStream(segments, { script: 'japanese' }))
    })

    it('alignCuesToAsr', () => {
      const asr: AsrChar[] = Array.from('これはテストです').map((char, i) => makeChar(char, i, i + 1))
      expect(alignCuesToAsr(['これはテストです'], asr)).toEqual(
        alignCuesToAsr(['これはテストです'], asr, { script: 'japanese' }),
      )
    })
  })
})

describe('窓幅の秒基準換算（DEFAULT_WINDOW_SEC / DEFAULT_WINDOW_MARGIN_SEC）', () => {
  it('密度1トークン/秒のASRストリームでは、DEFAULT_WINDOW_SEC(800)がそのままwindowCharsになる', () => {
    const asr: AsrChar[] = Array.from({ length: 100 }, (_, i) => makeChar('x', i, i + 1))
    const resolved = __testing.resolveOptions(undefined, asr)
    expect(resolved.windowChars).toBe(800)
    expect(resolved.windowMarginChars).toBe(160)
  })

  it('密度10トークン/秒のASRストリームでは、windowChars/windowMarginCharsが10倍になる', () => {
    const asr: AsrChar[] = Array.from({ length: 100 }, (_, i) => makeChar('x', i * 0.1, i * 0.1 + 0.1))
    const resolved = __testing.resolveOptions(undefined, asr)
    expect(resolved.windowChars).toBe(8000)
    expect(resolved.windowMarginChars).toBe(1600)
  })

  it('windowChars/windowMarginCharsを明示指定した場合は密度換算より優先される', () => {
    const asr: AsrChar[] = Array.from({ length: 100 }, (_, i) => makeChar('x', i * 0.1, i * 0.1 + 0.1))
    const resolved = __testing.resolveOptions({ windowChars: 50, windowMarginChars: 20 }, asr)
    expect(resolved.windowChars).toBe(50)
    expect(resolved.windowMarginChars).toBe(20)
  })

  it('空配列や密度0除算（span<=0）ではフォールバック値（旧来の固定値4000/800）を使う', () => {
    expect(__testing.resolveOptions(undefined, [])).toMatchObject({ windowChars: 4000, windowMarginChars: 800 })
    const zeroSpanAsr: AsrChar[] = [makeChar('x', 5, 5)]
    expect(__testing.resolveOptions(undefined, zeroSpanAsr)).toMatchObject({ windowChars: 4000, windowMarginChars: 800 })
  })

  it('黒箱テスト: windowCharsを明示指定した場合、実際のalignCuesToAsrの窓処理でも優先される', () => {
    // 密度換算(1文字/秒)ではwindowChars=800相当になるはずだが、明示指定50を優先させても
    // 複数窓に跨る既存の「窓処理」テスト（別describe参照）と同じ結果になることを確認する。
    const filler = 'ん'.repeat(60)
    const target = '目印テキスト'
    const text = filler + target + filler
    const asr: AsrChar[] = Array.from(text).map((char, i) => makeChar(char, i, i + 1))
    const spans = alignCuesToAsr([target], asr, { windowChars: 50, windowMarginChars: 20 })
    expect(spans[0].startSec).toBeCloseTo(60, 5)
    expect(spans[0].endSec).toBeCloseTo(66, 5)
  })
})

describe('detectAsrScriptDetail / detectAsrScript（WhisperX出力のトークン単位判定）', () => {
  // 判定材料は生の word（buildAsrCharStream 通過前）。長さだけを制御したいので、
  // 中身の文字種は判定に無関係（'x' を length 分繰り返すだけ）。
  function makeTokensOfLengths(lengths: readonly number[]): TranscriptSegment[] {
    const words = lengths.map((len, i) => ({ word: 'x'.repeat(len), start: i, end: i + 1 }))
    return [{ id: 1, start: 0, end: lengths.length, text: words.map(w => w.word).join(' '), words }]
  }

  it('1文字トークン中心（実測: 日本語5本の平均1.0相当）の入力は japanese・平均長約1.0を返す', () => {
    const segments = makeTokensOfLengths(Array.from({ length: 20 }, () => 1))
    const detection = detectAsrScriptDetail(segments)
    expect(detection.script).toBe('japanese')
    expect(detection.meanTokenLength).toBeCloseTo(1.0, 5)
    expect(detection.tokenCount).toBe(20)
    expect(detectAsrScript(segments)).toBe('japanese')
  })

  it('複数文字トークン中心（実測: 英語1本の平均4.0相当）の入力は latin を返す', () => {
    const segments = makeTokensOfLengths(Array.from({ length: 20 }, () => 4))
    const detection = detectAsrScriptDetail(segments)
    expect(detection.script).toBe('latin')
    expect(detection.meanTokenLength).toBeCloseTo(4.0, 5)
    expect(detectAsrScript(segments)).toBe('latin')
  })

  it('有効トークンが0件（words 欠損、または正規化後に空文字のみ）なら tokenCount===0 を返す', () => {
    const noWords: TranscriptSegment[] = [{ id: 1, start: 0, end: 1, text: '' }]
    expect(detectAsrScriptDetail(noWords).tokenCount).toBe(0)

    // 句読点のみのトークンは normalizeTimingText で空文字になり、母数から除かれる。
    const punctuationOnly: TranscriptSegment[] = [
      { id: 1, start: 0, end: 1, text: '。、', words: [{ word: '。', start: 0, end: 0.5 }, { word: '、', start: 0.5, end: 1 }] },
    ]
    expect(detectAsrScriptDetail(punctuationOnly).tokenCount).toBe(0)
  })

  it('平均長がちょうど閾値1.2の場合は japanese（境界は文字単位側に倒す）', () => {
    // 16トークン長1 + 4トークン長2 → 合計24 / 20トークン = 1.2 ちょうど
    const segments = makeTokensOfLengths([...Array(16).fill(1), ...Array(4).fill(2)])
    const detection = detectAsrScriptDetail(segments)
    expect(detection.meanTokenLength).toBeCloseTo(1.2, 5)
    expect(detection.script).toBe('japanese')
  })

  it('平均長が閾値1.2をわずかに超える場合は latin に切り替わる', () => {
    // 15トークン長1 + 5トークン長2 → 合計25 / 20トークン = 1.25
    const segments = makeTokensOfLengths([...Array(15).fill(1), ...Array(5).fill(2)])
    const detection = detectAsrScriptDetail(segments)
    expect(detection.meanTokenLength).toBeCloseTo(1.25, 5)
    expect(detection.script).toBe('latin')
  })
})
