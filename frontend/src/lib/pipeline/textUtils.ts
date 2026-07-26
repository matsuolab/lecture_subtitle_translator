import type { LanguageScript } from './languageProfileConfig'

export function normalizeSpaces(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * 字幕言語が語と語の間に空白を置くか。
 * 表意文字系（日本語）は置かないため、cue 結合・改行解除で空白を挟んではいけない。
 */
export function usesWordSpacing(script: LanguageScript): boolean {
  return script !== 'japanese'
}

/**
 * 複数の字幕断片を、その言語の作法で1本のテキストへ結合する。
 * ラテン系は空白区切り（従来と同一）、日本語は空白なしで連結する。
 * 空要素は落とすので、隣接 cue の結合で不要な区切りが残らない。
 */
export function joinSubtitleParts(parts: Array<string | undefined | null>, script: LanguageScript): string {
  const cleaned = parts
    .map((part) => (part ?? '').trim())
    .filter((part) => part.length > 0)
  if (usesWordSpacing(script)) return normalizeSpaces(cleaned.join(' '))
  // 日本語: 連結時に空白を挟まない。各断片内部の空白（"softmax 関数" など）は保持したいので
  // 全除去はせず、連続空白の圧縮だけ行う。
  return cleaned.join('').replace(/[ \t]+/g, ' ').trim()
}

/**
 * 表示用の改行を解除して1行に戻す。
 * ラテン系は改行を空白へ、日本語は空白を挟まず除去する。
 */
export function unwrapSubtitleLines(text: string, script: LanguageScript): string {
  if (usesWordSpacing(script)) return normalizeSpaces(text.replace(/\n+/g, ' '))
  return text.replace(/\n+/g, '').replace(/[ \t]+/g, ' ').trim()
}

// ---------------------------------------------------------------------------
// 行分割
// ---------------------------------------------------------------------------

/** 行頭に置いてはいけない文字（行頭禁則）: 終わり括弧・句読点・長音・小書き仮名など。 */
const JA_FORBIDDEN_LINE_START = '、。，．・：；？！ー」』）］｝〉》〕”’々〜ぁぃぅぇぉっゃゅょゎヵヶァィゥェォッャュョヮ'
/** 行末に置いてはいけない文字（行末禁則）: 始め括弧。 */
const JA_FORBIDDEN_LINE_END = '「『（［｛〈《〔“‘'

/** 句読点。意味の切れ目として最優先の改行位置。 */
const JA_SENTENCE_PUNCTUATION = '、。！？'
/** 閉じ括弧。引用や補足の終わりで切れる。 */
const JA_CLOSING_BRACKET = '」』）］｝〉》〕'
/**
 * 助詞・接続表現。この直後は文節境界になりやすい。
 * 長いものを先に並べ、「ため」より「という」が優先して一致するようにする。
 */
const JA_PARTICLES = [
  'について', 'における', 'という', 'として', 'ならば', 'ので', 'ため', 'から', 'まで', 'より',
  'では', 'には', 'とは', 'へと', 'は', 'が', 'を', 'に', 'で', 'と', 'へ', 'も',
]

/** その位置で改行して禁則に反しないか。 */
function isValidJaBreak(text: string, pos: number): boolean {
  if (pos <= 0 || pos >= text.length) return false
  if (JA_FORBIDDEN_LINE_START.includes(text[pos])) return false
  if (JA_FORBIDDEN_LINE_END.includes(text[pos - 1])) return false
  return true
}

interface JaBreakCandidate {
  pos: number
  /** 小さいほど意味的に良い改行位置 */
  tier: number
}

function collectJaBreakCandidates(text: string): JaBreakCandidate[] {
  const candidates: JaBreakCandidate[] = []
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (JA_SENTENCE_PUNCTUATION.includes(ch)) candidates.push({ pos: i + 1, tier: 0 })
    else if (JA_CLOSING_BRACKET.includes(ch)) candidates.push({ pos: i + 1, tier: 1 })
  }
  for (const particle of JA_PARTICLES) {
    let from = 0
    for (;;) {
      const idx = text.indexOf(particle, from)
      if (idx === -1) break
      candidates.push({ pos: idx + particle.length, tier: 2 })
      from = idx + 1
    }
  }
  return candidates.filter((candidate) => isValidJaBreak(text, candidate.pos))
}

/**
 * 日本語字幕を2行へ分割する。
 *
 * 優先順位:
 *   1. 両行が maxChars 以内に収まる
 *   2. 意味的に良い改行位置（句読点 > 閉じ括弧 > 助詞）
 *   3. 行長が均等（中央に近い）
 * どの候補も使えない場合は、禁則を守りつつ中央付近で機械的に切る。
 */
function splitJapaneseLines(text: string, maxChars: number): string {
  const compact = text.trim()
  if (compact.length <= maxChars) return compact

  const half = compact.length / 2
  const candidates = collectJaBreakCandidates(compact)

  const scored = candidates
    .map((candidate) => ({
      ...candidate,
      fits: candidate.pos <= maxChars && compact.length - candidate.pos <= maxChars,
      distance: Math.abs(candidate.pos - half),
    }))
    .sort((a, b) => {
      if (a.fits !== b.fits) return a.fits ? -1 : 1
      if (a.tier !== b.tier) return a.tier - b.tier
      return a.distance - b.distance
    })

  const best = scored[0]
  if (best) {
    const left = compact.slice(0, best.pos).trim()
    const right = compact.slice(best.pos).trim()
    if (left && right) return `${left}\n${right}`
  }

  // フォールバック: 中央から外側へ探索し、禁則に反しない最初の位置で切る。
  const mid = Math.floor(half)
  for (let offset = 0; offset < compact.length; offset += 1) {
    for (const pos of [mid - offset, mid + offset]) {
      if (!isValidJaBreak(compact, pos)) continue
      const left = compact.slice(0, pos).trim()
      const right = compact.slice(pos).trim()
      if (left && right) return `${left}\n${right}`
    }
  }
  return compact
}

/**
 * ラテン系字幕を2行へ分割する（従来の splitEnLines42 と同一動作）。
 * 単語境界のうち中央に最も近い位置で切る。
 */
function splitLatinLines(text: string, maxChars: number): string {
  const normalized = normalizeSpaces(text)
  if (normalized.length <= maxChars) return normalized

  const words = normalized.split(' ')
  if (words.length <= 1) {
    const mid = Math.floor(normalized.length / 2)
    return normalized.slice(0, mid) + '\n' + normalized.slice(mid)
  }

  const half = normalized.length / 2
  let bestPos = 0
  let bestDist = Infinity
  let pos = 0
  for (let i = 0; i < words.length - 1; i++) {
    pos += words[i].length
    const dist = Math.abs(pos - half)
    if (dist < bestDist) {
      bestDist = dist
      bestPos = pos
    }
    pos += 1
  }

  const left = normalized.slice(0, bestPos).trimEnd()
  const right = normalized.slice(bestPos).trimStart()
  return right ? `${left}\n${right}` : left
}

/**
 * 字幕テキストを表示用に2行へ折り返す。字幕言語の script で分割規則を切り替える。
 * ラテン系は従来と完全に同じ結果を返す。
 */
export function splitSubtitleLines(text: string, maxChars: number, script: LanguageScript): string {
  if (script === 'japanese') return splitJapaneseLines(text, maxChars)
  return splitLatinLines(text, maxChars)
}

export const __testing = {
  collectJaBreakCandidates,
  isValidJaBreak,
  splitJapaneseLines,
  splitLatinLines,
}
