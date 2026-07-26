import { describe, expect, it } from 'vitest'
import { alignCuesToAsr, buildAsrCharStream, __testing } from './asrAlignment'
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
