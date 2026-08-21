/**
 * 用語辞書の自動適応ユーティリティ
 *
 * アプローチ:
 * 1. 正規表現（単語境界）— 用語の検出と大文字小文字の置換に使用
 * 2. compromise（英語形態素解析）— 複数形・変化形の検出に使用
 *
 * LLM による翻訳と重複しても構わない。ライブラリ側は決定的（deterministic）
 * なルールベースなので再現性があり、QA として機能する。
 *
 * **ロールと言語の対応**: 用語辞書のエントリは ja / en という言語ペアで保持するが、
 * どちらが「字幕（訳文）」でどちらが「書きおこし（原文）」かは翻訳方向で入れ替わる。
 * 検出方式も言語で変わる（ラテン語は単語境界つき正規表現、日本語は単語境界の概念が
 * 無いため部分一致）ので、各関数は GlossaryRoles を受け取って両者を解決する。
 */

import nlp from 'compromise'
import type { GlossaryEntry } from '@/context/GlossaryContext'
import type { LanguageProfileConfig } from '@/lib/pipeline/languageProfileConfig'

/** 用語辞書エントリのどちらのフィールドを見るか。 */
export type GlossaryField = 'ja' | 'en'

/** 字幕／書きおこしの各ロールが、辞書のどのフィールドに対応するか。 */
export interface GlossaryRoles {
  subtitle: GlossaryField
  transcript: GlossaryField
}

/** 既定（日本語書きおこし → 英語字幕）。 */
export const DEFAULT_GLOSSARY_ROLES: GlossaryRoles = { subtitle: 'en', transcript: 'ja' }

/**
 * 言語プロファイルから辞書ロールを解決する。
 * 字幕が日本語なら ja/en が入れ替わる。それ以外（既定・未知言語）は従来どおり。
 */
export function resolveGlossaryRoles(languages: LanguageProfileConfig): GlossaryRoles {
  return languages.subtitle.script === 'japanese'
    ? { subtitle: 'ja', transcript: 'en' }
    : DEFAULT_GLOSSARY_ROLES
}

export interface MissingTerm {
  entry: GlossaryEntry
  /** 書きおこし（原文）に対応語が含まれていた */
  jaFound: boolean
  /** 字幕（訳文）に対応語が含まれていない */
  enMissing: boolean
}

/**
 * 検出用パターン（大文字小文字・複数形・所有格に対応）
 * ハイライト・漏れチェック・タイポ検出で使用する
 */
function buildPattern(term: string): RegExp {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`\\b${escaped}(?:'?s)?\\b`, 'gi')
}

/**
 * テキストに用語が含まれるかを、その用語の言語に応じた方式で判定する。
 *
 * `en`: 単語境界つき正規表現 + compromise による語形変化の検出。
 * `ja`: 部分一致。`\b` は \w 境界を要求するため `\b機械学習\b` は成立せず、
 *       日本語では単語境界つき正規表現が常に false になる。
 */
function containsTerm(text: string, term: string, field: GlossaryField): boolean {
  if (!term) return false
  if (field === 'ja') return text.includes(term)
  return buildPattern(term).test(text) || findWithNlp(text, term)
}

/**
 * compromise でテキストから用語の語形変化を検出する
 *
 * 例: "The transformers use self-attention" に対して
 *     "Transformer" を検索 → "transformers" にヒット
 */
function findWithNlp(text: string, term: string): boolean {
  try {
    const doc = nlp(text)
    // 単語単位でのマッチ（compromise の match は NLP パターンに基づく）
    const termDoc = nlp(term)
    const termNorm = termDoc.normalize().text().toLowerCase()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const matched = doc.terms().filter((t: any) => {
      return t.normalize().text().toLowerCase() === termNorm
    })
    return matched.length > 0
  } catch {
    return false
  }
}

/**
 * 書きおこし（原文）に辞書用語が含まれているのに、字幕（訳文）に対応語がない箇所を検出する
 *
 * 長い用語から先に処理し、マッチした文字範囲を covered としてスキップする。
 * これにより「機械学習」がヒットした後に「学習」が二重 flag されることを防ぐ。
 * 字幕側がラテン語の場合は compromise で語形変化も考慮する。
 */
