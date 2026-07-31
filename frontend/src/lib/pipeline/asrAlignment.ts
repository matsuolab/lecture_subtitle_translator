import { diffArrays, type ArrayChange } from 'diff'
import type { TranscriptSegment, WordTimestamp } from './types'
import type { LanguageScript } from './languageProfileConfig'

/**
 * ASR文字ストリームの1エントリ。`script`（AsrCharStreamOptions参照）によって粒度が変わる:
 * - `japanese` / `generic`（既定）: WhisperXの1単語トークンを正規化後の文字数に分解し、
 *   1文字=1エントリにする（従来どおり）。
 * - `latin`: WhisperXの1単語トークン=1エントリ（分解しない）。`char` にはトークンの
 *   元テキスト（trimのみ）を保持し、比較キー（小文字化＋前後句読点除去）は比較時に
 *   都度算出する（`normalizeLatinToken` 参照）。
 *
 * 型名・フィールド名は script によらず共通（`AlignedSpan.firstCharIndex`/`lastCharIndex`
 * も含め「文字インデックス」という名前のまま「トークンインデックス」の意味で使う）。
 * `script` を追加した際に呼び出し側の破壊的変更を避けるための意図的な選択。
 *
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
  /**
   * 書きおこし言語の文字体系。デフォルト `'japanese'`（後方互換）。
   *
   * 根拠（実データ: Sam Altman 70分・英語音声）: WhisperXはラテン文字では単語単位で
   * タイムスタンプを返す（1トークンの中央長4文字）。これを日本語と同じ1文字単位に
   * 分解すると、実測の単語時刻を線形補間で捨ててしまい、開始時刻のズレが1秒超のキューが
   * 54件→373件（51%）に激増する不具合が実測された。`latin` はこれを避けるため単語を
   * 分解しない。`japanese`/`generic` は従来どおり1文字単位（日本語は1文字=1トークンが
   * 実測でも大半のため分解の必要がない）。
   */
  script?: LanguageScript
}

export interface AlignCuesToAsrOptions extends AsrCharStreamOptions {
  /**
   * ASR側の窓幅（トークン数。japanese/genericは文字数、latinは単語数）。
   * 未指定時は `DEFAULT_WINDOW_SEC` を、渡された `asr` の実測密度（トークン数/秒）で
   * トークン数へ換算する（`computeAsrDensityPerSec` 参照）。明示指定時は常にそちらを優先する
   * （既存テスト・呼び出し側の互換性のため）。
   */
  windowChars?: number
  /**
   * 窓の前後に持たせるマージン（トークン数）。セグメント跨ぎの融合を吸収する。
   * `windowChars` と同様、未指定時は `DEFAULT_WINDOW_MARGIN_SEC` を実測密度で換算する。
   */
  windowMarginChars?: number
  /** jsdiff diffArrays に渡す maxEditLength。巨大な非類似テキストでの計算コスト爆発を防ぐ安全弁。 */
  maxEditLength?: number
}

// 秒基準の窓幅・マージン。トークンの密度が言語で異なる（実測: 英語191トークン/分 vs
// 日本語295文字/分、約1.5倍差）ため、トークン数固定の窓幅では言語ごとに実際の時間幅が
// ずれてしまう。渡された asr ストリームの実測密度（トークン数/秒）でトークン数へ換算する
// ことで、どの言語でも「概ね同じ時間幅の窓」になるようにする。
// 800秒・160秒は、日本語の実測密度（295文字/分≒4.92文字/秒）で換算すると
// 800*4.92≈3933 / 160*4.92≈787 となり、従来の固定値(4000/800)とほぼ一致する
// （＝日本語の既存挙動を変えないように選定した値）。
const DEFAULT_WINDOW_SEC = 800
const DEFAULT_WINDOW_MARGIN_SEC = 160
// asr が空、または start===end（密度0除算）等で密度を計算できない場合のフォールバック。
// 旧実装の固定デフォルト値をそのまま踏襲する。
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

// detectAsrScriptDetail が「文字単位（japanese）」と判定する平均トークン長の上限。
// 根拠（実測6データセット）: 日本語5本の平均文字トークン長は1.0（例外なし）、英語1本は4.0。
// WhisperXは LANGUAGES_WITHOUT_SPACES=["ja","zh"] のみ1文字ずつ、それ以外は空白区切りの
// 単語ごとにタイムスタンプを返す仕様（alignment.py）のため、構造上「文字単位なら必ず約1.0、
// 単語単位なら1.0を明確に超える」（平均1文字の単語しかない空白区切り言語は存在しない）。
// 1.2 は実測1.0対4.0の間に位置する値で、あえて日本語(1.0)寄りに設定することで、
// 万一の曖昧域は「今日まで動いている文字単位の挙動」に倒す安全側の閾値にしている。
const SCRIPT_DETECTION_MEAN_LENGTH_THRESHOLD = 1.2
// 有効トークンが0件（判定不能）のときに detectAsrScriptDetail が返す既定値。
// 従来の既定（resolveAsrCharStreamOptions の script 既定）と揃え、判定不能時の挙動を変えない。
const DEFAULT_DETECTED_SCRIPT: LanguageScript = 'japanese'

// 隣接する対応ペア間の excess（ASR側の飛び − キュー側の飛び）がこの値を超えたら
// 「誤マッチによる遠方への飛び」とみなしてかたまりを分割する。
// 根拠（実データ6本・21,196件の隣接対応ペアの実測分布）:
//   - 正当な飛び（LLM補正で対応が付かなかったASR文字数）は excess>0 が129件のみで、
//     中央値2文字、90%が18文字以下。
//   - 誤マッチ（短い共通片が遠方の同じ表現へ飛ぶ）による excess は最小でも49文字
//     （実測 49/50/67/71/116/117/133/135/452/455/540）。
//   - 両者の間（18〜49）の中間である30を閾値に採る。
const EXCESS_SPLIT_THRESHOLD = 30

