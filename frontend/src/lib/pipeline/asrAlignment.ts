import { diffChars, type Change } from 'diff'
import type { TranscriptSegment, WordTimestamp } from './types'

/**
 * WhisperXの単語タイムスタンプを1文字単位に展開したASR文字ストリームの要素。
 * `score` は WhisperX の word-level confidence（0-1）。欠損時は 1（高信頼）扱いにする。
 */
export interface AsrChar {
  char: string
  start: number
  end: number
  score: number
}

/**
 * 1キュー（字幕候補テキスト）をASR文字ストリームへ整合させた結果の包絡。
 * `confidence` は 'exact'（高一致率で包絡確定）/ 'partial'（一部一致）/
 * 'interpolated'（一致不足のため前後キューから補間）のいずれか。
 */
export interface AlignedSpan {
  startSec: number
  endSec: number
  matchedChars: number
  totalChars: number
  matchRate: number
  confidence: 'exact' | 'partial' | 'interpolated'
  /**
   * マッチしたASR文字ストリーム上の索引範囲（閉区間、両端含む）。呼び出し側が
   * `AsrChar[]` をスライスして `WordTimestamp[]` を復元するために使う。
   * `confidence === 'interpolated'` の場合は最終的な時刻がASR実測値そのものではない
   * （前後の確定キューから按分した値）ため、対応するASR文字範囲が無いことを
   * 明示するために null にする。
   */
  firstCharIndex: number | null
  lastCharIndex: number | null
}

/**
 * `buildAsrCharStream` に渡すオプション。`AlignCuesToAsrOptions` が継承しているのは、
 * パイプライン側で1つのオプションオブジェクトを構築し、`buildAsrCharStream` →
 * `alignCuesToAsr` の両方に自然に渡せるようにするため（`alignCuesToAsr` 自体は
 * 既に構築済みの `AsrChar[]` を受け取るだけで `maxWordDurationSec` を直接は使わない）。
 */
export interface AsrCharStreamOptions {
  /**
   * 1単語の発話時間（`end - start`）の上限（秒）。これを超える単語は
   * `start + maxWordDurationSec` を実効終端として文字を線形補間する。デフォルト 0.6。
   *
   * 根拠: WhisperXは文間のポーズ（無音区間）を直前モーラの `end` に吸収することがあり、
   * 実データでは単語durationの中央値0.120秒に対し8秒超の異常値が観測される（score自体は
   * 高いため、既存のscoreベース端点トリムでは検出できない）。0.6秒は中央値の5倍に相当し、
   * 吸収されたポーズを除去しつつ、正当な長音（伸ばし棒など）の長さは保持できる値として選定。
   */
  maxWordDurationSec?: number
}

export interface AlignCuesToAsrOptions extends AsrCharStreamOptions {
  /** ASR側の窓幅（正規化後の文字数）。デフォルト 4000。 */
  windowChars?: number
  /** 窓の前後に持たせるマージン（正規化後の文字数）。セグメント跨ぎの融合を吸収する。デフォルト 800。 */
  windowMarginChars?: number
  /** jsdiff diffChars に渡す maxEditLength。巨大な非類似テキストでの計算コスト爆発を防ぐ安全弁。 */
  maxEditLength?: number
}

const DEFAULT_WINDOW_CHARS = 4000
const DEFAULT_WINDOW_MARGIN_CHARS = 800
// 窓幅(4000) + 前後マージン(800*2) 規模のテキスト同士を比較しても十分に打ち切られない値。
// 一方でテストからは意図的に小さい値を渡すことで「打ち切り→interpolated フォールバック」を検証できる。
const DEFAULT_MAX_EDIT_LENGTH = 20000
// 単語duration中央値(0.120s)の5倍。詳細は AsrCharStreamOptions.maxWordDurationSec を参照。
const DEFAULT_MAX_WORD_DURATION_SEC = 0.6

const LOW_SCORE_THRESHOLD = 0.2
const EXACT_MATCH_RATE_THRESHOLD = 0.8
const MIN_MATCHED_CHARS_FLOOR = 4
const MIN_MATCHED_CHARS_RATIO = 0.35