export function findMissingTranslations(
  transcriptText: string,
  subtitleText: string,
  entries: GlossaryEntry[],
  roles: GlossaryRoles = DEFAULT_GLOSSARY_ROLES,
): MissingTerm[] {
  const termOf = (entry: GlossaryEntry, field: GlossaryField): string => entry[field]

  // 書きおこし側の用語が長い順にソート
  const sorted = [...entries.filter(e => e.confirmed && termOf(e, roles.transcript).length > 0)]
    .sort((a, b) => termOf(b, roles.transcript).length - termOf(a, roles.transcript).length)

  // covered: [start, end) の文字範囲リスト（書きおこしテキスト上）
  const covered: Array<[number, number]> = []

  const isCovered = (idx: number, len: number) =>
    covered.some(([s, e]) => idx >= s && idx + len <= e)

  const results: MissingTerm[] = []

  for (const entry of sorted) {
    const sourceTerm = termOf(entry, roles.transcript)
    // 書きおこし中の全出現位置をチェック
    let idx = transcriptText.indexOf(sourceTerm)
    if (idx === -1) continue

    // いずれかの出現が未カバーかどうか確認
    let hasUncovered = false
    while (idx !== -1) {
      if (!isCovered(idx, sourceTerm.length)) { hasUncovered = true; break }
      idx = transcriptText.indexOf(sourceTerm, idx + 1)
    }
    if (!hasUncovered) continue

    // 訳語の存在チェック
    const translationFound = containsTerm(subtitleText, termOf(entry, roles.subtitle), roles.subtitle)

    // マッチした全位置を covered に追加（訳語あり・なし問わず）
    let pos = transcriptText.indexOf(sourceTerm)
    while (pos !== -1) {
      covered.push([pos, pos + sourceTerm.length])
      pos = transcriptText.indexOf(sourceTerm, pos + 1)
    }

    if (!translationFound) {
      results.push({ entry, jaFound: true, enMissing: true })
    }
  }

  return results
}

/**
 * 日英対応色を示すパレット。
 * ブロック内でマッチした用語に順番に割り当て、同じエントリは日英で同色になる。
 */
const TERM_COLOR_PALETTE = [
  '#60a5fa', // blue
  '#fb923c', // orange
  '#34d399', // green
  '#c084fc', // purple
  '#f87171', // red
  '#22d3ee', // cyan
  '#facc15', // yellow
  '#a78bfa', // violet
]

export interface MatchedGlossaryEntry {
  entry: GlossaryEntry
  color: string
  /** 字幕（訳文）側に出現した */
  inSubtitle: boolean
  /** 書きおこし（原文）側に出現した */
  inTranscript: boolean
  roles: GlossaryRoles
}

/**
 * 字幕・書きおこし両方に独立してマッチングし、同エントリは同色を割り当てる。
 *
 * - ラテン語側: 単語境界regex（大文字小文字無視・複数形対応）
 * - 日本語側: includes()（単語境界なし）
 * - 片方にしか出ない用語も検出対象（一方向依存を排除）
 * - 色はマッチした用語の出現順で割り当て（両ペインで共通）
 * - TM でも同パターンで流用できる設計
 */
export function findMatchedGlossaryEntries(
  subtitleText: string,
  transcriptText: string,
  entries: GlossaryEntry[],
  roles: GlossaryRoles = DEFAULT_GLOSSARY_ROLES,
): MatchedGlossaryEntry[] {
  const results: MatchedGlossaryEntry[] = []
  let colorIdx = 0

  for (const entry of entries) {
    const inSubtitle = containsTerm(subtitleText, entry[roles.subtitle], roles.subtitle)
    const inTranscript = containsTerm(transcriptText, entry[roles.transcript], roles.transcript)
    if (!inSubtitle && !inTranscript) continue
    results.push({
      entry,
      color: TERM_COLOR_PALETTE[colorIdx % TERM_COLOR_PALETTE.length],
      inSubtitle,
      inTranscript,
      roles,
    })
    colorIdx++
  }

  return results
}

/** 字幕ペインのハイライト用。 */
export function toSubtitleTerms(
  matched: MatchedGlossaryEntry[],
): import('@/types/subtitle').GlossaryTerm[] {
  return matched
    .filter(m => m.inSubtitle)
    .map(({ entry, color, roles }) => ({
      word: entry[roles.subtitle],
      expectedTranslation: entry[roles.transcript],
      actualTranslation: entry[roles.subtitle],
      isDeviated: false,
      insight: entry.note ?? entry.desc,
      color,
    }))
}

