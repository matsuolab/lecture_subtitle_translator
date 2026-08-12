import type { AdminSettings } from '@/types/adminSettings'
import type { JaBlock, PipelineThresholds } from './blockTypes'
import type { CorrectedSegmentLite } from './correct'
import type { WordTimestamp } from './types'
import { normalizeSpaces } from './textUtils'
import {
  requireChatModelForProvider,
  resolveAiProvider,
  resolveChatCompletionTokenLimitForProvider,
} from './aiProvider'
import { resolveSplitJaModelId } from './prompts'
import { loadLanguageProfileConfig, type LanguageProfileConfig, type LanguageScript } from './languageProfileConfig'
import { parseJsonObjectFromLlmContent } from './jsonResponse'
import { mapWithConcurrency, normalizeConcurrency } from '@/lib/concurrency'
import { llmCallWithMeta } from './llmCallWithMeta'
import type { CueSourceRef, CueSourceRelation } from '@/types/sourceEvidence'
import { cloneCueSourceRefs, mergeCueSourceRefs, withCueSourceRelation } from '@/types/sourceEvidence'
import {
  alignCuesToAsr,
  buildAsrCharStreamWithRanges,
  detectAsrScriptDetail,
  enforceMonotonicSpans,
  findSilenceBoundaries,
  type AlignedSpan,
  type AsrChar,
  type AsrSegmentRange,
} from './asrAlignment'

const MAX_SEGMENTS_PER_REQUEST = 4
const LOCAL_MAX_SEGMENTS_PER_REQUEST = 2
// オーバーロング分割の再アライン回数上限。旧実装(alignUnits)のループ回数を踏襲。
const MAX_OVERLONG_SPLIT_LOOPS = 8

/**
 * 「字幕が出ていない」とみなす発話の最小長（秒）。実機データ（117分）で
 * これ以上の欠損は38箇所・計139.2秒あり、最大16.5秒。1.0秒未満の欠損は
 * 端点の丸め誤差の範囲なので対象にしない。
 */
const MIN_UNCOVERED_SEC = 1.0

/** 1グループあたりのカバレッジ修復の試行上限。*/
const MAX_COVERAGE_SPLIT_LOOPS = 8

/**
 * 「物理的にあり得ないキュー」判定のしきい値（文字/秒）。
 * 実測: 日本語ASRの1文字あたり duration の中央値は0.120秒＝毎秒約8.3文字。
 * 毎秒50文字はその6倍以上で、人間の発話としてあり得ない。実データ（117分の講義）で
 * 隣のキューに範囲を取られて潰れていた3件（duration 0.06秒/0.04秒/0.05秒、本文
 * 15〜73文字）は、いずれも毎秒300〜1,800文字相当だった。
 */
const MAX_PLAUSIBLE_CHARS_PER_SEC = 50

interface RawSemanticUnit {
  unitId: string
  sourceSegmentId: number
  jaText: string
  canMergeWithNext: boolean
  sourceRefs?: CueSourceRef[]
}

function sourceRefsForUnit(unit: RawSemanticUnit, relation?: CueSourceRelation): CueSourceRef[] {
  const refs = cloneCueSourceRefs(unit.sourceRefs) ?? [{
    sourceSegmentId: unit.sourceSegmentId,
    semanticUnitId: unit.unitId,
    relation: 'semantic_unit' as const,
  }]
  return relation ? withCueSourceRelation(refs, relation)! : refs
}

interface AlignedUnit {
  unit: RawSemanticUnit
  start: number
  end: number
  alignConf: 'exact' | 'no_words'
  words: WordTimestamp[]
  matchRate: number
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}

function normalizeTimingText(text: string): string {
  // asrAlignment.ts の normalizeTimingText と同じ規則（正規化のズレを防ぐため意図的に同期）。
  // `\[` は文字クラス内では不要なエスケープで ESLint(no-useless-escape) に引っかかるため、
  // 挙動を変えずに `[` へ修正。
  return normalizeSpaces(text).replace(/[。、「」『』（）()［］[\]！？!?・,，、.\s]/g, '')
}

function lcsLength(a: string, b: string): number {
  if (!a || !b) return 0
  let previous = new Array(b.length + 1).fill(0)
  for (let i = 1; i <= a.length; i += 1) {
    const current = new Array(b.length + 1).fill(0)
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = a[i - 1] === b[j - 1]
        ? previous[j - 1] + 1
        : Math.max(previous[j], current[j - 1])
    }
    previous = current
  }
  return previous[b.length]
}

function noBreakRanges(text: string, glossaryTerms: string[]): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = []
  const terms = [...new Set(glossaryTerms.map(term => term.trim()).filter(term => term.length >= 2))]
    .sort((a, b) => b.length - a.length)
  for (const term of terms) {
    let index = text.indexOf(term)
    while (index >= 0) {
      ranges.push({ start: index, end: index + term.length })
      index = text.indexOf(term, index + Math.max(1, term.length))
    }
  }
  return ranges
}

function isKatakana(char: string): boolean {
  return /^[ァ-ヴー]$/.test(char)
}

function isAsciiWord(char: string): boolean {
  return /^[A-Za-z0-9_+-]$/.test(char)
}

function isUnsafeSplit(text: string, index: number, ranges: Array<{ start: number; end: number }>): boolean {
  if (index <= 0 || index >= text.length) return true
  if (ranges.some(range => index > range.start && index < range.end)) return true
  const prev = text[index - 1] ?? ''
  const next = text[index] ?? ''
  return (isKatakana(prev) && isKatakana(next)) || (isAsciiWord(prev) && isAsciiWord(next))
}

/**
 * 分割位置の選び方。
 * - 'balanced': 長すぎるキューをバランス良く割る用（`splitOverlongUnit`）。本文の25%〜75%に
 *   限定し、その窓内に句読点があれば距離に関係なくそこを選ぶ。preferred はあくまで目安
 *   （だいたい半分）であり、読みやすい位置を優先してよいケース向け。
 * - 'targeted': 分割位置が証拠（発話をどこまで覆えているか）で決まっている用
 *   （`repairGroupCoverage`）。本文全体を探索し、preferred に最も近い安全な位置を選ぶ。
 *   同じ距離なら句読点の直後を優先するが、距離そのものは上書きしない。
 */
type SplitPositionPolicy = 'balanced' | 'targeted'

/**
 * 分割位置を選ぶ。既定の `'balanced'` は元の実装のまま（本文の25%〜75%に限定し、窓内に
 * 句読点があれば距離を無視してそこを選ぶ）で、`splitOverlongUnit` の挙動を変えない。
 *
 * `'targeted'` は `repairGroupCoverage` 専用。`'balanced'` の2つの制約は、分割位置が
 * 証拠で決まっているカバレッジ修復では逆に邪魔になることが実測で分かっている:
 * - 25%〜75%の窓: 本文76文字・preferred=69(91%)は窓外のため返り値38(50%)（31文字ずれ）。
 *   本文49文字・preferred=43(88%)は窓外のため返り値24(49%)（19文字ずれ）。
 * - 句読点ボーナス-1000（距離を完全に上書き）: 本文73文字・preferred=56(77%)は窓内の
 *   句読点を優先し返り値50(68%)（6文字ずれ）。本文37文字・preferred=28(76%)も同様に
 *   返り値21(57%)（7文字ずれ）。
 * いずれのケースも意図した断片が作れず、再アラインしても未カバー秒数が減らないため
 * 修復が棄却され、実機データで26箇所・計51.5秒が「キューの端が数文字ぶん削れている」
 * まま残っていた。そのため `'targeted'` は本文全体（1〜text.length-1）を探索し、
 * スコアを `距離*2 + (直前が句読点でなければ+1)` として句読点を同距離のときの
 * タイブレークのみに使う（距離を上書きしない）。`isUnsafeSplit` による除外
 * （用語内部・カタカナ同士・英数同士）はどちらの policy でも変わらず適用する。
 */
function chooseSafeSplitIndex(
  text: string,
  preferred: number,
  glossaryTerms: string[],
  policy: SplitPositionPolicy = 'balanced',
): number {
  const ranges = noBreakRanges(text, glossaryTerms)
  const punctuation = ['。', '、', '，', '．', '！', '？']

  if (policy === 'targeted') {
    let best = -1
    let bestScore = Number.POSITIVE_INFINITY
    for (let index = 1; index < text.length; index += 1) {
      if (isUnsafeSplit(text, index, ranges)) continue
      const prev = text[index - 1] ?? ''
      const score = Math.abs(index - preferred) * 2 + (punctuation.includes(prev) ? 0 : 1)
      if (score < bestScore) {
        best = index
        bestScore = score
      }
    }
    if (best >= 0) return best
    return Math.max(1, Math.min(text.length - 1, preferred))
  }

  const min = Math.max(1, Math.floor(text.length * 0.25))
  const max = Math.min(text.length - 1, Math.ceil(text.length * 0.75))
  let best = -1
  let bestDistance = Number.POSITIVE_INFINITY
  for (let index = min; index <= max; index += 1) {
    if (isUnsafeSplit(text, index, ranges)) continue
    const prev = text[index - 1] ?? ''
    const distance = Math.abs(index - preferred) + (punctuation.includes(prev) ? -1000 : 0)
    if (distance < bestDistance) {
      best = index
      bestDistance = distance
    }
  }
  if (best >= 0) return best
  return Math.max(1, Math.min(text.length - 1, preferred))
}

