/**
 * 用語辞書の自動適応ユーティリティ
 *
 * アプローチ:
 * 1. 正規表現（単語境界 + 単純複数形）— 技術用語の表記ゆれ修正に有効
 * 2. compromise（英語形態素解析）— 複数形・変化形のより柔軟な検出に使用
 *
 * LLM による翻訳と重複しても構わない。ライブラリ側は決定的（deterministic）
 * なルールベースなので再現性があり、QA として機能する。
 */

import nlp from 'compromise'
import type { GlossaryEntry } from '@/context/GlossaryContext'

export interface Replacement {
  found: string      // テキスト中で見つかった形
  canonical: string  // 正規形（辞書の en フィールド）
  position: number   // 文字位置
}

export interface TextApplyResult {
  text: string
  replacements: Replacement[]
  changed: boolean
}

export interface MissingTerm {
  entry: GlossaryEntry
  jaFound: boolean   // 日本語原文に ja が含まれていた
  enMissing: boolean // 英語テキストに en が含まれていない
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
 * 置換用パターン（大文字小文字のみ対応・複数形・所有格は変換しない）
 * applyGlossaryToText でのみ使用する
 */
function buildPatternStrict(term: string): RegExp {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`\\b${escaped}\\b`, 'gi')
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
 * 英語テキストに確定済み用語辞書を適用し、表記を正規化する
 *
 * 正規化対象:
 * - 大文字・小文字の揺れ（"transformer" → "Transformer"）
 * - 単純複数形の正規化（"Transformers" → "Transformer"）
 *
 * 注意: 承認済みブロックへの適用は呼び出し側で制御する
 */
export function applyGlossaryToText(
  text: string,
  entries: GlossaryEntry[],
): TextApplyResult {
  let result = text
  const replacements: Replacement[] = []
  let offset = 0  // テキスト変更によるオフセット補正

  for (const entry of entries) {
    if (!entry.confirmed) continue
    const pattern = buildPatternStrict(entry.en)

    result = result.replace(pattern, (match, matchOffset) => {
      // 既に正規形なら変更しない（所有格・複数形は正規化する）
      const isAlreadyCanonical = match === entry.en
      if (isAlreadyCanonical) return match

      replacements.push({
        found: match,
        canonical: entry.en,
        position: matchOffset + offset,
      })
      offset += entry.en.length - match.length
      return entry.en
    })
  }

  return { text: result, replacements, changed: replacements.length > 0 }
}

/**
 * 日本語原文に辞書用語が含まれているのに英語訳に対応語がない箇所を検出する
 *
 * 長い日本語用語から先に処理し、マッチした文字範囲を covered としてスキップする。
 * これにより「機械学習」がヒットした後に「学習」が二重 flag されることを防ぐ。
 * compromise を使って英語側の語形変化も考慮してチェックする。
 */
export function findMissingTranslations(
  target: string,
  source: string,
  entries: GlossaryEntry[],
): MissingTerm[] {
  // ja の長い順にソート
  const sorted = [...entries.filter(e => e.confirmed && e.ja.length > 0)]
    .sort((a, b) => b.ja.length - a.ja.length)

  // covered: [start, end) の文字範囲リスト（日本語 target 上）
  const covered: Array<[number, number]> = []

  const isCovered = (idx: number, len: number) =>
    covered.some(([s, e]) => idx >= s && idx + len <= e)

  const results: MissingTerm[] = []

  for (const entry of sorted) {
    // 日本語 target 中の全出現位置をチェック
    let idx = target.indexOf(entry.ja)
    if (idx === -1) continue

    // いずれかの出現が未カバーかどうか確認
    let hasUncovered = false
    while (idx !== -1) {
      if (!isCovered(idx, entry.ja.length)) { hasUncovered = true; break }
      idx = target.indexOf(entry.ja, idx + 1)
    }
    if (!hasUncovered) continue

    // 英語訳の存在チェック
    const enFound = buildPattern(entry.en).test(source) || findWithNlp(source, entry.en)

    // マッチした全位置を covered に追加（英訳あり・なし問わず）
    let pos = target.indexOf(entry.ja)
    while (pos !== -1) {
      covered.push([pos, pos + entry.ja.length])
      pos = target.indexOf(entry.ja, pos + 1)
    }

    if (!enFound) {
      results.push({ entry, jaFound: true, enMissing: true })
    }
  }

  return results
}

/**
 * 日英対応色を示すパレット。
 * ブロック内でマッチした用語に順番に割り当て、同じエントリは日英で同色になる。
 */
export const TERM_COLOR_PALETTE = [
  '#60a5fa', // blue
  '#fb923c', // orange
  '#34d399', // green
  '#c084fc', // purple
  '#f87171', // red
  '#22d3ee', // cyan
  '#facc15', // yellow
  '#a78bfa', // violet
]

/**
 * 日英テキスト両方に独立してマッチングし、同エントリは同色を割り当てる。
 *
 * - 英語: 単語境界regex（大文字小文字無視・複数形対応）
 * - 日本語: includes()（単語境界なし）
 * - 片方にしか出ない用語も検出対象（一方向依存を排除）
 * - 色はマッチした用語の出現順で割り当て（日英で共通）
 * - TM でも同パターンで流用できる設計
 */
export function findMatchedGlossaryEntries(
  sourceEn: string,
  targetJa: string,
  entries: GlossaryEntry[],
): Array<{ entry: GlossaryEntry; color: string; inEn: boolean; inJa: boolean }> {
  const results: Array<{ entry: GlossaryEntry; color: string; inEn: boolean; inJa: boolean }> = []
  let colorIdx = 0

  for (const entry of entries) {
    const inEn = buildPattern(entry.en).test(sourceEn)
    const inJa = entry.ja.length > 0 && targetJa.includes(entry.ja)
    if (!inEn && !inJa) continue
    results.push({
      entry,
      color: TERM_COLOR_PALETTE[colorIdx % TERM_COLOR_PALETTE.length],
      inEn,
      inJa,
    })
    colorIdx++
  }

  return results
}

export function toSourceTerms(
  matched: Array<{ entry: GlossaryEntry; color: string; inEn: boolean }>,
): import('@/types/subtitle').GlossaryTerm[] {
  return matched
    .filter(m => m.inEn)
    .map(({ entry, color }) => ({
      word: entry.en,
      expectedTranslation: entry.ja,
      actualTranslation: entry.en,
      isDeviated: false,
      insight: entry.note ?? entry.desc,
      color,
    }))
}

export function toTargetTerms(
  matched: Array<{ entry: GlossaryEntry; color: string; inJa: boolean }>,
): import('@/types/subtitle').GlossaryTerm[] {
  return matched
    .filter(m => m.inJa)
    .map(({ entry, color }) => ({
      word: entry.ja,
      expectedTranslation: entry.en,
      actualTranslation: entry.ja,
      isDeviated: false,
      color,
    }))
}

/** @deprecated findMatchedGlossaryEntries + toSourceTerms を使うこと */
export function matchGlossaryToSource(
  source: string,
  entries: GlossaryEntry[],
): import('@/types/subtitle').GlossaryTerm[] {
  return toSourceTerms(findMatchedGlossaryEntries(source, '', entries))
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
): TypoCandidate[] {
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
