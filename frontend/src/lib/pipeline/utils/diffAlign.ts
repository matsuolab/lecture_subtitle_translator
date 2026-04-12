/**
 * Diff ベースのアライメントユーティリティ。
 * Python PoC の difflib.SequenceMatcher.get_matching_blocks() に対応。
 *
 * 目的: 字幕ブロックの英語テキストが WhisperX 単語列のどの位置に対応するかを検出し、
 *       正確なタイムスタンプを割り当てる。
 */

export interface MatchingBlock {
  readonly a: number  // wordTokens 側の開始インデックス
  readonly b: number  // blockTokens 側の開始インデックス
  readonly size: number
}

/**
 * 2つのトークン列から最長一致ブロックを見つける。
 * Python の SequenceMatcher(autojunk=False).get_matching_blocks() の最大 size ブロックに相当。
 *
 * O(n*m) だが字幕サイズ（数十〜数百トークン）では十分高速。
 */
export function findBestMatchingBlock(
  wordTokens: readonly string[],
  blockTokens: readonly string[],
): MatchingBlock | null {
  let best: MatchingBlock = { a: 0, b: 0, size: 0 }

  for (let i = 0; i < wordTokens.length; i++) {
    for (let j = 0; j < blockTokens.length; j++) {
      let size = 0
      while (
        i + size < wordTokens.length &&
        j + size < blockTokens.length &&
        wordTokens[i + size] === blockTokens[j + size]
      ) {
        size++
      }
      if (size > best.size) {
        best = { a: i, b: j, size }
      }
    }
  }

  return best.size > 0 ? best : null
}

export interface WordTimestampFlat {
  readonly word: string
  readonly start: number
  readonly end: number
}

/**
 * 日本語テキストに対応したシーケンシャルマッチング。
 * WhisperX の単語（形態素）が文テキスト内に含まれるかどうかで対応を取る。
 * 必ず searchFrom 以降を前向きに探索するため、複数文を順番に処理できる。
 *
 * @param sentenceText - 字幕ブロックの日本語テキスト
 * @param allWords     - WhisperX の全単語タイムスタンプ（フラット化済み）
 * @param searchFrom   - 検索開始インデックス（複数文を順番に処理するとき）
 * @returns start/end 秒数と次回検索開始インデックス。マッチしなければ null。
 */
export function findTimeRangeSequential(
  sentenceText: string,
  allWords: readonly WordTimestampFlat[],
  searchFrom: number = 0,
): { start: number; end: number; nextSearchFrom: number } | null {
  if (allWords.length === 0 || !sentenceText.trim()) return null

  const normalized = sentenceText.trim()
  let firstIdx = -1
  let lastIdx = -1
  // 一致後に連続ミスが続いたら打ち切る（助詞等のギャップを許容）
  let consecutiveMisses = 0
  const MAX_CONSECUTIVE_MISSES = 8
  // 1文字単語はほぼ全ての文に含まれるため誤マッチを防ぐ
  // WhisperXが日本語を文字単位で出力した場合に特に有効
  const MIN_WORD_LENGTH = 2
  // 文内で消費した位置を追跡し、単語が文テキスト内で順序通りに出現することを保証する。
  // これにより、次の文にも含まれる単語（例: 「テーマ」が複数文に登場）が
  // 現在の文の end タイムスタンプを不正に延ばすことを防ぐ。
  let textSearchFrom = 0

  for (let i = searchFrom; i < allWords.length; i++) {
    const word = allWords[i].word.trim()
    if (word.length >= MIN_WORD_LENGTH) {
      const matchPos = normalized.indexOf(word, textSearchFrom)
      if (matchPos !== -1) {
        textSearchFrom = matchPos + word.length
        if (firstIdx === -1) firstIdx = i
        lastIdx = i
        consecutiveMisses = 0
      } else if (firstIdx !== -1) {
        consecutiveMisses++
        if (consecutiveMisses > MAX_CONSECUTIVE_MISSES) break
      }
    }
  }

  if (firstIdx === -1) return null

  return {
    start: allWords[firstIdx].start,
    end: allWords[lastIdx].end,
    nextSearchFrom: lastIdx + 1,
  }
}

/**
 * ブロックテキストに対応するタイムスタンプ範囲を検出する。
 *
 * @param blockText - 字幕ブロックの英語テキスト
 * @param allWords  - WhisperX の全単語タイムスタンプ（フラット化済み）
 * @returns start/end 秒数、マッチしなければ null
 */
export function findTimeRange(
  blockText: string,
  allWords: readonly WordTimestampFlat[],
): { start: number; end: number } | null {
  if (allWords.length === 0 || !blockText.trim()) return null

  const blockTokens = blockText.toLowerCase().split(/\s+/).filter(Boolean)
  const wordTokens = allWords.map(w => w.word.toLowerCase())

  if (blockTokens.length === 0) return null

  const best = findBestMatchingBlock(wordTokens, blockTokens)
  if (!best) return null

  const startIdx = best.a
  const endIdx = Math.min(best.a + best.size - 1, allWords.length - 1)

  return {
    start: allWords[startIdx].start,
    end: allWords[endIdx].end,
  }
}