function splitOverlongUnit(unit: RawSemanticUnit, duration: number, maxDuration: number, glossaryTerms: string[]): RawSemanticUnit[] {
  if (duration <= maxDuration || unit.jaText.length < 16) return [unit]
  const parts = Math.ceil(duration / Math.max(1, maxDuration * 0.88))
  const groups = [unit.jaText]
  while (groups.length < parts) {
    let longestIndex = -1
    let longestLength = 0
    for (const [index, group] of groups.entries()) {
      if (group.length > longestLength) {
        longestIndex = index
        longestLength = group.length
      }
    }
    if (longestIndex < 0 || longestLength < 16) break
    const group = groups[longestIndex]
    const splitAt = chooseSafeSplitIndex(group, Math.floor(group.length / 2), glossaryTerms)
    groups.splice(longestIndex, 1, group.slice(0, splitAt), group.slice(splitAt))
  }
  if (groups.length <= 1) return [unit]
  return groups.map((group, index) => ({
    ...unit,
    unitId: `${unit.unitId}_${index + 1}`,
    jaText: group,
    canMergeWithNext: index < groups.length - 1 || unit.canMergeWithNext,
    sourceRefs: sourceRefsForUnit(unit, 'overlong_split'),
  }))
}

/**
 * `AlignedSpan.confidence` → `AlignConf`（'exact' | 'no_words'）の写像。
 *
 * 'exact' と 'partial' はいずれも実単語タイムスタンプにアンカーされている
 * （実測: seg6/seg7フィクスチャ含む検証データで partial 17件中 Δstart が
 * 許容誤差を超えた逸脱は0件）。'partial' を独立扱いにして 'proportional' 相当へ
 * 落とすと、17/38 が誤って `metrics.ts` の proportional_ts 違反として扱われ、
 * 両ブロックとも 'exact' を要求する `finalSafeMerge.ts` の結合条件も不必要に
 * 阻害される。一方 'interpolated' のみが実測値を持たない真の推定（前後の
 * 確定キューから按分した時刻）であるため、既存の proportional_ts 判定に
 * そのまま乗るよう 'no_words' に写像する。
 */
function mapAlignConf(confidence: AlignedSpan['confidence']): 'exact' | 'no_words' {
  return confidence === 'interpolated' ? 'no_words' : 'exact'
}

/**
 * `AlignedSpan` のマッチ済みASR文字範囲（`firstCharIndex`〜`lastCharIndex`）を
 * `WordTimestamp[]` へ復元する。日本語ASRは1文字=1wordとして扱われるため、
 * ASR文字をそのまま word として詰め直せばよい。マッチ無し（interpolated）は空配列。
 *
 * ラテン文字（`script: 'latin'`）では `asrStream` の1エントリが既に単語単位
 * （`buildAsrCharStream` 参照）なので、このスライスがそのまま単語単位の
 * `WordTimestamp[]` になる（1文字ずつの粒度より正確になる改善）。
 */
function spanToWords(span: AlignedSpan, asrStream: readonly AsrChar[]): WordTimestamp[] {
  if (span.firstCharIndex === null || span.lastCharIndex === null) return []
  return asrStream.slice(span.firstCharIndex, span.lastCharIndex + 1).map(asrChar => ({
    word: asrChar.char,
    start: asrChar.start,
    end: asrChar.end,
    score: asrChar.score,
  }))
}

function toAlignedUnit(unit: RawSemanticUnit, span: AlignedSpan, asrStream: readonly AsrChar[]): AlignedUnit {
  return {
    unit,
    start: round(span.startSec),
    end: round(Math.max(span.startSec + 0.05, span.endSec)),
    alignConf: mapAlignConf(span.confidence),
    words: spanToWords(span, asrStream),
    matchRate: span.matchRate,
  }
}

/**
 * 分割断片の時刻を親スパイン（分割前のユニットが占めていたASR範囲）の中に
 * 文字数比で按分する。親スパン自体が `interpolated`（`firstCharIndex`/`lastCharIndex`
 * が null、つまりASR実測にアンカーできていない）の場合はスライスする対象が無いため、
 * 全ストリームへの再アラインではなく、この按分にフォールバックする。
 */
function proportionalSpansForFragments(fragments: readonly RawSemanticUnit[], parentSpan: AlignedSpan): AlignedSpan[] {
  const charCounts = fragments.map(fragment => Math.max(1, normalizeTimingText(fragment.jaText).length))
  const totalChars = charCounts.reduce((sum, count) => sum + count, 0)
  const span = Math.max(0, parentSpan.endSec - parentSpan.startSec)
  let cursor = parentSpan.startSec
  return fragments.map((_, index) => {
    const isLast = index === fragments.length - 1
    const start = cursor
    const end = isLast ? parentSpan.endSec : Math.min(parentSpan.endSec, cursor + span * (charCounts[index] / totalChars))
    cursor = end
    return {
      startSec: start,
      endSec: Math.max(start, end),
      matchedChars: 0,
      totalChars: charCounts[index],
      matchRate: 0,
      confidence: 'interpolated',
      firstCharIndex: null,
      lastCharIndex: null,
    }
  })
}

/**
 * 分割断片の時刻を、親スパンの時刻範囲 `[parentSpan.startSec, parentSpan.endSec]` の
 * 内側にクランプする。スライスされたASR範囲に対してアラインしている限り理論上は
 * 範囲外に出ないが、`interpolateSpans` のフォールバック境界計算等の余地を考慮し
 * 念のため明示的に閉じ込める。
 */
function clampSpanToParent(span: AlignedSpan, parentSpan: AlignedSpan): AlignedSpan {
  const startSec = Math.min(Math.max(span.startSec, parentSpan.startSec), parentSpan.endSec)
  const endSec = Math.min(Math.max(span.endSec, parentSpan.startSec), parentSpan.endSec)
  return { ...span, startSec, endSec: Math.max(startSec, endSec) }
}

/**
 * 分割断片を、親ユニットが占めていたASR文字範囲（`parentSpan.firstCharIndex`〜
 * `lastCharIndex`）のスライスに対してのみアラインする。`alignCuesToAsr` が返す
 * `firstCharIndex`/`lastCharIndex` はスライス相対のインデックスなので、スライス
 * 開始位置のオフセットを加算して `asrStream` 全体のインデックスに戻す
 * （`startSec`/`endSec` はASR文字が保持する絶対時刻のためオフセット不要）。
 */
function alignFragmentsWithinParentSlice(
  fragments: readonly RawSemanticUnit[],
  parentSpan: AlignedSpan,
  asrStream: readonly AsrChar[],
  script: LanguageScript,
): AlignedSpan[] {
  const sliceStart = parentSpan.firstCharIndex as number
  const sliceEnd = parentSpan.lastCharIndex as number
  const slice = asrStream.slice(sliceStart, sliceEnd + 1)
  const spans = alignCuesToAsr(fragments.map(fragment => fragment.jaText), slice, { script })
  return spans.map(span => clampSpanToParent(
    {
      ...span,
      firstCharIndex: span.firstCharIndex === null ? null : span.firstCharIndex + sliceStart,
      lastCharIndex: span.lastCharIndex === null ? null : span.lastCharIndex + sliceStart,
    },
    parentSpan,
  ))
}

/**
 * 分割断片を親スパンの範囲内にのみアラインする（ASRストリーム全体への再アラインはしない）。
 * 親が実測アンカー（`firstCharIndex`/`lastCharIndex`）を持つ場合はそのスライスに対して
 * `alignCuesToAsr` を行い、持たない場合（親自体が interpolated）は文字数比按分にフォールバックする。
 */
function alignFragmentsWithinParent(
  fragments: readonly RawSemanticUnit[],
  parentSpan: AlignedSpan,
  asrStream: readonly AsrChar[],
  script: LanguageScript,
): AlignedSpan[] {
  if (parentSpan.firstCharIndex === null || parentSpan.lastCharIndex === null) {
    return proportionalSpansForFragments(fragments, parentSpan)
  }
  return alignFragmentsWithinParentSlice(fragments, parentSpan, asrStream, script)
}

interface OverlongScanEntry {
  unit: RawSemanticUnit
  span: AlignedSpan
  /** 分割済み、または分割不能で確定した断片。以降のオーバーロング走査から除外する。*/
  accepted: boolean
}

interface SegmentGroup {
  segmentId: number
  /** units 内での元の位置。グループ化してもこの配列で元の順序に戻せる。*/
  indices: number[]
  units: RawSemanticUnit[]
}

/**
 * ユニットを `sourceSegmentId` ごとにグループ化する。元の順序は各グループの
 * `indices`（units 内での絶対位置）で保持し、呼び出し側が結果を元の順序へ
 * 書き戻せるようにする（グループ自体の出現順は最初に現れた位置の順）。
 */
