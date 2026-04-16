/**
 * formatLines ノード。
 * EN テキストが 1行 maxChars(42) 文字を超える場合に改行を挿入して2行化する。
 *
 * 設計思想:
 *   - タイムスタンプは変えない（同じブロック、時間は同じ）
 *   - CPS は変わらない（文字数合計が変わらないため）
 *   - 行長違反（>42文字）のみを解決する
 *   - Netflix "Timed Text Style Guide" の改行ルールに準拠
 *
 * LLM 不使用。純粋 TypeScript。
 */

import type { NodeContract, NodeContext } from '../nodeContract'
import type { EnglishBlock } from '../types'

// Netflix 改行ルール: 接続詞・前置詞の前で改行を優先
const CONJUNCTIONS  = /\b(and|but|or|so|yet|nor|for|because|although|though|while|when|where|who|which|that|if|unless|until|after|before|since|as)\b/i
const PREPOSITIONS  = /\b(in|on|at|for|with|by|of|to|from|into|through|about|between|among|against|without|within|during|across|behind|below|above|near|over|under|around|along|beside|despite|except|including|toward|upon|versus)\b/i
// 禁止分割: 冠詞+名詞、句動詞
const ARTICLE_BEFORE = /\b(a|an|the)$/i

/**
 * 最大文字数に収まるように最適な改行位置を探す。
 * 両行とも maxChars 以内になる位置を返す。なければ null。
 */
function findBestBreak(text: string, maxChars: number): string | null {
  if (text.length <= maxChars) return text

  const words = text.split(' ')
  if (words.length < 2) return null

  // 全ての単語境界を候補にし、優先度スコアを付ける
  interface Candidate {
    idx: number        // words[0..idx] が行1、words[idx+1..] が行2
    line1: string
    line2: string
    score: number      // 高いほど優先
    dist: number       // 中央からの距離（低いほど見た目バランスが良い）
  }

  const mid = text.length / 2
  const candidates: Candidate[] = []

  let pos = 0
  for (let i = 0; i < words.length - 1; i++) {
    pos += words[i].length + 1 // +1 for space
    const line1 = words.slice(0, i + 1).join(' ')
    const line2 = words.slice(i + 1).join(' ')

    if (line1.length > maxChars || line2.length > maxChars) continue

    // 冠詞で終わる行1は禁止
    if (ARTICLE_BEFORE.test(words[i])) continue

    // スコア計算（高いほど優先）
    let score = 0
    const nextWord = words[i + 1]
    if (CONJUNCTIONS.test(nextWord))  score += 3
    if (PREPOSITIONS.test(nextWord))  score += 2
    if (/[,.:;!?]$/.test(words[i]))  score += 4  // 句読点直後は最優先

    candidates.push({
      idx: i, line1, line2,
      score,
      dist: Math.abs(pos - mid),
    })
  }

  if (candidates.length === 0) return null

  // スコア降順 → 距離昇順でソート
  candidates.sort((a, b) =>
    b.score !== a.score ? b.score - a.score : a.dist - b.dist
  )

  const best = candidates[0]
  return best.line1 + '\n' + best.line2
}

export const formatLinesNode: NodeContract<
  readonly EnglishBlock[],
  readonly EnglishBlock[]
> = {
  id: 'formatLines',
  schemaVersion: '1.0',

  async run(
    input: readonly EnglishBlock[],
    ctx: NodeContext,
  ): Promise<readonly EnglishBlock[]> {
    ctx.onProgress('formatLines: 行長チェック・改行挿入中...')

    const { maxChars } = ctx.config.subtitleConstraints

    return input.map(block => {
      // 既に \n がある場合は各行をチェック
      const lines = block.enText.split('\n')
      const maxLine = Math.max(...lines.map(l => l.length))

      if (maxLine <= maxChars) return block  // 問題なし

      // 単一行の場合のみ改行挿入を試みる（既に2行ならスキップ）
      if (lines.length === 1) {
        const formatted = findBestBreak(block.enText, maxChars)
        if (formatted) {
          return { ...block, enText: formatted }
        }
        // 改行不可（1単語が42文字超など） → そのまま（finalQA がflagする）
      }

      return block
    })
  },
}