interface ResolvedOptions {
  windowChars: number
  windowMarginChars: number
  maxEditLength: number
}

interface ResolvedAsrCharStreamOptions {
  maxWordDurationSec: number
}

interface CueBound {
  start: number
  end: number
}

interface ProvisionalSpanInfo {
  startSec: number | null
  endSec: number | null
  matchedChars: number
  totalChars: number
  needsInterpolation: boolean
  /** マッチしたASR文字インデックスのスコアトリム後の範囲（閉区間）。マッチ無しは null。*/
  firstCharIndex: number | null
  lastCharIndex: number | null
}

interface TimedSpan {
  startSec: number
  endSec: number
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}

// semanticSplitJa.ts の normalizeTimingText と同じ規則（正規化のズレがあるとASR側と
// キュー側で文字列が食い違い、diff が破綻するため意図的にコピーして同期させている）。
function normalizeSpacesLocal(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function normalizeTimingText(text: string): string {
  // 元の semanticSplitJa.ts の正規表現とバイト一致させたいが、`\[` は文字クラス内では
  // 不要なエスケープで ESLint(no-useless-escape) に引っかかるため、挙動を変えずに `[` へ修正。
  return normalizeSpacesLocal(text).replace(/[。、「」『』（）()［］[\]！？!?・,，、.\s]/g, '')
}

function wordToChars(word: WordTimestamp, maxWordDurationSec: number): AsrChar[] {
  const text = normalizeTimingText(String(word.word ?? ''))
  const length = text.length
  if (length === 0) return []
  // ポーズ吸収対策のCAP。start は発話開始として信頼できるため変更せず、
  // end のみを start + maxWordDurationSec で頭打ちにしてから文字ごとに線形補間する。
  const effectiveEnd = Math.min(word.end, word.start + maxWordDurationSec)
  const duration = (effectiveEnd - word.start) / length
  const score = typeof word.score === 'number' && Number.isFinite(word.score) ? word.score : 1
  return Array.from({ length }, (_, k) => ({
    char: text[k],
    start: word.start + duration * k,
    end: word.start + duration * (k + 1),
    score,
  }))
}

function resolveAsrCharStreamOptions(options?: AsrCharStreamOptions): ResolvedAsrCharStreamOptions {
  return {
    maxWordDurationSec: options?.maxWordDurationSec ?? DEFAULT_MAX_WORD_DURATION_SEC,
  }
}

/**
 * WhisperXのセグメント列から、ASR文字ストリーム（1文字=1エントリ、時刻つき）を構築する。
 * セグメント跨ぎの補正結果を大域アライメントで扱えるよう、講義全体を1本の文字列とみなす。
 */
export function buildAsrCharStream(
  segments: readonly TranscriptSegment[],
  options?: AsrCharStreamOptions,
): AsrChar[] {
  const { maxWordDurationSec } = resolveAsrCharStreamOptions(options)
  return segments.flatMap(segment => {
    const words = [...(segment.words ?? [])]
      .filter(word => Number.isFinite(word.start) && Number.isFinite(word.end))
      .sort((a, b) => a.start - b.start || a.end - b.end)
    return words.flatMap(word => wordToChars(word, maxWordDurationSec))
  })
}

function resolveOptions(options?: AlignCuesToAsrOptions): ResolvedOptions {
  return {
    windowChars: options?.windowChars ?? DEFAULT_WINDOW_CHARS,
    windowMarginChars: options?.windowMarginChars ?? DEFAULT_WINDOW_MARGIN_CHARS,
    maxEditLength: options?.maxEditLength ?? DEFAULT_MAX_EDIT_LENGTH,
  }
}

function charsToString(chars: readonly AsrChar[]): string {
  return chars.map(c => c.char).join('')
}

function computeCueBounds(normCues: readonly string[]): CueBound[] {
  const bounds: CueBound[] = []
  let cursor = 0
  for (const text of normCues) {
    bounds.push({ start: cursor, end: cursor + text.length })
    cursor += text.length
  }
  return bounds
}

/**
 * キューを正規化後の文字数で `windowChars` 以下になるようグルーピングする。
 * 1キュー単独で `windowChars` を超える場合はそのキューだけで1グループにする（分割しない）。
 */
function chunkCueGroups(normCues: readonly string[], windowChars: number): number[][] {
  const groups: number[][] = []
  let current: number[] = []
  let currentLen = 0
  normCues.forEach((text, index) => {
    if (current.length > 0 && currentLen + text.length > windowChars) {
      groups.push(current)
      current = []
      currentLen = 0
    }
    current.push(index)
    currentLen += text.length
  })
  if (current.length > 0) groups.push(current)
  return groups
}

/**
 * 1窓分の diffChars 結果を走査し、キュー文字インデックス→ASR文字インデックスの対応を
 * globalMatches に書き込む。added（キュー側のみ）/removed（ASR側のみ）は対応なしとして無視する。
 */
function applyWindowMatches(
  changes: readonly Change[],
  windowStartA: number,
  groupCueStart: number,
  globalMatches: Map<number, number>,
): number {
  let aIdx = 0
  let bIdx = 0
  let maxA = -1
  for (const part of changes) {
    if (part.removed) {
      aIdx += part.value.length
      continue
    }
    if (part.added) {
      bIdx += part.value.length
      continue
    }
    const len = part.value.length
    for (let k = 0; k < len; k += 1) {
      const globalA = windowStartA + aIdx + k
      globalMatches.set(groupCueStart + bIdx + k, globalA)
      if (globalA > maxA) maxA = globalA
    }
    aIdx += len
    bIdx += len
  }
  return maxA
}

/**
 * ASR文字ストリームとキュー全体を、窓処理しながら diffChars で突き合わせ、
 * キュー文字インデックス→ASR文字インデックスの対応表を作る。
 *
 * 窓はASR側の文字数（`windowChars`）を基準に区切り、前後に `windowMarginChars` の
 * マージンを持たせる。マージンにより、キューがセグメントを跨いで融合していても
 * 直前の窓で使い切れなかったASR文字を次の窓でも参照でき、対応が途切れない。
 */
function buildGlobalMatches(
  asr: readonly AsrChar[],
  normCues: readonly string[],
  cueBounds: readonly CueBound[],
  cueConcat: string,
  resolved: ResolvedOptions,
): Map<number, number> {
  const globalMatches = new Map<number, number>()
  if (asr.length === 0 || cueConcat.length === 0) return globalMatches

  const asrText = charsToString(asr)
  const groups = chunkCueGroups(normCues, resolved.windowChars)
  const asrCharsPerCueChar = asr.length / cueConcat.length
  let asrCursor = 0

  for (const group of groups) {
    const groupCueStart = cueBounds[group[0]].start
    const groupCueEnd = cueBounds[group[group.length - 1]].end
    const cueWindowText = cueConcat.slice(groupCueStart, groupCueEnd)
    const estimatedAsrLen = Math.max(
      cueWindowText.length,
      Math.round(cueWindowText.length * asrCharsPerCueChar),
    )
    const windowStart = Math.max(0, asrCursor - resolved.windowMarginChars)
    const windowEnd = Math.min(asr.length, asrCursor + estimatedAsrLen + resolved.windowMarginChars)
    const asrWindowText = asrText.slice(windowStart, windowEnd)

    const changes = diffChars(asrWindowText, cueWindowText, { maxEditLength: resolved.maxEditLength })
    if (!changes) {
      // 打ち切り（maxEditLength超過）。この窓のキューは対応なしのまま残り、
      // 後段の buildProvisionalSpans で matchedChars=0 となって自動的に interpolated 扱いになる。
      asrCursor = windowEnd
      continue
    }

    const maxA = applyWindowMatches(changes, windowStart, groupCueStart, globalMatches)
    asrCursor = maxA >= 0 ? Math.min(asr.length, maxA + 1) : windowEnd
  }

  return globalMatches
}

/**
 * 包絡の端の文字が低スコア（アライメント自体が不確か）なら、内側へ向かって
 * score >= LOW_SCORE_THRESHOLD の最初の文字まで端点を寄せる。全部低スコアなら元のまま。
 *
 * 先に「範囲内が全部低スコアか」を独立判定してから左右を寄せる。そうしないと、
 * 左スキャンが `left < maxA` の境界で止まった位置（=右端そのもの）がたまたま
 * 低スコアのままでも「寄せ終わった」と誤認してしまう（境界のオフバイワン）。
 */
function trimEnvelopeByScore(asr: readonly AsrChar[], minA: number, maxA: number): [number, number] {
  const allLow = asr.slice(minA, maxA + 1).every(c => c.score < LOW_SCORE_THRESHOLD)
  if (allLow) return [minA, maxA]
  let left = minA
  while (left < maxA && asr[left].score < LOW_SCORE_THRESHOLD) left += 1
  let right = maxA
  while (right > left && asr[right].score < LOW_SCORE_THRESHOLD) right -= 1
  return [left, right]
}

function buildProvisionalSpans(
  asr: readonly AsrChar[],
  cueBounds: readonly CueBound[],
  globalMatches: ReadonlyMap<number, number>,
): ProvisionalSpanInfo[] {
  return cueBounds.map(({ start, end }) => {
    const totalChars = end - start
    const matchedIndices: number[] = []
    for (let j = start; j < end; j += 1) {
      const a = globalMatches.get(j)
      if (a !== undefined) matchedIndices.push(a)
    }
    if (totalChars === 0 || matchedIndices.length === 0) {
      return {
        startSec: null,
        endSec: null,
        matchedChars: matchedIndices.length,
        totalChars,
        needsInterpolation: true,
        firstCharIndex: null,
        lastCharIndex: null,
      }
    }
    const minA = Math.min(...matchedIndices)
    const maxA = Math.max(...matchedIndices)
    const [leftIdx, rightIdx] = trimEnvelopeByScore(asr, minA, maxA)
    const needsInterpolation = matchedIndices.length < Math.max(MIN_MATCHED_CHARS_FLOOR, totalChars * MIN_MATCHED_CHARS_RATIO)
    return {
      startSec: asr[leftIdx].start,
      endSec: asr[rightIdx].end,
      matchedChars: matchedIndices.length,
      totalChars,
      needsInterpolation,
      firstCharIndex: leftIdx,
      lastCharIndex: rightIdx,
    }
  })
}

/**
 * [from, to) の区間（すべて interpolation 対象）を、正規化後の文字数比で
 * [rangeStart, rangeEnd] の間に線形配分する。27秒窓の比例配分とは異なり、
 * 直前・直後の「確定済みキュー」の実時刻を境界にする。
 */
function distributeRun(
  provisional: readonly ProvisionalSpanInfo[],
  results: TimedSpan[],
  from: number,
  to: number,
  rangeStart: number,
  rangeEnd: number,
): void {
  const chunk = provisional.slice(from, to)
  const totalChunkChars = chunk.reduce((sum, item) => sum + Math.max(1, item.totalChars), 0)
  const span = Math.max(0, rangeEnd - rangeStart)
  let cursor = rangeStart
  for (let k = from; k < to; k += 1) {
    const share = Math.max(1, provisional[k].totalChars) / Math.max(1, totalChunkChars)
    const isLast = k === to - 1
    const end = isLast ? rangeEnd : cursor + span * share
    results[k] = { startSec: cursor, endSec: Math.max(cursor, end) }
    cursor = end
  }
}

function interpolateSpans(provisional: readonly ProvisionalSpanInfo[], asr: readonly AsrChar[]): TimedSpan[] {
  const results: TimedSpan[] = new Array(provisional.length)
  const fallbackStart = asr.length > 0 ? asr[0].start : 0
  const fallbackEnd = asr.length > 0 ? asr[asr.length - 1].end : 0
  let index = 0
  while (index < provisional.length) {
    const info = provisional[index]
    if (!info.needsInterpolation && info.startSec !== null && info.endSec !== null) {
      results[index] = { startSec: info.startSec, endSec: info.endSec }
      index += 1
      continue
    }
    let runEnd = index
    while (runEnd < provisional.length && provisional[runEnd].needsInterpolation) runEnd += 1
    const rangeStart = index > 0 ? results[index - 1].endSec : fallbackStart
    const rangeEnd = runEnd < provisional.length ? (provisional[runEnd].startSec ?? fallbackEnd) : fallbackEnd
    distributeRun(provisional, results, index, runEnd, rangeStart, rangeEnd)
    index = runEnd
  }
  return results
}

/**
 * diffベースの大域アライメントは理論上キュー間の重なりを生まないはずだが、
 * 端点補正やフォールバックの組み合わせで万一発生した場合に中点で分割して解消する。
 */
function enforceMonotonicSpans(spans: readonly TimedSpan[]): TimedSpan[] {
  const result = spans.map(span => ({ ...span }))
  for (let i = 0; i < result.length - 1; i += 1) {
    if (result[i].endSec > result[i + 1].startSec) {
      const mid = (result[i].endSec + result[i + 1].startSec) / 2
      result[i] = { ...result[i], endSec: mid }
      result[i + 1] = { ...result[i + 1], startSec: mid, endSec: Math.max(mid, result[i + 1].endSec) }
    }
  }
  return result
}

function resolveConfidence(info: ProvisionalSpanInfo): AlignedSpan['confidence'] {
  if (info.needsInterpolation) return 'interpolated'
  const matchRate = info.totalChars > 0 ? info.matchedChars / info.totalChars : 0
  return matchRate >= EXACT_MATCH_RATE_THRESHOLD ? 'exact' : 'partial'
}

function finalizeSpan(span: TimedSpan, info: ProvisionalSpanInfo): AlignedSpan {
  const confidence = resolveConfidence(info)
  return {
    startSec: round(span.startSec),
    endSec: round(Math.max(span.startSec, span.endSec)),
    matchedChars: info.matchedChars,
    totalChars: info.totalChars,
    matchRate: info.totalChars > 0 ? info.matchedChars / info.totalChars : 0,
    confidence,
    // interpolated は前後の確定キューから按分した時刻であり、firstCharIndex/lastCharIndex が
    // 指すASR実測範囲とは対応しないため、呼び出し側の誤用（例: この範囲をwordsとして採用）を
    // 防ぐために意図的に null にする。
    firstCharIndex: confidence === 'interpolated' ? null : info.firstCharIndex,
    lastCharIndex: confidence === 'interpolated' ? null : info.lastCharIndex,
  }
}

/**
 * 複数のキュー（字幕候補テキスト）を、ASR文字ストリーム全体に対して大域的に整合させる。
 * セグメント境界に縛られないため、補正LLMがセグメントを跨いで文を再構成しても
 * 各キューの時刻を正しく求められる。
 */
export function alignCuesToAsr(
  cueTexts: readonly string[],
  asr: readonly AsrChar[],
  options?: AlignCuesToAsrOptions,
): AlignedSpan[] {
  if (cueTexts.length === 0) return []
  const resolved = resolveOptions(options)
  const normCues = cueTexts.map(normalizeTimingText)
  const cueBounds = computeCueBounds(normCues)
  const cueConcat = normCues.join('')

  const globalMatches = buildGlobalMatches(asr, normCues, cueBounds, cueConcat, resolved)
  const provisional = buildProvisionalSpans(asr, cueBounds, globalMatches)
  const interpolated = interpolateSpans(provisional, asr)
  const monotonic = enforceMonotonicSpans(interpolated)

  return monotonic.map((span, index) => finalizeSpan(span, provisional[index]))
}

export const __testing = {
  normalizeTimingText,
  chunkCueGroups,
  trimEnvelopeByScore,
}