function groupUnitsBySegment(units: readonly RawSemanticUnit[]): SegmentGroup[] {
  const groups = new Map<number, SegmentGroup>()
  const order: number[] = []
  units.forEach((unit, index) => {
    let group = groups.get(unit.sourceSegmentId)
    if (!group) {
      group = { segmentId: unit.sourceSegmentId, indices: [], units: [] }
      groups.set(unit.sourceSegmentId, group)
      order.push(unit.sourceSegmentId)
    }
    group.indices.push(index)
    group.units.push(unit)
  })
  return order.map(id => groups.get(id) as SegmentGroup)
}

interface SegmentWindow {
  startIdx: number
  endIdx: number
  /** そのセグメント自身（隣接±1を含まない）のASR文字ストリーム上の索引範囲（閉区間）。
   * カバレッジ修復（`repairGroupCoverage`）が「隣のセグメントの発話は隣のグループが
   * 覆う」という前提のもと、探索対象を自セグメントの発話区間だけに絞るために使う。*/
  ownStartIdx: number
  ownEndIdx: number
  /** segmentId が ranges に存在せず、最も近い既知のセグメントへ丸めたか。*/
  clamped: boolean
}

/**
 * `segmentId` に一致する `AsrSegmentRange` の `ranges` 内インデックスを探す。
 * 完全一致が無い場合は、`segmentId`（数値）が最も近い range へ丸める
 * （全体探索へのフォールバックは行わない。それが今回排除したい経路のため）。
 */
function findNearestRangeIndex(
  ranges: readonly AsrSegmentRange[],
  segmentId: number,
): { index: number; clamped: boolean } | null {
  if (ranges.length === 0) return null
  const exactIndex = ranges.findIndex(range => range.segmentId === segmentId)
  if (exactIndex >= 0) return { index: exactIndex, clamped: false }
  let bestIndex = 0
  let bestDistance = Math.abs(ranges[0].segmentId - segmentId)
  for (let i = 1; i < ranges.length; i += 1) {
    const distance = Math.abs(ranges[i].segmentId - segmentId)
    if (distance < bestDistance) {
      bestDistance = distance
      bestIndex = i
    }
  }
  return { index: bestIndex, clamped: true }
}

/**
 * 由来セグメントの探索範囲（ASR文字ストリーム上の索引、閉区間）を「由来セグメント±1」で
 * 決める。実測（117分・788ユニット・293セグメント）で、字幕ユニットの99.7%が由来
 * セグメント1つの中に完全に収まり、2セグメントに跨るのはわずか0.3%、3セグメント以上に
 * 跨る例はゼロだった。そのため探索範囲を「1つ前のセグメントの開始」〜「1つ後の
 * セグメントの終了」に限定すれば、補正LLMがセグメント境界を跨いで文を再構成する
 * ケース（隣接1つ分の跨ぎ）は吸収しつつ、講義全体（最大300倍以上）を探索する
 * 必要が無くなり、遠方の頻出語への誤マッチが構造的に発生しなくなる。
 *
 * 開始 = 1つ前のセグメントの startIdx（無ければ自身の startIdx）
 * 終了 = 1つ後のセグメントの endIdx（無ければ自身の endIdx）
 *
 * 窓が休憩などの無音を含んでも構わない。ここは「どこを探すか」であり、「いつ表示するか」
 * とは別の関心事である。スパンが無音を覆わないことは asrAlignment.ts の不変条件
 * （findSilenceBoundaries / clipSpanToSpeech）が保証する。
 */
function resolveSegmentWindow(
  ranges: readonly AsrSegmentRange[],
  segmentId: number,
): SegmentWindow | null {
  const found = findNearestRangeIndex(ranges, segmentId)
  if (!found) return null
  const { index, clamped } = found
  const own = ranges[index]
  const prev = index > 0 ? ranges[index - 1] : null
  const next = index < ranges.length - 1 ? ranges[index + 1] : null
  return {
    startIdx: prev ? prev.startIdx : own.startIdx,
    endIdx: next ? next.endIdx : own.endIdx,
    ownStartIdx: own.startIdx,
    ownEndIdx: own.endIdx,
    clamped,
  }
}

/** ranges が空（asrStream 自体が空）のときのみ使う縮退フォールバック。通常到達しない
 * （呼び出し元の semanticSplitJa は asrStream.length===0 を別経路で処理するため）が、
 * `alignUnitsGlobally` を直接叩くテスト等でのクラッシュを避けるための安全側の値。*/
function degenerateSpan(jaText: string): AlignedSpan {
  return {
    startSec: 0,
    endSec: 0,
    matchedChars: 0,
    totalChars: Math.max(1, normalizeTimingText(jaText).length),
    matchRate: 0,
    confidence: 'interpolated',
    firstCharIndex: null,
    lastCharIndex: null,
  }
}

/**
 * 1グループ（同じ由来セグメントのユニット群）を、そのセグメント±1の窓（`window`）に
 * 限定してアラインする。`alignFragmentsWithinParentSlice` と同じ「スライスして
 * アラインし、オフセットを戻す」パターン: `alignCuesToAsr` が返す `firstCharIndex`/
 * `lastCharIndex` はスライス相対の索引なので、`window.startIdx` を加算して
 * `asrStream` 全体の索引に戻す（`startSec`/`endSec` は絶対時刻のためオフセット不要）。
 */
function alignGroupWithinWindow(
  groupUnits: readonly RawSemanticUnit[],
  window: SegmentWindow,
  asrStream: readonly AsrChar[],
  script: LanguageScript,
): AlignedSpan[] {
  const slice = asrStream.slice(window.startIdx, window.endIdx + 1)
  const spans = alignCuesToAsr(groupUnits.map(unit => unit.jaText), slice, { script })
  return spans.map(span => ({
    ...span,
    firstCharIndex: span.firstCharIndex === null ? null : span.firstCharIndex + window.startIdx,
    lastCharIndex: span.lastCharIndex === null ? null : span.lastCharIndex + window.startIdx,
  }))
}

/**
 * ASR文字ストリームの索引範囲 `[fromIdx, toIdx]`（閉区間）を、無音境界（`silenceAfter`。
 * `findSilenceBoundaries` 参照）で区切った発話区間（実際に声が出ている時間区間）の
 * 一覧にする。`fromIdx > toIdx`（空範囲）のときは空配列を返す。
 */