/** 書きおこしペインのハイライト用。 */
export function toTranscriptTerms(
  matched: MatchedGlossaryEntry[],
): import('@/types/subtitle').GlossaryTerm[] {
  return matched
    .filter(m => m.inTranscript)
    .map(({ entry, color, roles }) => ({
      word: entry[roles.transcript],
      expectedTranslation: entry[roles.subtitle],
      actualTranslation: entry[roles.transcript],
      isDeviated: false,
      color,
    }))
}

export interface TypoCandidate {
  entry: GlossaryEntry
  /** テキスト中で見つかった疑わしい単語 */
  found: string
  /** 編集距離 */
  distance: number
}

/**
 * Levenshtein距離を計算する（O(m*n)）
 */
function levenshtein(a: string, b: string): number {
  const m = a.length
  const n = b.length
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  )
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1]
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1])
      }
    }
  }
  return dp[m][n]
}

/**
 * 英語テキスト中に、辞書用語のタイポ候補となるフレーズがあれば返す。
 *
 * アルゴリズム:
 * 1. 辞書用語を語数の多い順（長い順）にソートして処理
 * 2. 各エントリの語数に合わせた n-gram を生成して比較
 * 3. 正確なマッチ or タイポ候補としてヒットしたトークン位置を「covered」とし、
 *    後続のより短いエントリが同じ位置に干渉しないようにスキップする
 *
 * 例: "Mechine Learning" → "Machine Learning"(2語) がタイポ検出されてトークン位置0,1をカバー
 *     → 1語エントリが "Mechine" や "Learning" に触れても無視される
 */
export function findTypoCandidates(
  text: string,
  entries: GlossaryEntry[],
  field: GlossaryField = 'en',
): TypoCandidate[] {
  // 日本語にはラテン語のような綴り誤りの概念が無く、トークナイザ（空白・英字区切り）も
  // 編集距離による比較も成立しない。スペル校正が CJK で自動オフになるのと同じ方針で無効化する。
  if (field === 'ja') return []

  // テキストから単語トークンを抽出
  const tokenRegex = /[a-zA-Z][\w'-]*/g
  const tokens: string[] = []
  let m: RegExpExecArray | null
  while ((m = tokenRegex.exec(text)) !== null) {
    tokens.push(m[0])
  }
  if (tokens.length === 0) return []

  // 長い（語数多い）エントリから先に処理
  const sortedEntries = [...entries.filter(e => e.confirmed)].sort(
    (a, b) => b.en.trim().split(/\s+/).length - a.en.trim().split(/\s+/).length,
  )

  const candidates: TypoCandidate[] = []
  const seenPairs = new Set<string>()
  // マッチ済み（正確 or タイポ）のトークンインデックスを記録
  const coveredTokens = new Set<number>()

  for (const entry of sortedEntries) {
    const term = entry.en.trim()
    if (!term) continue
    const termLower = term.toLowerCase()
    const termWordCount = term.split(/\s+/).length
    const termChars = termLower.replace(/\s+/g, '')
    if (termChars.length < 3) continue

    for (let i = 0; i <= tokens.length - termWordCount; i++) {
      // このn-gramのいずれかのトークンが既にカバー済みならスキップ
      let covered = false
      for (let j = i; j < i + termWordCount; j++) {
        if (coveredTokens.has(j)) { covered = true; break }
      }
      if (covered) continue

      const ngram = tokens.slice(i, i + termWordCount).join(' ')
      const ngramLower = ngram.toLowerCase()

      // 正確にマッチしている場合: カバー済みにしてスキップ
      if (ngramLower === termLower || buildPattern(term).test(ngram)) {
        for (let j = i; j < i + termWordCount; j++) coveredTokens.add(j)
        continue
      }

      // 実文字数が大きく異なる場合はスキップ（過検出防止）
      const ngramChars = ngramLower.replace(/\s+/g, '')
      const lenDiff = Math.abs(ngramChars.length - termChars.length)
      if (lenDiff > Math.max(2, Math.floor(termChars.length * 0.4))) continue

      const dist = levenshtein(ngramLower, termLower)

      // 閾値: 用語文字数 ≤8 なら 1、それ以上は 2
      const threshold = termLower.length <= 8 ? 1 : 2
      if (dist === 0 || dist > threshold) continue

      const pairKey = `${ngram}::${term}`
      if (seenPairs.has(pairKey)) continue
      seenPairs.add(pairKey)

      // タイポ候補もカバー済みとしてマーク
      for (let j = i; j < i + termWordCount; j++) coveredTokens.add(j)
      candidates.push({ entry, found: ngram, distance: dist })
    }
  }

  return candidates
}

export type { GlossaryEntry }