// trimEnvelopeByScore が左右それぞれから内側へ寄せてよい文字数の上限（範囲長に対する比率）。
// 根拠: Inside Anthropicのキュー(id=350, 10文字)で、一致範囲10文字のうち大半が
// LOW_SCORE_THRESHOLD未満だったため、上限が無い実装だと包絡がfirstCharIndex=lastCharIndex
// （ASR1文字ぶん=0.04秒）まで潰れた（旧実装では12.21秒）。低スコア端点のトリム自体は
// 有用だが、一致している文字を丸ごと切り捨てて0秒キューを作るのは字幕として明確な
// 不具合のため、左右合わせて元の範囲長の50%（片側25%）までしか削らないよう制限する。
const TRIM_MAX_RATIO_PER_SIDE = 0.25

// MIN_SPAN_SEC: 補間で配分されたスロットの幅がこの値未満なら「退化」とみなす閾値。
// semanticSplitJa.ts の toAlignedUnit / distributeAssignedRun が
// `Math.max(span.startSec + 0.05, span.endSec)` で使っている下限(0.05秒)と揃えている
// （最終的に表示される字幕の最小幅としてすでに合意されている値のため）。
const MIN_SPAN_SEC = 0.05

// extendEnvelopes が「未対応文字を持つ側」に限り、隣接キューの採用範囲との間に空いている
// ASR領域を丸ごと取り込んでよい上限（秒）。
// 根拠: Inside Anthropicで4件・DL講義day4で4件、「字幕テキストが持つ文字なのに包絡が
// 届かず発話中に字幕が出ない」区間が残っていた。現在の伸長は未対応キュー文字数ぶんだけ
// ASR側を伸ばすため、言い換えやASR側のフィラー混入でASR側の未カバー領域の方が長い場合に
// 届かない。2.0秒以内なら「同じ発話が続いている隙間」とみなして丸ごと取り込み、それを
// 超える場合は無関係な発話区間まで飲み込むリスクがあるため従来どおり文字数ぶんに留める。
const MAX_GAP_ABSORB_SEC = 2.0

interface ResolvedOptions {
  windowChars: number
  windowMarginChars: number
  maxEditLength: number
  script: LanguageScript
}

interface ResolvedAsrCharStreamOptions {
  maxWordDurationSec: number
  script: LanguageScript
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
  /**
   * 採用したかたまりの先頭ペアより前にある、キュー自身の未対応文字数。
   * 包絡の開始をASR側でこの文字数ぶん手前へ伸ばす際に使う（extendEnvelopes参照）。
   */
  leadingUnmatched: number
  /** 採用したかたまりの末尾ペアより後にある、キュー自身の未対応文字数。終了側の伸長に使う。 */
  trailingUnmatched: number
}

interface TimedSpan {
  startSec: number
  endSec: number
}