function speechRunsInRange(
  asrStream: readonly AsrChar[],
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

/**
 * 発話区間 `runs` のうち、`spans`（`startSec`/`endSec`）のどれにも覆われていない
 * 区間を求める（`uncoveredIntervals`/`totalUncoveredSec` 共通の内部計算）。
 * こちらは閾値でのフィルタを行わない生の欠損区間（改善量の測定に使う）。
 */
function computeUncoveredGaps(
  runs: readonly { start: number; end: number }[],
  spans: readonly AlignedSpan[],
): Array<{ start: number; end: number }> {
  const gaps: Array<{ start: number; end: number }> = []
  for (const run of runs) {
    const covered = spans
      .map(span => ({ start: Math.max(span.startSec, run.start), end: Math.min(span.endSec, run.end) }))
      .filter(part => part.end > part.start)
      .sort((a, b) => a.start - b.start)
    let cursor = run.start
    for (const part of covered) {
      if (part.start > cursor) gaps.push({ start: cursor, end: part.start })
      cursor = Math.max(cursor, part.end)
    }
    if (run.end > cursor) gaps.push({ start: cursor, end: run.end })
  }
  return gaps
}

/**
 * 発話区間のうち、どのスパンにも覆われていない区間（`MIN_UNCOVERED_SEC` 以上のもの）を
 * 返す。カバレッジ修復ループ（`repairGroupCoverage`）が「直すべき穴」を見つけるために使う。
 */
function uncoveredIntervals(
  runs: readonly { start: number; end: number }[],
  spans: readonly AlignedSpan[],
): Array<{ start: number; end: number }> {
  return computeUncoveredGaps(runs, spans).filter(gap => gap.end - gap.start >= MIN_UNCOVERED_SEC)
}

/**
 * 未カバー区間の合計秒数（閾値フィルタなし）。`repairGroupCoverage` が分割の前後で
 * 比較し、実際に改善したか（無音の向こう側の本文が届くようになったか）を判定するのに使う。
 */
function totalUncoveredSec(
  runs: readonly { start: number; end: number }[],
  spans: readonly AlignedSpan[],
): number {
  return computeUncoveredGaps(runs, spans).reduce((sum, gap) => sum + (gap.end - gap.start), 0)
}

/** カバレッジ修復ループが分割の採用を決める最小改善量（秒）。*/
const MIN_COVERAGE_IMPROVEMENT_SEC = 0.5

/** カバレッジ修復ループが分割対象として受け付ける本文の最小文字数。`chooseSafeSplitIndex` が
 * 意味のある分割位置（先頭・末尾25%を除く範囲）を選べる最小限の長さ。*/
const MIN_SPLITTABLE_TEXT_LENGTH = 16

interface GroupAlignment {
  units: RawSemanticUnit[]
  spans: AlignedSpan[]
  /** `units[i]` がグループ内の元の（分割前の）何番目のユニット（0-indexed）に由来するか。
   * 分割で1つのユニットが2断片に増えた場合、両断片が同じ値を持つ。呼び出し元
   * （`computeInitialSpansBySegment`）が `group.indices` と組み合わせて元の絶対 index への
   * 書き戻しに使う。unitId 文字列の解析に頼らないため、分割の連鎖（分割断片がさらに
   * 分割される）が起きても安全に対応関係を追える。*/
  originGroupIndices: number[]
}

/** hole の直前で終わっているスパンのうち最も後ろのもの（無ければ -1）。 */
function findSpanEndingBeforeHole(spans: readonly AlignedSpan[], holeStart: number): number {
  let targetIndex = -1
  let bestEndSec = Number.NEGATIVE_INFINITY
  for (let i = 0; i < spans.length; i += 1) {
    if (spans[i].endSec <= holeStart && spans[i].endSec > bestEndSec) {
      bestEndSec = spans[i].endSec
      targetIndex = i
    }
  }
  return targetIndex
}

/** hole の直後から始まっているスパンのうち最も手前のもの（無ければ -1）。 */
function findSpanStartingAfterHole(spans: readonly AlignedSpan[], holeEnd: number): number {
  let targetIndex = -1
  let bestStartSec = Number.POSITIVE_INFINITY
  for (let i = 0; i < spans.length; i += 1) {
    if (spans[i].startSec >= holeEnd && spans[i].startSec < bestStartSec) {
      bestStartSec = spans[i].startSec
      targetIndex = i
    }
  }
  return targetIndex
}

interface CoverageSplitCandidate {
  units: RawSemanticUnit[]
  spans: AlignedSpan[]
  originGroupIndices: number[]
  /** この候補を採用した場合の未カバー秒数の減少量（採用判定・prev/next比較の両方に使う）。*/
  improvementSec: number
}

/**
 * `targetIndex` のユニットを分割して hole を埋める候補を1つ組み立てる。分割位置の
 * 目安は `side` で変える: 'prev'（hole の手前で終わっているユニット）は分割後の
 * *後半*が hole 側を埋めるので `preferred = len * covered/(covered+holeLen)`。
 * 'next'（hole の後ろから始まっているユニット）は分割後の*前半*が hole 側を埋めるので
 * `preferred = len * holeLen/(covered+holeLen)`（対称）。
 *
 * 分割できない（本文が短すぎる／分割位置が退化する）、または再アライン後の改善量が
 * `MIN_COVERAGE_IMPROVEMENT_SEC` 未満なら null を返す（呼び出し側が「この側は不採用」
 * と判断できるようにする）。
 */
function buildCoverageSplitCandidate(
  units: readonly RawSemanticUnit[],
  spans: readonly AlignedSpan[],
  originGroupIndices: readonly number[],
  targetIndex: number,
  hole: { start: number; end: number },
  side: 'prev' | 'next',
  runs: readonly { start: number; end: number }[],
  window: SegmentWindow,
  asrStream: readonly AsrChar[],
  script: LanguageScript,
  glossaryTerms: string[],
): CoverageSplitCandidate | null {
  const targetUnit = units[targetIndex]
  if (targetUnit.jaText.length < MIN_SPLITTABLE_TEXT_LENGTH) return null

  const targetSpan = spans[targetIndex]
  const covered = targetSpan.endSec - targetSpan.startSec
  const holeLen = hole.end - hole.start
  const preferred = side === 'prev'
    ? Math.round(targetUnit.jaText.length * covered / (covered + holeLen))
    : Math.round(targetUnit.jaText.length * holeLen / (covered + holeLen))
  const splitAt = chooseSafeSplitIndex(targetUnit.jaText, preferred, glossaryTerms, 'targeted')
  const firstText = targetUnit.jaText.slice(0, splitAt)
  const secondText = targetUnit.jaText.slice(splitAt)
  if (!firstText || !secondText) return null

  const firstUnit: RawSemanticUnit = {
    ...targetUnit,
    unitId: `${targetUnit.unitId}_c1`,
    jaText: firstText,
    canMergeWithNext: true,
    sourceRefs: sourceRefsForUnit(targetUnit, 'coverage_split'),
  }
  const secondUnit: RawSemanticUnit = {
    ...targetUnit,
    unitId: `${targetUnit.unitId}_c2`,
    jaText: secondText,
    canMergeWithNext: targetUnit.canMergeWithNext,
    sourceRefs: sourceRefsForUnit(targetUnit, 'coverage_split'),
  }
  const candidateUnits = [
    ...units.slice(0, targetIndex),
    firstUnit,
    secondUnit,
    ...units.slice(targetIndex + 1),
  ]
  const candidateSpans = alignGroupWithinWindow(candidateUnits, window, asrStream, script)

  const before = totalUncoveredSec(runs, spans)
  const after = totalUncoveredSec(runs, candidateSpans)
  const improvementSec = before - after
  if (improvementSec < MIN_COVERAGE_IMPROVEMENT_SEC) return null

  const targetOriginIndex = originGroupIndices[targetIndex]
  const candidateOriginIndices = [
    ...originGroupIndices.slice(0, targetIndex),
    targetOriginIndex,
    targetOriginIndex,
    ...originGroupIndices.slice(targetIndex + 1),
  ]

  return { units: candidateUnits, spans: candidateSpans, originGroupIndices: candidateOriginIndices, improvementSec }
}

/** 2つの分割候補（無い場合は null）のうち、未カバー秒数の減少がより大きい方を選ぶ。 */
function pickBetterCandidate(
  a: CoverageSplitCandidate | null,
  b: CoverageSplitCandidate | null,
): CoverageSplitCandidate | null {
  if (!a) return b
  if (!b) return a
  return a.improvementSec >= b.improvementSec ? a : b
}

/**
 * グループのキューが由来セグメントの発話区間を覆えていない場合に、
 * 該当ユニットの本文を分割して再アラインする。
 *
 * 無音を跨ぐキューは asrAlignment の selectLargestCluster / clipSpanToSpeech が
 * 「一致が最も多い発話区画だけ」に切り詰める。本文が片側にしか無ければこれは正しいが、
 * 本文が無音の両側で話されている場合は、後半の本文が前半の時間帯に押し込まれ、
 * 後半の発話が無字幕になる（実機データで38箇所・計139.2秒、最大16.5秒）。
 *
 * どちらの場合かは事前には判定せず、分割して再アラインした結果で判定する
 * （本文が本当に両側にあれば、後半の断片は無音の向こう側へアラインされ未カバーが減る。
 * 片側にしか無ければ減らないので元に戻す）。閾値を増やさずに済ませるための構成。
 *
 * hole を埋め得るユニットは「直前で終わっている側」と「直後から始まっている側」の
 * どちらもあり得る（実機データ seg102: id=288 の直後に無字幕区間があるが、実際に
 * 話されているのは "直後" の id=289 の前半だった。分割前は id=289 のスパンが遅延して
 * いて前半の一致が切り捨てられていたケース）。両側を候補として試し、より改善する方を
 * 採用する（`buildCoverageSplitCandidate`/`pickBetterCandidate`）。
 *
 * 1つの hole を直しても改善しない（＝分割不能、または改善量が閾値未満）場合は、その
 * hole を「試行済み」として記録し、ループ全体を止めずに次の hole を試す
 * （`triedHoleStarts`）。hole の同定は `start` の値で十分（採用が起きるとスパンが
 * 変わって hole の座標も変わるため、同じ座標が再出現しても無限ループにはならない）。
 * 試行済み集合はループ全体を通して持ち回る（クリアしない）。
 */
function repairGroupCoverage(
  groupUnits: readonly RawSemanticUnit[],
  window: SegmentWindow,
  segmentRange: AsrSegmentRange,
  asrStream: readonly AsrChar[],
  silenceAfter: ReadonlySet<number>,
  script: LanguageScript,
  glossaryTerms: string[],
): GroupAlignment {
  let units: RawSemanticUnit[] = [...groupUnits]
  let originGroupIndices: number[] = groupUnits.map((_, i) => i)
  let spans = alignGroupWithinWindow(units, window, asrStream, script)
  // 窓（window）ではなく、そのセグメント自身の範囲（segmentRange）を使う。窓は±1セグメント
  // ぶん広く、隣のセグメントの発話は隣のグループが覆うため、ここで対象にすると重複修復や
  // 誤った分割を招く。
  const runs = speechRunsInRange(asrStream, silenceAfter, segmentRange.startIdx, segmentRange.endIdx)
  const triedHoleStarts = new Set<number>()

  for (let loop = 0; loop < MAX_COVERAGE_SPLIT_LOOPS; loop += 1) {
    const holes = uncoveredIntervals(runs, spans)
    const hole = holes.find(h => !triedHoleStarts.has(h.start))
    if (!hole) break

    const prevIndex = findSpanEndingBeforeHole(spans, hole.start)
    const nextIndex = findSpanStartingAfterHole(spans, hole.end)
    const prevCandidate = prevIndex >= 0
      ? buildCoverageSplitCandidate(units, spans, originGroupIndices, prevIndex, hole, 'prev', runs, window, asrStream, script, glossaryTerms)
      : null
    const nextCandidate = nextIndex >= 0
      ? buildCoverageSplitCandidate(units, spans, originGroupIndices, nextIndex, hole, 'next', runs, window, asrStream, script, glossaryTerms)
      : null
    const chosen = pickBetterCandidate(prevCandidate, nextCandidate)

    if (!chosen) {
      triedHoleStarts.add(hole.start)
      continue
    }

    units = chosen.units
    spans = chosen.spans
    originGroupIndices = chosen.originGroupIndices
  }

  return { units, spans, originGroupIndices }
}

interface InitialSpansResult {
  /** units と同じ並び順（元の順序）の初期スパン。カバレッジ修復（`repairGroupCoverage`）で
   * ユニットが分割されている場合、元の `units` より要素数が増えていることがある。*/
  units: RawSemanticUnit[]
  spans: AlignedSpan[]
  /** sourceSegmentId が ranges に存在せず、最も近いセグメントへ丸めたグループの件数。*/
  clampedSegmentIds: number
  /** カバレッジ修復で分割したユニットの件数。診断用。*/
  coverageSplits: number
}

/**
 * 全ユニットを `sourceSegmentId` ごとにグループ化し、グループごとに「由来セグメント
 * ±1」の窓へ限定してアラインする（`resolveSegmentWindow`/`alignGroupWithinWindow`
 * 参照）。アライン後、グループのキューが由来セグメントの発話区間を覆えていなければ
 * `repairGroupCoverage` で分割・再アラインする。結果は元の units の順序を保ったまま
 * 返す（グループ内で分割が起きると要素数が増えるため、単純な書き戻しではなく
 * 「元 index → 断片リスト」の対応を flatMap で組み立て直す）。
 *
 * グループの探索範囲どうしは隣接セグメント分だけ重なり得る（±1窓のため）ため、
 * ここで返す時点ではグループ境界で startSec/endSec の重なりが残っている場合がある。
 * 重なり解消は呼び出し元（`alignUnitsGlobally`）が全体で1回、`enforceMonotonicSpans`
 * を適用して行う。
 */
function computeInitialSpansBySegment(
  units: readonly RawSemanticUnit[],
  asrStream: readonly AsrChar[],
  segmentRanges: readonly AsrSegmentRange[],
  script: LanguageScript,
  glossaryTerms: string[],
): InitialSpansResult {
  const silenceAfter = findSilenceBoundaries(asrStream)
  const groups = groupUnitsBySegment(units)
  let clampedSegmentIds = 0
  let coverageSplits = 0

  // 元の絶対 index → その位置が展開された結果のユニット・スパンのリスト。
  const unitsByOriginalIndex = new Map<number, RawSemanticUnit[]>()
  const spansByOriginalIndex = new Map<number, AlignedSpan[]>()

  for (const group of groups) {
    const window = resolveSegmentWindow(segmentRanges, group.segmentId)
    if (!window) {
      group.indices.forEach((originalIndex, i) => {
        unitsByOriginalIndex.set(originalIndex, [group.units[i]])
        spansByOriginalIndex.set(originalIndex, [degenerateSpan(group.units[i].jaText)])
      })
      continue
    }
    if (window.clamped) clampedSegmentIds += 1
    const segmentRange: AsrSegmentRange = { segmentId: group.segmentId, startIdx: window.ownStartIdx, endIdx: window.ownEndIdx }
    const repaired = repairGroupCoverage(group.units, window, segmentRange, asrStream, silenceAfter, script, glossaryTerms)
    coverageSplits += repaired.units.length - group.units.length

    // repaired.units は分割で元の group.units より増えている場合がある。
    // originGroupIndices[i]（グループ内の元の位置）→ group.indices（units 内での絶対位置）
    // で元の絶対 index へ書き戻す。
    const fragmentsByOriginalIndex = new Map<number, { units: RawSemanticUnit[]; spans: AlignedSpan[] }>()
    repaired.units.forEach((fragmentUnit, i) => {
      const originalIndex = group.indices[repaired.originGroupIndices[i]]
      const entry = fragmentsByOriginalIndex.get(originalIndex) ?? { units: [], spans: [] }
      entry.units.push(fragmentUnit)
      entry.spans.push(repaired.spans[i])
      fragmentsByOriginalIndex.set(originalIndex, entry)
    })
    fragmentsByOriginalIndex.forEach((entry, originalIndex) => {
      unitsByOriginalIndex.set(originalIndex, entry.units)
      spansByOriginalIndex.set(originalIndex, entry.spans)
    })
  }

  const resultUnits: RawSemanticUnit[] = []
  const resultSpans: AlignedSpan[] = []
  units.forEach((_, originalIndex) => {
    resultUnits.push(...(unitsByOriginalIndex.get(originalIndex) ?? []))
    resultSpans.push(...(spansByOriginalIndex.get(originalIndex) ?? []))
  })

  return { units: resultUnits, spans: resultSpans, clampedSegmentIds, coverageSplits }
}

export interface AlignUnitsGloballyResult {
  units: AlignedUnit[]
  /** `computeInitialSpansBySegment` が最も近いセグメントへ丸めた（sourceSegmentId が
   * ranges に存在しなかった）グループの件数。診断用。*/
  clampedSegmentIds: number
  /** `computeInitialSpansBySegment`（`repairGroupCoverage`）がカバレッジ修復のために
   * 分割したユニットの件数。診断用。*/
  coverageSplits: number
}

/**
 * 全ユニットのテキストを、由来セグメント（`sourceSegmentId`）±1の範囲に限定して
 * アラインする（詳細・実測根拠は `resolveSegmentWindow` 参照）。
 * 講義全体を1本のASR文字ストリームとして扱う点（`asrStream`）は変わらないが、
 * 各ユニットが実際に探索されるのはそのうちの由来セグメント付近だけになる。
 *
 * アライン結果が `mergedLongDurationSec` を超えるユニットは `splitOverlongUnit` で
 * 安全な位置から分割する。分割は「長すぎるキューを短くする」ための処理であり、
 * 分割後の断片が分割前の親スパンより長くなってはならない。かつて（修正前）は
 * 分割のたびにユニット列全体を ASR ストリーム全体へ再アラインしていたが、これは
 * 分割断片が補正LLMの言い換えが強い遠方の領域と誤対応する余地を生み、実測で
 * `mergedLongDurationSec: 7.0` に対し 11.924 秒のブロックが発生していた
 * （分割前の親スパンより長くなる = 分割の目的に反する不具合）。
 * そのため断片は必ず親ユニットが占めていたASR範囲（`alignFragmentsWithinParent`）に
 * 閉じ込め、確定済みの断片スパンは以降のループで上書きしない
 * （`OverlongScanEntry.accepted` で管理し、残りの超過ユニットのみ走査を続ける）。
 * 最大8回のループで打ち切る（旧実装 `alignUnits` のループ回数を踏襲）。
 * この分割ループ自体は「由来セグメント±1」限定の対象外（従来どおり asrStream 全体を
 * 参照できる `alignFragmentsWithinParent` を使う。挙動は変更していない）。
 */
function alignUnitsGlobally(
  units: RawSemanticUnit[],
  asrStream: readonly AsrChar[],
  segmentRanges: readonly AsrSegmentRange[],
  thresholds: PipelineThresholds,
  glossaryTerms: string[],
  script: LanguageScript = 'japanese',
): AlignUnitsGloballyResult {
  const {
    units: unitsBySegment,
    spans: spansBySegment,
    clampedSegmentIds,
    coverageSplits,
  } = computeInitialSpansBySegment(units, asrStream, segmentRanges, script, glossaryTerms)
  // グループ（由来セグメント±1の窓）どうしは隣接1セグメント分重なり得るため、
  // 組み立て後に全体で1回、既存と同じ非対称の規則（後ろを押し出す・前は不変）で
  // 重なりを解消する（enforceMonotonicSpans は asrAlignment.ts の alignCuesToAsr 内部でも
  // 使っているのと同じロジック。firstCharIndex/lastCharIndex は変更しない）。
  const initialSpans = enforceMonotonicSpans(spansBySegment)
  // カバレッジ修復（`computeInitialSpansBySegment`/`repairGroupCoverage`）でユニット数が
  // 増えている場合があるため、以降は引数 units ではなく unitsBySegment（同じ並び順の
  // 展開後リスト）を使う。
  let entries: OverlongScanEntry[] = unitsBySegment.map((unit, index) => ({
    unit,
    span: initialSpans[index],
    accepted: false,
  }))

  for (let loop = 0; loop < MAX_OVERLONG_SPLIT_LOOPS; loop += 1) {
    const overlongIndex = entries.findIndex(
      entry => !entry.accepted && entry.span.endSec - entry.span.startSec > thresholds.mergedLongDurationSec,
    )
    if (overlongIndex < 0) break
    const entry = entries[overlongIndex]
    const duration = entry.span.endSec - entry.span.startSec
    const fragments = splitOverlongUnit(entry.unit, duration, thresholds.mergedLongDurationSec, glossaryTerms)
    if (fragments.length <= 1) {
      // これ以上分割できない（短すぎる等）。超過を受け入れて確定し、他の超過ユニットの
      // 走査を続ける（旧実装は先頭の分割不能ユニットでループ全体を打ち切っていた）。
      entries = [...entries.slice(0, overlongIndex), { ...entry, accepted: true }, ...entries.slice(overlongIndex + 1)]
      continue
    }
    const fragmentSpans = alignFragmentsWithinParent(fragments, entry.span, asrStream, script)
    const fragmentEntries = fragments.map((fragment, index) => ({
      unit: fragment,
      span: fragmentSpans[index],
      accepted: false,
    }))
    entries = [...entries.slice(0, overlongIndex), ...fragmentEntries, ...entries.slice(overlongIndex + 1)]
  }

  return {
    units: entries.map(entry => toAlignedUnit(entry.unit, entry.span, asrStream)),
    clampedSegmentIds,
    coverageSplits,
  }
}

/**
 * `AlignedUnit` が「物理的にあり得ない（＝潰れた）」キューかどうかを判定する。
 * `end - start <= 0` は文字数によらず常に潰れているとみなす。それ以外は
 * `MAX_PLAUSIBLE_CHARS_PER_SEC` に基づく話速判定（正規化文字数 / 話速上限を
 * duration が下回れば潰れている）。本文が空のユニットは `buildJaBlocks` が
 * 最初からスキップして字幕として現れないため対象外（false を返す）。
 */
function isCollapsedUnit(entry: AlignedUnit): boolean {
  const duration = entry.end - entry.start
  if (duration <= 0) return true
  const charCount = normalizeTimingText(entry.unit.jaText).length
  if (charCount === 0) return false
  return duration < charCount / MAX_PLAUSIBLE_CHARS_PER_SEC
}

/** `AlignedUnit.alignConf` の信頼度順位。数値が大きいほど信頼できる（exact > no_words）。*/
function alignConfRank(alignConf: AlignedUnit['alignConf']): number {
  return alignConf === 'exact' ? 1 : 0
}

export interface CollapsedResolution {
  units: AlignedUnit[]
  /** 隣へ統合された潰れたキューの件数。診断用。*/
  collapsedMerged: number
}

/**
 * 潰れたキュー（`isCollapsedUnit`）を隣のキューへ統合する。
 *
 * 潰れたキューは時刻が信頼できない（duration が話速的にあり得ない＝隣に範囲を
 * 取られている）ため、削除してその本文を隣へ引き継ぐ。時刻は統合先のものを
 * そのまま使う。統合先は前後のうち `alignConf` の信頼度が高い方を選び、同順位
 * なら前を選ぶ（読み順を保つため）。隣が片方しか無ければその隣へ、隣が1つも
 * 無ければ統合せずそのまま残す（本文を失わないことを最優先する）。
 *
 * 判定は元の（統合前の）配列に対して1回だけ行う。統合は時刻を変えないため
 * （統合先の時刻をそのまま使うため）、統合の結果さらに潰れたキューが生まれる
 * ことは無く、1パスで完結する。
 */
function resolveCollapsedUnits(entries: readonly AlignedUnit[]): CollapsedResolution {
  const collapsed = entries.map(isCollapsedUnit)

  // 各インデックスについて、直前/直後にある「潰れていない」エントリのインデックスを求める。
  const prevAnchor: Array<number | null> = []
  let lastAnchor: number | null = null
  for (let i = 0; i < entries.length; i += 1) {
    prevAnchor.push(lastAnchor)
    if (!collapsed[i]) lastAnchor = i
  }
  const nextAnchor: Array<number | null> = new Array(entries.length).fill(null)
  let upcomingAnchor: number | null = null
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    nextAnchor[i] = upcomingAnchor
    if (!collapsed[i]) upcomingAnchor = i
  }

  // 統合先インデックスごとに、末尾へ追加する断片（前へ統合）／先頭へ追加する断片
  // （後ろへ統合）を読み順で集計する。
  type Piece = { jaText: string; words: WordTimestamp[]; sourceRefs: CueSourceRef[] }
  const suffixByTarget = new Map<number, Piece[]>()
  const prefixByTarget = new Map<number, Piece[]>()
  const survivedWithoutMerge = new Set<number>()
  let collapsedMerged = 0

  for (let i = 0; i < entries.length; i += 1) {
    if (!collapsed[i]) continue
    const prevIdx = prevAnchor[i]
    const nextIdx = nextAnchor[i]
    let target: number | null = null
    if (prevIdx !== null && nextIdx !== null) {
      target = alignConfRank(entries[prevIdx].alignConf) >= alignConfRank(entries[nextIdx].alignConf) ? prevIdx : nextIdx
    } else if (prevIdx !== null) {
      target = prevIdx
    } else if (nextIdx !== null) {
      target = nextIdx
    }

    if (target === null) {
      // 隣が1つも無い（例: ユニットが1件しかない）。統合せずそのまま残す。
      survivedWithoutMerge.add(i)
      continue
    }

    collapsedMerged += 1
    const piece: Piece = {
      jaText: entries[i].unit.jaText,
      words: entries[i].words,
      sourceRefs: sourceRefsForUnit(entries[i].unit),
    }
    if (target === prevIdx) {
      suffixByTarget.set(target, [...(suffixByTarget.get(target) ?? []), piece])
    } else {
      prefixByTarget.set(target, [...(prefixByTarget.get(target) ?? []), piece])
    }
  }

  const units: AlignedUnit[] = []
  for (let i = 0; i < entries.length; i += 1) {
    if (collapsed[i]) {
      if (survivedWithoutMerge.has(i)) units.push(entries[i])
      continue
    }
    const prefixPieces = prefixByTarget.get(i) ?? []
    const suffixPieces = suffixByTarget.get(i) ?? []
    if (prefixPieces.length === 0 && suffixPieces.length === 0) {
      units.push(entries[i])
      continue
    }
    const jaText = [
      ...prefixPieces.map(piece => piece.jaText),
      entries[i].unit.jaText,
      ...suffixPieces.map(piece => piece.jaText),
    ].join('')
    const words = [
      ...prefixPieces.flatMap(piece => piece.words),
      ...entries[i].words,
      ...suffixPieces.flatMap(piece => piece.words),
    ].sort((a, b) => a.start - b.start)
    const sourceRefGroups = [
      ...prefixPieces.map(piece => piece.sourceRefs),
      sourceRefsForUnit(entries[i].unit),
      ...suffixPieces.map(piece => piece.sourceRefs),
    ]
    let sourceRefs: CueSourceRef[] | undefined
    for (const group of sourceRefGroups) {
      sourceRefs = mergeCueSourceRefs(sourceRefs, group, 'collapsed_merge')
    }
    units.push({
      ...entries[i],
      unit: { ...entries[i].unit, jaText, sourceRefs },
      words,
    })
  }

  return { units, collapsedMerged }
}

