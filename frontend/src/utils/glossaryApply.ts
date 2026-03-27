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
 * 用語パターンを生成する
 *
 * compromise の語形解析でヒットしなかったケースを regex でカバー:
 * - 大文字・小文字の揺れ（transformer → Transformer）
 * - 単純複数形（Transformers → Transformer）
 * - 所有格（Transformer's → Transformer）
 * - ハイフン表記（back-propagation → backpropagation）
 */
function buildPattern(term: string): RegExp {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`\\b${escaped}(?:'?s)?\\b`, 'gi')
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
    const pattern = buildPattern(entry.en)

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
 * LLM が訳語を意訳・省略した場合に検知できる。
 * compromise を使って英語側の語形変化も考慮してチェックする。
 */
export function findMissingTranslations(
  target: string,
  source: string,
  entries: GlossaryEntry[],
): MissingTerm[] {
  return entries
    .filter(e => e.confirmed)
    .filter(entry => {
      const jaFound = target.includes(entry.ja)
      if (!jaFound) return false

      // まず regex でチェック
      const pattern = buildPattern(entry.en)
      const enFoundByRegex = pattern.test(source)
      if (enFoundByRegex) return false

      // regex に引っかからなかった場合 compromise でも確認
      const enFoundByNlp = findWithNlp(source, entry.en)
      return !enFoundByNlp
    })
    .map(entry => ({ entry, jaFound: true, enMissing: true }))
}

export type { GlossaryEntry }