/** キュー文字インデックス→ASR文字インデックスの1対応ペア。cueCharIndex は cueTokensFlat 上の絶対位置。 */
interface CharPair {
  cueCharIndex: number
  asrIndex: number
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

/**
 * ラテン文字トークンの比較キー: 小文字化し、前後の句読点（英数字・アポストロフィ・
 * ハイフン以外の文字）を除去する。語中のアポストロフィ（`I'm`）やハイフン
 * （`co-founder`）は正しい単語の一部として保持する（前後だけを剥がす）。
 * 記号のみのトークン（例: `...`）は結果が空文字列になり、呼び出し側で捨てられる。
 */
function normalizeLatinToken(raw: string): string {
  return raw.toLowerCase().replace(/^[^a-z0-9'-]+|[^a-z0-9'-]+$/g, '')
}

/**
 * ラテン文字キューの分割規則: 先に空白で単語へ分割してから、単語ごとに
 * `normalizeLatinToken` で正規化する。
 *
 * 既存の `normalizeTimingText` は句読点だけでなく空白も除去するため、先に正規化してから
 * 分割しようとすると英語では単語境界が失われる（実測: "Today I'm sitting down" が
 * "TodayImsittingdown" のように連結され、"the"/"and" 等の短い文字列が無数に再出現して
 * 遠方への誤マッチが大量発生した）。分割してから正規化することでこれを避ける。
 * 正規化結果が空文字になる語（記号のみの語）は捨てる。
 */
function tokenizeLatinCueText(text: string): string[] {
  return normalizeSpacesLocal(text)
    .split(' ')
    .filter(Boolean)
    .map(normalizeLatinToken)
    .filter(key => key.length > 0)
}

/**
 * キューを比較用トークン配列へ変換する。`japanese`/`generic` は従来どおり1文字ずつ
 * （句読点・空白は除去）、`latin` は空白分割後に単語ごと正規化する。
 */
function tokenizeCueText(text: string, script: LanguageScript): string[] {
  if (script === 'latin') return tokenizeLatinCueText(text)
  return Array.from(normalizeTimingText(text))
}

/**
 * ASR側トークンとキュー側トークンの一致判定。`latin` はASR側トークン（単語の元テキスト、
 * 未正規化）を都度 `normalizeLatinToken` して比較する（キュー側は既に正規化済みの比較
 * キー配列として渡ってくる）。`japanese`/`generic` は文字そのものの一致で十分
 * （両側とも既に `normalizeTimingText` 済みの1文字）。
 */
function makeAsrTokenComparator(script: LanguageScript): (asrToken: string, cueToken: string) => boolean {
  if (script === 'latin') {
    return (asrToken, cueToken) => normalizeLatinToken(asrToken) === cueToken
  }
  return (asrToken, cueToken) => asrToken === cueToken
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

/**
 * ラテン文字用: WhisperXの単語トークンを分解せず1エントリのまま採用する。
 * 実測（Sam Altman 70分・英語音声）: 1トークンの中央長は4文字で、日本語のような
 * 1文字=1トークン分解を行うと単語単位の実測タイムスタンプを線形補間で捨ててしまう。
 * `start` はそのまま、`end` は他の script と同様 `maxWordDurationSec` でCAPする。
 * 比較キー（`normalizeLatinToken`）が空文字になるトークン（記号のみ等）は捨てる。
 */
function wordToAsrToken(word: WordTimestamp, maxWordDurationSec: number): AsrChar[] {
  const raw = String(word.word ?? '').trim()
  if (!raw || normalizeLatinToken(raw).length === 0) return []
  const effectiveEnd = Math.min(word.end, word.start + maxWordDurationSec)
  const score = typeof word.score === 'number' && Number.isFinite(word.score) ? word.score : 1
  return [{ char: raw, start: word.start, end: effectiveEnd, score }]
}

function resolveAsrCharStreamOptions(options?: AsrCharStreamOptions): ResolvedAsrCharStreamOptions {
  return {
    maxWordDurationSec: options?.maxWordDurationSec ?? DEFAULT_MAX_WORD_DURATION_SEC,
    script: options?.script ?? 'japanese',
  }
}

/**
 * WhisperXのセグメント列から、ASR文字ストリーム（時刻つきトークン列）を構築する。
 * セグメント跨ぎの補正結果を大域アライメントで扱えるよう、講義全体を1本の列とみなす。
 * `script`（既定 `japanese`）によって粒度が変わる。詳細は `AsrCharStreamOptions.script` 参照。
 */
export function buildAsrCharStream(
  segments: readonly TranscriptSegment[],
  options?: AsrCharStreamOptions,
): AsrChar[] {
  const { maxWordDurationSec, script } = resolveAsrCharStreamOptions(options)
  const isLatin = script === 'latin'
  return segments.flatMap(segment => {
    const words = [...(segment.words ?? [])]
      .filter(word => Number.isFinite(word.start) && Number.isFinite(word.end))
      .sort((a, b) => a.start - b.start || a.end - b.end)
    return words.flatMap(word => (isLatin ? wordToAsrToken(word, maxWordDurationSec) : wordToChars(word, maxWordDurationSec)))
  })
}

/** `detectAsrScriptDetail` の判定結果。 */
export interface AsrScriptDetection {
  /** 判定されたトークン単位。`'japanese'`（文字単位）または `'latin'`（単語単位）のみを返す。 */
  script: LanguageScript
  /** 有効トークン（正規化後に空文字にならなかったトークン）の平均文字長。tokenCount===0 のときは 0。 */
  meanTokenLength: number
  /** 判定に使った有効トークン数。0 なら判定不能（呼び出し側は既定へフォールバックすること）。 */
  tokenCount: number
}

/**
 * WhisperXの生セグメント（`buildAsrCharStream` に渡す前の `segments[].words[]`）から、
 * WhisperXが実際にどちらのトークン単位（1文字ずつ／単語ごと）でタイムスタンプを返したかを判定する。
 *
 * 言語や文字種を推定するのではなく、WhisperX本体の仕様
 * （`alignment.py`: `LANGUAGES_WITHOUT_SPACES = ["ja", "zh"]` のときのみ1文字ずつ、
 * それ以外は空白区切りの単語ごとにタイムスタンプを返す）に基づき、出力トークンの
 * 平均文字長から逆算する。日本語/中国語なら1トークン=1文字なので平均長は必ず約1.0、
 * それ以外の言語では単語単位のため1.0を明確に超える（平均1文字の単語しかない
 * 空白区切り言語は存在しない）。閾値の根拠は `SCRIPT_DETECTION_MEAN_LENGTH_THRESHOLD` 参照。
 *
 * 判定材料は生の word（`buildAsrCharStream` 通過後のASR文字ストリームではない）。
 * ストリーム構築自体が判定結果に依存するため、判定は必ず生データに対して行う。
 */
export function detectAsrScriptDetail(segments: readonly TranscriptSegment[]): AsrScriptDetection {
  let totalLength = 0
  let tokenCount = 0
  for (const segment of segments) {
    for (const word of segment.words ?? []) {
      const normalized = normalizeTimingText(String(word.word ?? ''))
      if (normalized.length === 0) continue
      totalLength += normalized.length
      tokenCount += 1
    }
  }
  if (tokenCount === 0) {
    return { script: DEFAULT_DETECTED_SCRIPT, meanTokenLength: 0, tokenCount: 0 }
  }
  const meanTokenLength = totalLength / tokenCount
  const script: LanguageScript = meanTokenLength <= SCRIPT_DETECTION_MEAN_LENGTH_THRESHOLD ? 'japanese' : 'latin'
  return { script, meanTokenLength, tokenCount }
}

/** `detectAsrScriptDetail` の `script` だけを返す薄いラッパー。詳細（平均長・トークン数）が不要な呼び出し向け。 */
export function detectAsrScript(segments: readonly TranscriptSegment[]): LanguageScript {
  return detectAsrScriptDetail(segments).script
}

function computeAsrDensityPerSec(asr: readonly AsrChar[]): number {
  if (asr.length === 0) return 0
  const span = asr[asr.length - 1].end - asr[0].start
  if (!(span > 0)) return 0
  return asr.length / span
}

/**
 * 秒基準の窓幅定数を、渡された `asr` の実測密度（トークン数/秒）でトークン数へ換算する。
 * `explicit` が指定されていれば常にそちらを優先する（既存オプション・テストの互換性のため）。
 * 密度を計算できない（asr が空、または start===end）場合は `fallback`（旧来の固定値）を使う。
 */
function resolveWindowSize(explicit: number | undefined, sec: number, density: number, fallback: number): number {
  if (explicit !== undefined) return explicit
  if (density <= 0) return fallback
  return Math.max(1, Math.round(sec * density))
}

function resolveOptions(options: AlignCuesToAsrOptions | undefined, asr: readonly AsrChar[]): ResolvedOptions {
  const density = computeAsrDensityPerSec(asr)
  return {
    windowChars: resolveWindowSize(options?.windowChars, DEFAULT_WINDOW_SEC, density, DEFAULT_WINDOW_CHARS),
    windowMarginChars: resolveWindowSize(options?.windowMarginChars, DEFAULT_WINDOW_MARGIN_SEC, density, DEFAULT_WINDOW_MARGIN_CHARS),
    maxEditLength: options?.maxEditLength ?? DEFAULT_MAX_EDIT_LENGTH,
    script: options?.script ?? 'japanese',
  }
}

function computeCueBounds(cueLengths: readonly number[]): CueBound[] {
  const bounds: CueBound[] = []
  let cursor = 0
  for (const length of cueLengths) {
    bounds.push({ start: cursor, end: cursor + length })
    cursor += length
  }
  return bounds
}

/**
 * キューをトークン数で `windowChars` 以下になるようグルーピングする。
 * 1キュー単独で `windowChars` を超える場合はそのキューだけで1グループにする（分割しない）。
 */
function chunkCueGroups(cueLengths: readonly number[], windowChars: number): number[][] {
  const groups: number[][] = []
  let current: number[] = []
  let currentLen = 0
  cueLengths.forEach((length, index) => {
    if (current.length > 0 && currentLen + length > windowChars) {
      groups.push(current)
      current = []
      currentLen = 0
    }
    current.push(index)
    currentLen += length
  })
  if (current.length > 0) groups.push(current)
  return groups
}

/**
 * 1窓分の diffArrays 結果を走査し、キュートークンインデックス→ASRトークンインデックスの
 * 対応を globalMatches に書き込む。added（キュー側のみ）/removed（ASR側のみ）は
 * 対応なしとして無視する。
 */
function applyWindowMatches(
  changes: readonly ArrayChange<string>[],
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
 * ASR文字ストリームとキュー全体を、窓処理しながら diffArrays で突き合わせ、
 * キュートークンインデックス→ASRトークンインデックスの対応表を作る。
 *
 * 窓はASR側のトークン数（`windowChars`）を基準に区切り、前後に `windowMarginChars` の
 * マージンを持たせる。マージンにより、キューがセグメントを跨いで融合していても
 * 直前の窓で使い切れなかったASRトークンを次の窓でも参照でき、対応が途切れない。
 *
 * `diffChars` から `diffArrays` への切り替え: ラテン文字では1トークン=1単語になるため、
 * 文字列比較ではなく比較キー配列同士の比較が必要。`comparator` オプションでASR側トークン
 * （未正規化）とキュー側トークン（正規化済み）の一致を判定する。
 */
function buildGlobalMatches(
  asr: readonly AsrChar[],
  cueTokenLists: readonly string[][],
  cueBounds: readonly CueBound[],
  cueTokensFlat: readonly string[],
  resolved: ResolvedOptions,
): Map<number, number> {
  const globalMatches = new Map<number, number>()
  if (asr.length === 0 || cueTokensFlat.length === 0) return globalMatches

  const asrTokens = asr.map(c => c.char)
  const comparator = makeAsrTokenComparator(resolved.script)
  const groups = chunkCueGroups(cueTokenLists.map(tokens => tokens.length), resolved.windowChars)
  const asrTokensPerCueToken = asr.length / cueTokensFlat.length
  let asrCursor = 0

  for (const group of groups) {
    const groupCueStart = cueBounds[group[0]].start
    const groupCueEnd = cueBounds[group[group.length - 1]].end
    const cueWindowTokens = cueTokensFlat.slice(groupCueStart, groupCueEnd)
    const estimatedAsrLen = Math.max(
      cueWindowTokens.length,
      Math.round(cueWindowTokens.length * asrTokensPerCueToken),
    )
    const windowStart = Math.max(0, asrCursor - resolved.windowMarginChars)
    const windowEnd = Math.min(asr.length, asrCursor + estimatedAsrLen + resolved.windowMarginChars)
    const asrWindowTokens = asrTokens.slice(windowStart, windowEnd)

    const changes = diffArrays(asrWindowTokens, cueWindowTokens, {
      comparator,
      maxEditLength: resolved.maxEditLength,
    })
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
 *
 * 削れる量には上限を設ける（TRIM_MAX_RATIO_PER_SIDE参照）。一致範囲の大半が低スコアな
 * だけで、実際には一致している文字を丸ごと切り捨てて0秒キューを作ってしまうことがある
 * （実測: Inside Anthropicのid=350）ため、左右合わせて元の範囲長の50%までしか削らない。
 */
function trimEnvelopeByScore(asr: readonly AsrChar[], minA: number, maxA: number): [number, number] {
  const allLow = asr.slice(minA, maxA + 1).every(c => c.score < LOW_SCORE_THRESHOLD)
  if (allLow) return [minA, maxA]
  const len = maxA - minA + 1
  const maxTrimPerSide = Math.floor(len * TRIM_MAX_RATIO_PER_SIDE)
  const leftLimit = minA + maxTrimPerSide
  const rightLimit = maxA - maxTrimPerSide
  let left = minA
  while (left < maxA && left < leftLimit && asr[left].score < LOW_SCORE_THRESHOLD) left += 1
  let right = maxA
  while (right > left && right > rightLimit && asr[right].score < LOW_SCORE_THRESHOLD) right -= 1
  return [left, right]
}

function collectCharPairs(start: number, end: number, globalMatches: ReadonlyMap<number, number>): CharPair[] {
  const pairs: CharPair[] = []
  for (let j = start; j < end; j += 1) {
    const a = globalMatches.get(j)
    if (a !== undefined) pairs.push({ cueCharIndex: j, asrIndex: a })
  }
  return pairs
}

/**
 * asrIndex が非減少になる最長部分列を選ぶ（最長非減少部分列, O(n^2) DP）。
 *
 * ペア数は1キューあたり数十件程度なので O(n^2) の素直なDPで十分（実測: ASRインデックスが
 * 逆行する対応が21,196件中95件存在する＝物理的にあり得ない巻き戻り）。
 * 「直前より小さい値を捨てる」貪欲法は禁止: 先頭ペア自体が外れ値だと、以降の正しい
 * 対応をすべて「直前より小さい」として捨ててしまう。
 */
function longestNonDecreasingSubsequence(pairs: readonly CharPair[]): CharPair[] {
  const n = pairs.length
  if (n === 0) return []
  const dpLength = new Array<number>(n).fill(1)
  const prevIndex = new Array<number>(n).fill(-1)
  for (let i = 1; i < n; i += 1) {
    for (let j = 0; j < i; j += 1) {
      if (pairs[j].asrIndex <= pairs[i].asrIndex && dpLength[j] + 1 > dpLength[i]) {
        dpLength[i] = dpLength[j] + 1
        prevIndex[i] = j
      }
    }
  }
  let bestEnd = 0
  for (let i = 1; i < n; i += 1) {
    if (dpLength[i] > dpLength[bestEnd]) bestEnd = i
  }
  const result: CharPair[] = []
  let cursor = bestEnd
  while (cursor !== -1) {
    result.unshift(pairs[cursor])
    cursor = prevIndex[cursor]
  }
  return result
}

/**
 * 非減少列を隣接ペア間の excess（asrIndex差 − cueCharIndex差）で分割し、最大のかたまり
 * （同数なら先に出現した方）を返す。excess は生の飛びではなく差分で判定する必要がある:
 * LLMが長い区間を書き換えた場合、生の飛びは大きくてもキュー側も同じだけ進むため excess は
 * 小さく保たれる。生の飛びで判定すると正当な書き換えを誤って分割してしまう。
 */
function selectLargestCluster(pairs: readonly CharPair[]): CharPair[] {
  if (pairs.length === 0) return []
  const clusters: CharPair[][] = [[pairs[0]]]
  for (let i = 1; i < pairs.length; i += 1) {
    const prev = pairs[i - 1]
    const cur = pairs[i]
    const excess = cur.asrIndex - prev.asrIndex - (cur.cueCharIndex - prev.cueCharIndex)
    if (excess > EXCESS_SPLIT_THRESHOLD) {
      clusters.push([cur])
    } else {
      clusters[clusters.length - 1].push(cur)
    }
  }
  let best = clusters[0]
  for (const cluster of clusters) {
    if (cluster.length > best.length) best = cluster
  }
  return best
}

/**
 * 1キュー分の対応ペアから、外れ値（逆行・遠方への誤マッチ）を除いた「採用かたまり」を
 * 選び、その範囲だけで包絡（startSec/endSec/firstCharIndex/lastCharIndex）を作る。
 * 隣キューへの伸長は行わない（extendEnvelopes で別途行う）。
 */
function buildRawProvisionalSpan(
  asr: readonly AsrChar[],
  start: number,
  end: number,
  globalMatches: ReadonlyMap<number, number>,
): ProvisionalSpanInfo {
  const totalChars = end - start
  const rawPairs = collectCharPairs(start, end, globalMatches)
  if (totalChars === 0 || rawPairs.length === 0) {
    return {
      startSec: null,
      endSec: null,
      matchedChars: rawPairs.length,
      totalChars,
      needsInterpolation: true,
      firstCharIndex: null,
      lastCharIndex: null,
      leadingUnmatched: 0,
      trailingUnmatched: 0,
    }
  }
  const cluster = selectLargestCluster(longestNonDecreasingSubsequence(rawPairs))
  const minA = cluster[0].asrIndex
  const maxA = cluster[cluster.length - 1].asrIndex
  const [leftIdx, rightIdx] = trimEnvelopeByScore(asr, minA, maxA)
  const matchedChars = cluster.length
  const needsInterpolation = matchedChars < Math.max(MIN_MATCHED_CHARS_FLOOR, totalChars * MIN_MATCHED_CHARS_RATIO)
  return {
    startSec: asr[leftIdx].start,
    endSec: asr[rightIdx].end,
    matchedChars,
    totalChars,
    needsInterpolation,
    firstCharIndex: leftIdx,
    lastCharIndex: rightIdx,
    leadingUnmatched: cluster[0].cueCharIndex - start,
    trailingUnmatched: end - 1 - cluster[cluster.length - 1].cueCharIndex,
  }
}

/** 補間対象（採用範囲を持たない）キューの firstCharIndex/lastCharIndex は隣接キューの
 * 伸長境界として信頼できないため、そのようなキューには null を返して制約なしを表す。 */
function adoptedFirstCharIndex(info: ProvisionalSpanInfo | undefined): number | null {
  if (!info || info.needsInterpolation || info.firstCharIndex === null) return null
  return info.firstCharIndex
}

function adoptedLastCharIndex(info: ProvisionalSpanInfo | undefined): number | null {
  if (!info || info.needsInterpolation || info.lastCharIndex === null) return null
  return info.lastCharIndex
}

/**
 * 開始側の伸長先インデックスを決める。
 *
 * 未対応文字が無い側（leadingUnmatched === 0）は絶対に伸ばさない。そこはLLMが削除した
 * 内容や無音であり、伸ばすと二重表示や無音表示になる（実測で「触ってはいけない欠落」
 * 51件・「伸ばすべきもの」11件と切り分け済み）。
 *
 * 未対応文字がある場合、隣（lowerBound）との間に空いているASR領域が MAX_GAP_ABSORB_SEC
 * 以内なら丸ごと取り込む（言い換えやフィラー混入でASR側の未カバー領域がキュー側の
 * 未対応文字数より長いケースの救済）。それを超える場合は従来どおり未対応文字数ぶんの
 * 伸長にとどめる。
 */
function resolveExtendedLeftIdx(
  info: ProvisionalSpanInfo,
  asr: readonly AsrChar[],
  firstCharIndex: number,
  lowerBound: number,
): number {
  if (info.leadingUnmatched <= 0) return firstCharIndex
  const gapStartIdx = Math.max(lowerBound, 0)
  if (gapStartIdx < firstCharIndex) {
    const gapSec = asr[firstCharIndex].start - asr[gapStartIdx].start
    if (gapSec > 0 && gapSec <= MAX_GAP_ABSORB_SEC) return gapStartIdx
  }
  return Math.min(firstCharIndex, Math.max(lowerBound, firstCharIndex - info.leadingUnmatched, 0))
}

/** 終了側の伸長先インデックスを決める。resolveExtendedLeftIdx の対称版。 */
function resolveExtendedRightIdx(
  info: ProvisionalSpanInfo,
  asr: readonly AsrChar[],
  lastCharIndex: number,
  upperBound: number,
): number {
  if (info.trailingUnmatched <= 0) return lastCharIndex
  const gapEndIdx = Math.min(upperBound, asr.length - 1)
  if (gapEndIdx > lastCharIndex) {
    const gapSec = asr[gapEndIdx].end - asr[lastCharIndex].end
    if (gapSec > 0 && gapSec <= MAX_GAP_ABSORB_SEC) return gapEndIdx
  }
  return Math.max(lastCharIndex, Math.min(upperBound, lastCharIndex + info.trailingUnmatched, asr.length - 1))
}

/**
 * 採用したかたまりの先頭/末尾がキュー自身の先頭/末尾に届いていない場合、その未対応
 * 文字数（leadingUnmatched/trailingUnmatched）ぶん、または隣接ASR領域が2.0秒以内の
 * 空きなら丸ごと、包絡をASR側で伸ばす（resolveExtendedLeftIdx/resolveExtendedRightIdx参照）。
 * ただし隣キューの採用範囲には食い込ませない（隣が補間対象なら制約なし）。
 * 伸長は常に「外側へ広げる」方向のみ（Math.min/maxで、採用済みの核を縮める側には動かさない）。
 */
function extendEnvelopes(provisional: readonly ProvisionalSpanInfo[], asr: readonly AsrChar[]): ProvisionalSpanInfo[] {
  return provisional.map((info, index) => {
    const firstCharIndex = info.firstCharIndex
    const lastCharIndex = info.lastCharIndex
    if (info.needsInterpolation || firstCharIndex === null || lastCharIndex === null) {
      return info
    }
    const prevLast = adoptedLastCharIndex(provisional[index - 1])
    const nextFirst = adoptedFirstCharIndex(provisional[index + 1])
    const lowerBound = prevLast !== null ? prevLast + 1 : 0
    const upperBound = nextFirst !== null ? nextFirst - 1 : asr.length - 1
    const newLeftIdx = resolveExtendedLeftIdx(info, asr, firstCharIndex, lowerBound)
    const newRightIdx = resolveExtendedRightIdx(info, asr, lastCharIndex, upperBound)
    if (newLeftIdx === firstCharIndex && newRightIdx === lastCharIndex) return info
    return {
      ...info,
      startSec: asr[newLeftIdx].start,
      endSec: asr[newRightIdx].end,
      firstCharIndex: newLeftIdx,
      lastCharIndex: newRightIdx,
    }
  })
}

function buildProvisionalSpans(
  asr: readonly AsrChar[],
  cueBounds: readonly CueBound[],
  globalMatches: ReadonlyMap<number, number>,
): ProvisionalSpanInfo[] {
  const raw = cueBounds.map(({ start, end }) => buildRawProvisionalSpan(asr, start, end, globalMatches))
  return extendEnvelopes(raw, asr)
}

/**
 * 索引位置（実数）をASR文字ストリーム上の時刻（秒）へ変換する。
 *
 * 整数部をトークンindex、小数部をそのトークン内の按分比率として扱う。すなわち
 * pos=i+frac（0<=frac<1）は「トークンiの中をfracだけ進んだ時刻」を表す。
 * pos が (maxIdx)+1 以上のときは maxIdx トークンの end にクランプする。
 *
 * `maxIdx`（既定 `asr.length-1`）は呼び出し側が明示的に絞り込める。これが必要な理由:
 * distributeRunByIndex は [rangeStartIdx, rangeEndIdx] という「室」の中だけで按分したい。
 * pos の上限（rangeEndIdx+1）をデフォルトの asr.length-1 で解決すると、
 * rangeEndIdx+1 番目のトークン（＝隣の確定キューが採用した、無音を挟んで遠く離れた
 * トークン）の start を読んでしまい、室の外（無音区間の向こう側）まで時刻が飛んでしまう。
 * rangeEndIdx を maxIdx として渡すことで、上限ちょうどの位置は必ず asr[rangeEndIdx].end
 * （室の中の最後のトークンの終端）にクランプされ、室の外を絶対に参照しない。
 *
 * 重要（境界条件）: 小数部の時刻換算は必ず「そのトークン自身の[start, end]の内側」で
 * 行い、トークンiのendとトークンi+1のstartの間（無音区間になり得る領域）を補間しない。
 * pos がどんな実数でも、この関数は常にどちらか一方のトークンの内側だけを指す
 * （floor(pos) で選んだ単一トークンの範囲でしか frac を使わない）ため、トークン間に
 * 実測304秒のような大きな無音があっても、その中に時刻を作ることは構造的に無い。
 */
function indexPosToSec(asr: readonly AsrChar[], pos: number, maxIdx: number = asr.length - 1): number {
  if (asr.length === 0) return 0
  const clampedMaxIdx = Math.min(Math.max(maxIdx, 0), asr.length - 1)
  const clamped = Math.max(0, Math.min(pos, clampedMaxIdx + 1))
  const i = Math.min(Math.floor(clamped), clampedMaxIdx)
  const frac = clamped - i
  return asr[i].start + frac * (asr[i].end - asr[i].start)
}

/**
 * 配分されたスロットが退化（幅 < MIN_SPAN_SEC）していても、対象キューが provisional に
 * 有効な包絡（startSec/endSec が非null）を持っていれば、退化スロットの代わりにそちらを
 * 採用する。一致率不足で補間対象に落ちただけで、実際にはASR上で妥当な包絡が求まっている
 * キューを、たまたま配置された極小スロットで0秒キューにしてしまわないためのガード。
 */
function resolveSlot(info: ProvisionalSpanInfo, slotStart: number, slotEnd: number): TimedSpan {
  const isDegenerate = slotEnd - slotStart < MIN_SPAN_SEC
  return isDegenerate && info.startSec !== null && info.endSec !== null
    ? { startSec: info.startSec, endSec: info.endSec }
    : { startSec: slotStart, endSec: slotEnd }
}

/**
 * [from, to) を、ASR「索引」空間で正規化後の文字数比に線形配分する（rangeStartIdx/
 * rangeEndIdx は閉区間）。索引空間には定義上ギャップが無い（無音区間にはトークンが
 * 存在しないため索引は常に連続）ため、壁時計の秒で按分していた旧実装と異なり、
 * 無音区間そのものが按分対象になることは構造的に無い。
 *
 * カーソルは [rangeStartIdx, rangeEndIdx+1) の連続量として進め、各キューの境界位置を
 * indexPosToSec で時刻へ変換する。小数位置は必ず単一トークンの内側に収まる
 * （indexPosToSec 参照）ため、トークンを跨いだ補間は起こらない。
 */
function distributeRunByIndex(
  provisional: readonly ProvisionalSpanInfo[],
  results: TimedSpan[],
  from: number,
  to: number,
  rangeStartIdx: number,
  rangeEndIdx: number,
  asr: readonly AsrChar[],
): void {
  const chunk = provisional.slice(from, to)
  const totalChunkChars = chunk.reduce((sum, item) => sum + Math.max(1, item.totalChars), 0)
  const idxSpan = Math.max(0, rangeEndIdx + 1 - rangeStartIdx)
  let cursor = rangeStartIdx
  for (let k = from; k < to; k += 1) {
    const info = provisional[k]
    const share = Math.max(1, info.totalChars) / Math.max(1, totalChunkChars)
    const isLast = k === to - 1
    const endPos = isLast ? rangeStartIdx + idxSpan : cursor + idxSpan * share
    const slotStart = indexPosToSec(asr, cursor, rangeEndIdx)
    const slotEnd = indexPosToSec(asr, Math.max(cursor, endPos), rangeEndIdx)
    results[k] = resolveSlot(info, slotStart, slotEnd)
    cursor = endPos
  }
}

/**
 * 索引の余地がゼロ（無音区間の前後トークンが索引上は隣接）のとき、直前の確定キュー
 * (`results[prevIndex]`) の末尾側から時間を借りて [from, to) のキューへ文字数比で
 * 分け与える。直前キューには最低でも MIN_SPAN_SEC を残す（残せなければ全く借りず、
 * [from, to) は直前キューの終了時刻に長さ0で並べる）。
 *
 * なぜ直前から借りるのか: 対応が付かなかったキューのテキストは、実データでは直前の
 * 発話区間の言い換え・要約であることが多く（実測: 該当区間はASR側とキュー側の共通
 * 6-gramがASR側の14.8%しかなく、LLMが大きく書き換えている）、最も確からしい配置先が
 * 直前の発話区間であるため。無音区間（秒による按分だとそこに置かれてしまっていた）に
 * 置くよりも実態に近い。
 */
function borrowFromPrev(
  provisional: readonly ProvisionalSpanInfo[],
  results: TimedSpan[],
  from: number,
  to: number,
  prevIndex: number,
): void {
  const prevResult = results[prevIndex]
  const lendable = Math.max(0, prevResult.endSec - prevResult.startSec - MIN_SPAN_SEC)
  const chunk = provisional.slice(from, to)
  const totalChunkChars = chunk.reduce((sum, item) => sum + Math.max(1, item.totalChars), 0)

  if (lendable <= 0) {
    for (let k = from; k < to; k += 1) {
      results[k] = resolveSlot(provisional[k], prevResult.endSec, prevResult.endSec)
    }
    return
  }

  const donorStart = prevResult.endSec - lendable
  let cursor = donorStart
  for (let k = from; k < to; k += 1) {
    const info = provisional[k]
    const share = Math.max(1, info.totalChars) / Math.max(1, totalChunkChars)
    const isLast = k === to - 1
    const end = isLast ? prevResult.endSec : cursor + lendable * share
    results[k] = resolveSlot(info, cursor, Math.max(cursor, end))
    cursor = end
  }
  results[prevIndex] = { startSec: prevResult.startSec, endSec: donorStart }
}

/**
 * borrowFromPrev の対称版。run が先頭で直前キューが存在しない場合、直後の確定キュー
 * (`results[nextIndex]`) の先頭側から借りる。
 */
function borrowFromNext(
  provisional: readonly ProvisionalSpanInfo[],
  results: TimedSpan[],
  from: number,
  to: number,
  nextIndex: number,
): void {
  const nextResult = results[nextIndex]
  const lendable = Math.max(0, nextResult.endSec - nextResult.startSec - MIN_SPAN_SEC)
  const chunk = provisional.slice(from, to)
  const totalChunkChars = chunk.reduce((sum, item) => sum + Math.max(1, item.totalChars), 0)

  if (lendable <= 0) {
    for (let k = from; k < to; k += 1) {
      results[k] = resolveSlot(provisional[k], nextResult.startSec, nextResult.startSec)
    }
    return
  }

  const donorEnd = nextResult.startSec + lendable
  let cursor = nextResult.startSec
  for (let k = from; k < to; k += 1) {
    const info = provisional[k]
    const share = Math.max(1, info.totalChars) / Math.max(1, totalChunkChars)
    const isLast = k === to - 1
    const end = isLast ? donorEnd : cursor + lendable * share
    results[k] = resolveSlot(info, cursor, Math.max(cursor, end))
    cursor = end
  }
  results[nextIndex] = { startSec: donorEnd, endSec: nextResult.endSec }
}

/**
 * [from, to) の区間（すべて補間対象）を配置する。
 *
 * 配分に使う範囲はASR「索引」で決める（壁時計の秒ではない）:
 *   - rangeStartIdx = 直前のキューが採用範囲を持つなら lastCharIndex+1、無ければ0
 *   - rangeEndIdx   = 直後のキューが採用範囲を持つなら firstCharIndex-1、無ければasr.length-1
 * 索引空間には無音によるギャップが存在しない（無音区間にはトークンが無いため索引は
 * 常に連続）ため、これで無音区間が按分対象になることを構造的に防ぐ（旧実装は壁時計の
 * 秒で按分しており、これが実測304秒の無音区間に字幕が置かれる不具合の直接原因だった）。
 *
 * rangeEndIdx < rangeStartIdx（索引の余地がゼロ）になることがある。実測: WhisperX出力に
 * 304秒の無音区間があり、その直前・直後のトークンが索引上は連番だった
 * （lastCharIndex=X, firstCharIndex=X+1）ケース。このとき秒による按分へは絶対に
 * フォールバックしない（それこそが無音区間に字幕を置いてしまう不具合そのものになる
 * ため）。代わりに直前（run が先頭で直前が無ければ直後）の確定キューから時間を借りる
 * （borrowFromPrev/borrowFromNext 参照）。
 *
 * 戻り値は「索引の余地がゼロで借用パスに入ったか」を表す（診断用。
 * `interpolateSpansWithDiagnostics` 参照）。
 */
function distributeRun(
  provisional: readonly ProvisionalSpanInfo[],
  results: TimedSpan[],
  from: number,
  to: number,
  asr: readonly AsrChar[],
): boolean {
  const prevLastCharIndex = from > 0 ? provisional[from - 1].lastCharIndex : null
  const nextFirstCharIndex = to < provisional.length ? provisional[to].firstCharIndex : null
  const rangeStartIdx = prevLastCharIndex !== null ? prevLastCharIndex + 1 : 0
  const rangeEndIdx = nextFirstCharIndex !== null ? nextFirstCharIndex - 1 : asr.length - 1

  if (rangeEndIdx >= rangeStartIdx) {
    distributeRunByIndex(provisional, results, from, to, rangeStartIdx, rangeEndIdx, asr)
    return false
  }

  if (from > 0) {
    borrowFromPrev(provisional, results, from, to, from - 1)
  } else if (to < provisional.length) {
    borrowFromNext(provisional, results, from, to, to)
  } else {
    // 前後どちらの確定キューも無い（run が全キューを覆う。実質 asr が空のときのみ発生）。
    // 借用元が無いため、時刻0に長さ0で並べる安全なフォールバック。
    for (let k = from; k < to; k += 1) {
      results[k] = resolveSlot(provisional[k], 0, 0)
    }
  }
  return true
}

interface InterpolationDiagnostics {
  spans: TimedSpan[]
  /** 索引の余地がゼロだったため borrowFromPrev/borrowFromNext で借用した run の数。 */
  borrowedRunCount: number
}

/**
 * 確定済み（非補間）キューの結果を先に全件確定させてから、補間対象の連続区間(run)ごとに
 * distributeRun を適用する。
 *
 * 「先に確定枠を全部埋めてから run を埋める」2段構成にしているのは、借用
 * （borrowFromPrev/borrowFromNext）が直前直後の確定済み結果を書き換える必要があるため。
 * 旧実装のように1周の逐次処理で確定枠を書きながら run を埋めると、直後の確定キューを
 * 借用で書き換えても、ループが後でそのインデックスに到達した時に確定値で上書きしてしまい
 * 借用結果が消えてしまう。
 */
function interpolateSpansWithDiagnostics(
  provisional: readonly ProvisionalSpanInfo[],
  asr: readonly AsrChar[],
): InterpolationDiagnostics {
  const results: TimedSpan[] = new Array(provisional.length)
  provisional.forEach((info, i) => {
    if (!info.needsInterpolation && info.startSec !== null && info.endSec !== null) {
      results[i] = { startSec: info.startSec, endSec: info.endSec }
    }
  })

  let borrowedRunCount = 0
  let index = 0
  while (index < provisional.length) {
    if (results[index] !== undefined) {
      index += 1
      continue
    }
    let runEnd = index
    while (runEnd < provisional.length && results[runEnd] === undefined) runEnd += 1
    const didBorrow = distributeRun(provisional, results, index, runEnd, asr)
    if (didBorrow) borrowedRunCount += 1
    index = runEnd
  }

  return { spans: results, borrowedRunCount }
}

function interpolateSpans(provisional: readonly ProvisionalSpanInfo[], asr: readonly AsrChar[]): TimedSpan[] {
  return interpolateSpansWithDiagnostics(provisional, asr).spans
}

/**
 * diffベースの大域アライメントは理論上キュー間の重なりを生まないはずだが、
 * 端点補正やフォールバックの組み合わせで万一発生した場合に解消する。
 *
 * 前のキューの endSec だけを動かさず、後ろのキューの startSec を前の endSec に
 * 合わせて押し出す非対称な解消にする（前のキューは一切変更しない）。
 * 前のキューの end はASR実測（またはスコアトリム込みの確定値）で信頼できる一方、
 * 異常が起きているのは後ろのキューの start 側だからである。旧実装の中点分割は
 * 「隣接キューのわずかなジッター」を想定した処理で、外れ値ガード導入前は数十秒規模の
 * 重なりが生じ得たため、中点分割だと信頼できる前のキューの end まで巻き込んで破壊し、
 * `finalizeSpan` の `Math.max(startSec, endSec)` で前のキューの長さを0にしてしまっていた。
 */
function enforceMonotonicSpans(spans: readonly TimedSpan[]): TimedSpan[] {
  const result = spans.map(span => ({ ...span }))
  for (let i = 0; i < result.length - 1; i += 1) {
    if (result[i].endSec > result[i + 1].startSec) {
      const prevEnd = result[i].endSec
      result[i + 1] = { startSec: prevEnd, endSec: Math.max(prevEnd, result[i + 1].endSec) }
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
  const resolved = resolveOptions(options, asr)
  const cueTokenLists = cueTexts.map(text => tokenizeCueText(text, resolved.script))
  const cueBounds = computeCueBounds(cueTokenLists.map(tokens => tokens.length))
  const cueTokensFlat = cueTokenLists.flat()

  const globalMatches = buildGlobalMatches(asr, cueTokenLists, cueBounds, cueTokensFlat, resolved)
  const provisional = buildProvisionalSpans(asr, cueBounds, globalMatches)
  const interpolated = interpolateSpans(provisional, asr)
  const monotonic = enforceMonotonicSpans(interpolated)

  return monotonic.map((span, index) => finalizeSpan(span, provisional[index]))
}

export const __testing = {
  normalizeTimingText,
  normalizeLatinToken,
  tokenizeCueText,
  chunkCueGroups,
  trimEnvelopeByScore,
  longestNonDecreasingSubsequence,
  selectLargestCluster,
  buildProvisionalSpans,
  extendEnvelopes,
  indexPosToSec,
  distributeRun,
  interpolateSpans,
  interpolateSpansWithDiagnostics,
  enforceMonotonicSpans,
  computeAsrDensityPerSec,
  resolveOptions,
}