/**
 * ASR文字ストリームが完全に空（`words` が全セグメントで欠損。WhisperXアライメント総崩れ
 * or 非WhisperX入力）の場合の最小限フォールバック。セグメントごとに文字数比例配分し、
 * 全ユニットを正直に `alignConf: 'no_words'` とする（旧 `alignUnitsOnce` の
 * `words.length === 0` 分岐を踏襲）。
 */
function alignUnitsProportionalFallback(
  units: RawSemanticUnit[],
  segments: readonly CorrectedSegmentLite[],
  thresholds: PipelineThresholds,
  glossaryTerms: string[],
): AlignedUnit[] {
  const unitsBySegment = new Map<number, RawSemanticUnit[]>()
  for (const unit of units) {
    const list = unitsBySegment.get(unit.sourceSegmentId) ?? []
    list.push(unit)
    unitsBySegment.set(unit.sourceSegmentId, list)
  }

  const result: AlignedUnit[] = []
  for (const segment of segments) {
    let segmentUnits = unitsBySegment.get(segment.id) ?? []
    if (segmentUnits.length === 0) continue

    // 文字数比例配分の見積もりが長すぎるユニットは、安全な位置から分割してやり直す。
    for (let loop = 0; loop < MAX_OVERLONG_SPLIT_LOOPS; loop += 1) {
      const segmentDuration = Math.max(0.001, segment.end - segment.start)
      const charCounts = segmentUnits.map(unit => Math.max(1, normalizeTimingText(unit.jaText).length))
      const totalChars = charCounts.reduce((sum, count) => sum + count, 0)
      const overlongIndex = charCounts.findIndex(count => segmentDuration * (count / totalChars) > thresholds.mergedLongDurationSec)
      if (overlongIndex < 0) break
      const estimatedDuration = segmentDuration * (charCounts[overlongIndex] / totalChars)
      const split = splitOverlongUnit(segmentUnits[overlongIndex], estimatedDuration, thresholds.mergedLongDurationSec, glossaryTerms)
      if (split.length <= 1) break
      segmentUnits = [...segmentUnits.slice(0, overlongIndex), ...split, ...segmentUnits.slice(overlongIndex + 1)]
    }

    const segmentDuration = Math.max(0.001, segment.end - segment.start)
    const charCounts = segmentUnits.map(unit => Math.max(1, normalizeTimingText(unit.jaText).length))
    const totalChars = charCounts.reduce((sum, count) => sum + count, 0)
    let cursor = segment.start
    segmentUnits.forEach((unit, index) => {
      const isLast = index === segmentUnits.length - 1
      const end = isLast
        ? segment.end
        : Math.min(segment.end, cursor + segmentDuration * (charCounts[index] / totalChars))
      result.push({
        unit,
        start: round(cursor),
        end: round(Math.max(cursor + 0.05, end)),
        alignConf: 'no_words',
        words: [],
        matchRate: 0,
      })
      cursor = end
    })
  }
  return result
}

