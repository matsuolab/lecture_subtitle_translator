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
import { alignCuesToAsr, buildAsrCharStream, detectAsrScriptDetail, type AlignedSpan, type AsrChar } from './asrAlignment'

const MAX_SEGMENTS_PER_REQUEST = 4
const LOCAL_MAX_SEGMENTS_PER_REQUEST = 2
// オーバーロング分割の再アライン回数上限。旧実装(alignUnits)のループ回数を踏襲。
const MAX_OVERLONG_SPLIT_LOOPS = 8

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

function chooseSafeSplitIndex(text: string, preferred: number, glossaryTerms: string[]): number {
  const min = Math.max(1, Math.floor(text.length * 0.25))
  const max = Math.min(text.length - 1, Math.ceil(text.length * 0.75))
  const ranges = noBreakRanges(text, glossaryTerms)
  const punctuation = ['。', '、', '，', '．', '！', '？']
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

/**
 * 全ユニットのテキストを ASR 文字ストリーム全体に一括で大域アライメントする。
 * セグメント境界に縛られないため、補正LLMがセグメントを跨いで文を再構成しても
 * 各ユニットの時刻を正しく求められる（詳細は asrAlignment.ts 参照）。
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
 */
function alignUnitsGlobally(
  units: RawSemanticUnit[],
  asrStream: readonly AsrChar[],
  thresholds: PipelineThresholds,
  glossaryTerms: string[],
  script: LanguageScript = 'japanese',
): AlignedUnit[] {
  const initialSpans = alignCuesToAsr(units.map(unit => unit.jaText), asrStream, { script })
  let entries: OverlongScanEntry[] = units.map((unit, index) => ({
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

  return entries.map(entry => toAlignedUnit(entry.unit, entry.span, asrStream))
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
  type Piece = { jaText: string; words: WordTimestamp[] }
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
    const piece: Piece = { jaText: entries[i].unit.jaText, words: entries[i].words }
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
    units.push({
      ...entries[i],
      unit: { ...entries[i].unit, jaText },
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

export async function semanticSplitJa(
  segments: CorrectedSegmentLite[],
  settings: AdminSettings,
  thresholds: PipelineThresholds,
  glossaryTerms: string[] = [],
): Promise<SemanticSplitJaResult> {
  // 書きおこし（元言語）の script。ラテン文字はWhisperXが単語単位でタイムスタンプを
  // 返すため、buildAsrCharStream/alignCuesToAsr の両方に伝える必要がある（asrAlignment.ts参照）。
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
  // 時系列順リストにする。アライメントはこのあとセグメント境界を無視して一括で行う。
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

  const asrStream = buildAsrCharStream(segments, { script: transcriptScript })
  let aligned: AlignedUnit[]
  let collapsedMerged = 0
  if (asrStream.length === 0) {
    aligned = alignUnitsProportionalFallback(orderedUnits, segments, thresholds, glossaryTerms)
  } else {
    const globallyAligned = alignUnitsGlobally(orderedUnits, asrStream, thresholds, glossaryTerms, transcriptScript)
    const resolved = resolveCollapsedUnits(globallyAligned)
    aligned = resolved.units
    collapsedMerged = resolved.collapsedMerged
  }

  return { blocks: buildJaBlocks(aligned), scriptResolution, collapsedMerged }
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
}