function parseUnits(payload: Record<string, unknown>): RawSemanticUnit[] {
  const raw = Array.isArray(payload.semantic_units) ? payload.semantic_units : []
  return raw.flatMap((item, index) => {
    if (!item || typeof item !== 'object') return []
    const row = item as Record<string, unknown>
    const sourceSegmentId = Number(row.source_segment_id)
    const jaText = typeof row.ja_text === 'string' ? normalizeSpaces(row.ja_text) : ''
    if (!Number.isFinite(sourceSegmentId) || !jaText) return []
    return [{
      unitId: typeof row.unit_id === 'string' && row.unit_id ? row.unit_id.replace(/[^a-zA-Z0-9_-]/g, '_') : `u${index + 1}`,
      sourceSegmentId,
      jaText,
      canMergeWithNext: row.can_merge_with_next === true,
    }]
  })
}

/**
 * LLM応答のユニットを「このバッチで依頼したセグメントに実在し、テキストが当該セグメントと
 * 実際に重なるもの」だけに絞る。モデルが output_schema の例（source_segment_id: 1）を
 * そのまま返す事故があり、放置すると講義全体のユニットが先頭セグメントへ集積して
 * 数千文字の巨大ブロックになる（T7評価で実際に発生）。
 */
function filterUnitsToBatch(units: RawSemanticUnit[], segments: CorrectedSegmentLite[]): RawSemanticUnit[] {
  const segmentsById = new Map(segments.map(segment => [segment.id, segment]))
  return units.filter(unit => {
    const segment = segmentsById.get(unit.sourceSegmentId)
    if (!segment) return false
    const source = normalizeTimingText(segment.correctedText || segment.text)
    const unitText = normalizeTimingText(unit.jaText)
    if (!source || !unitText) return false
    return lcsLength(unitText, source) / unitText.length >= 0.6
  })
}

/**
 * 各セグメントの LLM 分割カバレッジを計算。0.9 未満のセグメント ID を返す（呼出元が原文 fallback）。
 */
function findUndercoveredSegments(segments: CorrectedSegmentLite[], units: RawSemanticUnit[]): Set<number> {
  const unitsBySegment = new Map<number, RawSemanticUnit[]>()
  for (const unit of units) {
    const list = unitsBySegment.get(unit.sourceSegmentId) ?? []
    list.push(unit)
    unitsBySegment.set(unit.sourceSegmentId, list)
  }
  const undercovered = new Set<number>()
  for (const segment of segments) {
    const source = normalizeTimingText(segment.correctedText || segment.text)
    if (source.length < 20) continue
    const planned = normalizeTimingText((unitsBySegment.get(segment.id) ?? []).map(unit => unit.jaText).join(''))
    const ratio = lcsLength(source, planned) / Math.max(1, source.length)
    if (ratio < 0.9) undercovered.add(segment.id)
  }
  return undercovered
}

// transcript（元言語）が日本語スクリプトのときだけ、カタカナ保持ルールと日本語の例示を含める。
// 既定構成（transcript=Japanese）では従来のハードコード文字列とバイト一致する。
function buildSemanticSplitPrompt(segments: CorrectedSegmentLite[], languages: LanguageProfileConfig): string {
  const transcriptLabel = languages.transcript.label
  const transcriptIsJapanese = languages.transcript.script === 'japanese'
  const rules = [
    'Output JSON only.',
    'Preserve all source meaning and wording. Do not summarize, omit, add, or translate.',
    `Each unit should be a natural ${transcriptLabel} phrase/sentence suitable for grouping into subtitle cues.`,
    `Avoid single-word units, filler-only units, and fragments that start/end in the middle of a ${transcriptLabel} phrase.`,
    ...(transcriptIsJapanese ? ['Keep technical terms and katakana words intact.'] : ['Keep technical terms intact.']),
  ]
  return JSON.stringify({
    task: `Split corrected ${transcriptLabel} lecture transcript into subtitle-ready semantic units. Do not translate. Do not create timestamps.`,
    rules,
    segments: segments.map(segment => ({
      id: segment.id,
      start: segment.start,
      end: segment.end,
      ja_text: segment.correctedText || segment.text,
    })),
    output_schema: {
      semantic_units: [{
        unit_id: 'u001',
        source_segment_id: 1,
        ja_text: transcriptIsJapanese ? '自然な日本語の意味単位' : `a natural ${transcriptLabel} semantic unit`,
        semantic_role: 'topic|reason|consequence|example|contrast|detail|transition|summary',
        can_merge_with_next: true,
      }],
    },
  })
}

interface SemanticSplitBatchResult {
  units: RawSemanticUnit[]
  /** カバレッジ < 0.9 のセグメント ID（原文 fallback 対象）。失敗 batch では全 segment.id が入る。*/
  undercoveredSegmentIds: Set<number>
  errorMessage?: string
}

async function callSemanticSplitApi(
  segments: CorrectedSegmentLite[],
  settings: AdminSettings,
): Promise<SemanticSplitBatchResult> {
  const model = requireChatModelForProvider(settings, resolveSplitJaModelId(settings), 'semantic subtitle splitting')
  const languages = loadLanguageProfileConfig(settings)
  const tokenLimit = resolveChatCompletionTokenLimitForProvider(settings, 6000) as Record<string, unknown>
  // tokenLimit は { max_tokens: N } | { max_completion_tokens: N } 等を返すので両方を確認
  const maxTokens = typeof tokenLimit.max_tokens === 'number'
    ? tokenLimit.max_tokens
    : typeof tokenLimit.max_completion_tokens === 'number'
      ? tokenLimit.max_completion_tokens
      : undefined

  const callResult = await llmCallWithMeta(
    {
      model,
      systemPrompt: `You split ${languages.transcript.label} academic lecture transcripts into subtitle-ready semantic units. Return JSON only.`,
      userContent: buildSemanticSplitPrompt(segments, languages),
      temperature: 0.1,
      maxTokens,
      nodeName: 'semantic_split_ja',
    },
    settings,
  )

  if (callResult.errorMessage) {
    return {
      units: [],
      undercoveredSegmentIds: new Set(segments.map(s => s.id)),
      errorMessage: callResult.errorMessage,
    }
  }

  let parsed: Record<string, unknown>
  try {
    parsed = parseJsonObjectFromLlmContent(callResult.content, 'semantic split')
  } catch (error) {
    return {
      units: [],
      undercoveredSegmentIds: new Set(segments.map(s => s.id)),
      errorMessage: `parse_failed: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  const units = filterUnitsToBatch(parseUnits(parsed), segments)
  return {
    units,
    undercoveredSegmentIds: findUndercoveredSegments(segments, units),
  }
}

/**
 * 書きおこしのトークン単位（`transcriptScript`）を、どこから決めたかを含めて表す。
 * `semanticSplitJa` の戻り値に含めて呼び出し側（localPipeline.ts）が診断summaryへ整形する。
 */
export interface TranscriptScriptResolution {
  script: LanguageScript
  source: 'setting_char' | 'setting_word' | 'auto_detected' | 'fallback_profile'
  /** source==='auto_detected' のときのみ有効。詳細は asrAlignment.ts の AsrScriptDetection 参照。 */
  meanTokenLength?: number
  tokenCount?: number
}

export interface SemanticSplitJaResult {
  blocks: JaBlock[]
  scriptResolution: TranscriptScriptResolution
  /** `resolveCollapsedUnits` が隣へ統合した「潰れたキュー」の件数。診断用（0件でも意味を持つ）。*/
  collapsedMerged: number
  /** `sourceSegmentId` が ASR セグメント範囲に存在せず、最も近いセグメントへ丸めた件数。
   * 診断用（0件でも意味を持つ。通常はLLMが返す source_segment_id が実在のセグメントIDと
   * ずれていないことを示す）。*/
  clampedSegmentIds: number
  /** `repairGroupCoverage`（無音を跨ぐユニットのカバレッジ修復）で分割したユニットの件数。
   * 診断用（0件でも意味を持つ）。*/
  coverageSplits: number
}

/**
 * 書きおこし（元言語）の script を決める。優先順位:
 *   1. settings.alignTokenMode === 'char' → 'japanese'（文字単位に固定）
 *   2. settings.alignTokenMode === 'word' → 'latin'（単語単位に固定）
 *   3. 'auto'（既定） → detectAsrScriptDetail の判定結果を使う
 *   4. 判定に使えるトークンが0件（tokenCount===0）のときのみ、従来どおり
 *      languageProfileConfig（ユーザーが自由入力する書きおこし言語ラベル由来）にフォールバック
 *
 * 3.のASR出力からの自動判定を既定にする理由: WhisperX自体が
 * `LANGUAGES_WITHOUT_SPACES=["ja","zh"]` のときだけ1文字ずつ、それ以外は単語ごとに
 * タイムスタンプを返す仕様のため、言語ラベル（ユーザーの自由入力）に頼るより
 * 実際の出力構造を見た方が確実（設定の誤り・リモート実行での言語不明にも強い）。
 */
function resolveTranscriptScript(
  settings: AdminSettings,
  segments: readonly CorrectedSegmentLite[],
): TranscriptScriptResolution {
  if (settings.alignTokenMode === 'char') {
    return { script: 'japanese', source: 'setting_char' }
  }
  if (settings.alignTokenMode === 'word') {
    return { script: 'latin', source: 'setting_word' }
  }
  const detection = detectAsrScriptDetail(segments)
  if (detection.tokenCount === 0) {
    return { script: loadLanguageProfileConfig(settings).transcript.script, source: 'fallback_profile' }
  }
  return {
    script: detection.script,
    source: 'auto_detected',
    meanTokenLength: detection.meanTokenLength,
    tokenCount: detection.tokenCount,
  }
}

/**
 * `TranscriptScriptResolution` を localPipeline.ts のトレース summary 用に人が読める文字列へ整形する。
 * 例: 'トークン単位=単語(自動判定, 平均長4.0, 13393トークン)' / 'トークン単位=文字(設定で固定)'
 */
export function formatTranscriptScriptSummary(resolution: TranscriptScriptResolution): string {
  const unitLabel = resolution.script === 'latin' ? '単語' : '文字'
  switch (resolution.source) {
    case 'setting_char':
    case 'setting_word':
      return `トークン単位=${unitLabel}(設定で固定)`
    case 'auto_detected':
      return `トークン単位=${unitLabel}(自動判定, 平均長${resolution.meanTokenLength!.toFixed(1)}, ${resolution.tokenCount}トークン)`
    case 'fallback_profile':
      return `トークン単位=${unitLabel}(判定不能のため言語ラベル設定にフォールバック)`
    default:
      return `トークン単位=${unitLabel}`
  }
}

/**
 * `SemanticSplitJaResult.collapsedMerged`（`resolveCollapsedUnits` が隣へ統合した
 * 「潰れたキュー」の件数）を localPipeline.ts のトレース summary 用に整形する。
 * 0件のときも表示する（上流の異常を検知する指標になるため）。
 */
export function formatCollapsedMergedSummary(collapsedMerged: number): string {
  return `潰れキュー統合=${collapsedMerged}件`
}

/**
 * `SemanticSplitJaResult.clampedSegmentIds`（`sourceSegmentId` が ASR セグメント範囲に
 * 存在せず、最も近いセグメントへ丸めたグループの件数）を localPipeline.ts の
 * トレース summary 用に整形する。0件のときも表示する（LLMが返す source_segment_id が
 * 実在のセグメントIDとずれていないことを示す指標になるため）。
 */
export function formatClampedSegmentIdsSummary(clampedSegmentIds: number): string {
  return `セグメントID丸め=${clampedSegmentIds}件`
}

/**
 * `SemanticSplitJaResult.coverageSplits`（`repairGroupCoverage` が無音を跨ぐユニットの
 * カバレッジ修復のために分割した件数）を localPipeline.ts のトレース summary 用に整形する。
 * 0件のときも表示する（無音を跨ぐ発話がどれだけ本文カバレッジ修復を要したかの指標になるため）。
 */
export function formatCoverageSplitsSummary(coverageSplits: number): string {
  return `カバレッジ修復分割=${coverageSplits}件`
}

export async function semanticSplitJa(
  segments: CorrectedSegmentLite[],
  settings: AdminSettings,
  thresholds: PipelineThresholds,
  glossaryTerms: string[] = [],
): Promise<SemanticSplitJaResult> {
  // 書きおこし（元言語）の script。ラテン文字はWhisperXが単語単位でタイムスタンプを
  // 返すため、buildAsrCharStreamWithRanges/alignCuesToAsr の両方に伝える必要がある
  // （asrAlignment.ts参照）。
  const scriptResolution = resolveTranscriptScript(settings, segments)
  const transcriptScript = scriptResolution.script
  const maxSegmentsPerRequest = resolveAiProvider(settings) === 'local_openai'
    ? LOCAL_MAX_SEGMENTS_PER_REQUEST
    : MAX_SEGMENTS_PER_REQUEST
  const batches: CorrectedSegmentLite[][] = []
  for (let index = 0; index < segments.length; index += maxSegmentsPerRequest) {
    batches.push(segments.slice(index, index + maxSegmentsPerRequest))
  }
  const requestConcurrency = normalizeConcurrency(settings.apiRequestConcurrency, 1)
  const batchResults = await mapWithConcurrency(
    batches.length,
    requestConcurrency,
    index => callSemanticSplitApi(batches[index], settings),
  )
  const allUnits = batchResults.flatMap(r => r.units)
  const undercovered = new Set<number>()
  for (const r of batchResults) {
    for (const id of r.undercoveredSegmentIds) undercovered.add(id)
  }
  const unitsBySegment = new Map<number, RawSemanticUnit[]>()
  for (const unit of allUnits) {
    const list = unitsBySegment.get(unit.sourceSegmentId) ?? []
    list.push(unit)
    unitsBySegment.set(unit.sourceSegmentId, list)
  }

  // セグメント順にユニットを収集し、フォールバック込みで全セグメント分をフラットな
  // 時系列順リストにする。アライメントはこのあと由来セグメント±1の範囲に限定して行う
  // （`alignUnitsGlobally` 参照。実測で99.7%が由来セグメント1つに収まるため）。
  const orderedUnits: RawSemanticUnit[] = []
  for (const segment of segments) {
    let segmentUnits = unitsBySegment.get(segment.id) ?? []
    // LLM 失敗 or カバレッジ不足 → 原文をそのまま 1 ユニットとして fallback
    if (segmentUnits.length === 0 || undercovered.has(segment.id)) {
      const fallbackText = normalizeSpaces(segment.correctedText || segment.text)
      if (!fallbackText) continue
      segmentUnits = [{
        unitId: `u_fallback_${segment.id}`,
        sourceSegmentId: segment.id,
        jaText: fallbackText,
        canMergeWithNext: false,
      }]
    }
    orderedUnits.push(...segmentUnits)
  }

  const { stream: asrStream, ranges: segmentRanges } = buildAsrCharStreamWithRanges(segments, { script: transcriptScript })
  let aligned: AlignedUnit[]
  let collapsedMerged = 0
  let clampedSegmentIds = 0
  let coverageSplits = 0
  if (asrStream.length === 0) {
    aligned = alignUnitsProportionalFallback(orderedUnits, segments, thresholds, glossaryTerms)
  } else {
    const globallyAligned = alignUnitsGlobally(orderedUnits, asrStream, segmentRanges, thresholds, glossaryTerms, transcriptScript)
    const resolved = resolveCollapsedUnits(globallyAligned.units)
    aligned = resolved.units
    collapsedMerged = resolved.collapsedMerged
    clampedSegmentIds = globallyAligned.clampedSegmentIds
    coverageSplits = globallyAligned.coverageSplits
  }

  return { blocks: buildJaBlocks(aligned), scriptResolution, collapsedMerged, clampedSegmentIds, coverageSplits }
}

/** アライン済みユニット列から JaBlock 配列を組み立てる（id採番・空テキストスキップ）。*/
function buildJaBlocks(aligned: readonly AlignedUnit[]): JaBlock[] {
  const blocks: JaBlock[] = []
  let nextId = 1
  for (const item of aligned) {
    const jaText = normalizeSpaces(item.unit.jaText)
    if (!jaText) continue
    blocks.push({
      id: nextId,
      start: item.start,
      end: item.end,
      jaText,
      jaChars: jaText.replace(/\s/g, '').length,
      alignConf: item.alignConf,
      words: item.words,
      alignMatchRate: item.matchRate,
      sourceRefs: sourceRefsForUnit(item.unit),
    })
    nextId += 1
  }
  return blocks
}

export const __testing = {
  buildSemanticSplitPrompt,
  filterUnitsToBatch,
  alignUnitsGlobally,
  alignUnitsProportionalFallback,
  buildJaBlocks,
  resolveTranscriptScript,
  isCollapsedUnit,
  resolveCollapsedUnits,
  groupUnitsBySegment,
  resolveSegmentWindow,
  speechRunsInRange,
  uncoveredIntervals,
  repairGroupCoverage,
}
