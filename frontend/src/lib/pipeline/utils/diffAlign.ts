/**
 * Diff ベースのアライメントユーティリティ。
 * Python PoC の difflib.SequenceMatcher.get_opcodes() に対応。
 *
 * 目的: 字幕ブロックの英語テキストが WhisperX 単語列のどの位置に対応するかを検出し、
 *       正確なタイムスタンプを割り当てる。
 *
 * 追加: 文字単位 diff アライメント（alignTimestamps）。
 *       ASR生テキスト ↔ LLM補正後テキスト の diff を取り、補正後テキストの各文字に
 *       元のタイムスタンプを引き継ぐ。Python PoC の poc_text_correction_alignment.py
 *       の align_timestamps() に対応。
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
  // 文内で消費した位置を追跡し、トークンが順序通りに出現することを保証する。
  let textSearchFrom = 0

  for (let i = searchFrom; i < allWords.length; i++) {
    const word = allWords[i].word.trim()
    if (word.length > 0) {
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

// ─────────────────────────────────────────────────────────────────────────────
// 文字単位 diff アライメント（Python PoC の align_timestamps に対応）
// ─────────────────────────────────────────────────────────────────────────────

/** 文字単位のタイムスタンプ */
export interface CharWithTS {
  readonly char: string
  readonly start: number
  readonly end: number
}

type EditTag = 'equal' | 'delete' | 'insert' | 'replace'
type OpCode = readonly [EditTag, number, number, number, number]

/**
 * 2つの文字列間の LCS ベース編集操作列を返す。
 * Python difflib.SequenceMatcher(autojunk=False).get_opcodes() に対応。
 *
 * O(m*n) — 各セグメント（〜300文字）では十分高速。
 */
export function getOpcodes(a: string, b: string): readonly OpCode[] {
  const m = a.length
  const n = b.length

  // LCS DP テーブル
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1])
    }
  }

  // バックトレースでマッチ位置を収集
  const matches: Array<[number, number]> = []
  let i = m, j = n
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      matches.push([i - 1, j - 1])
      i--; j--
    } else if (i > 0 && (j === 0 || dp[i - 1][j] >= dp[i][j - 1])) {
      i--
    } else {
      j--
    }
  }
  matches.reverse()

  // 連続マッチをブロックに集約
  const eqBlocks: Array<[number, number, number]> = [] // [a_start, b_start, size]
  for (const [ai, bj] of matches) {
    if (eqBlocks.length > 0) {
      const last = eqBlocks[eqBlocks.length - 1]
      if (last[0] + last[2] === ai && last[1] + last[2] === bj) {
        last[2]++
        continue
      }
    }
    eqBlocks.push([ai, bj, 1])
  }
  eqBlocks.push([m, n, 0]) // sentinel

  // ブロック → opcodes
  const ops: OpCode[] = []
  let ai = 0, bj = 0
  for (const [aStart, bStart, size] of eqBlocks) {
    if (ai < aStart && bj < bStart) {
      ops.push(['replace', ai, aStart, bj, bStart])
    } else if (ai < aStart) {
      ops.push(['delete', ai, aStart, bj, bj])
    } else if (bj < bStart) {
      ops.push(['insert', ai, ai, bj, bStart])
    }
    if (size > 0) {
      ops.push(['equal', aStart, aStart + size, bStart, bStart + size])
    }
    ai = aStart + size
    bj = bStart + size
  }

  return ops
}

/**
 * words[]（形態素単位TS）から文字単位TSを構築する。
 * 各単語の時間を均等に文字数で分配する。
 */
export function buildCharTS(words: readonly WordTimestampFlat[]): readonly CharWithTS[] {
  const result: CharWithTS[] = []
  for (const w of words) {
    const chars = [...w.word] // スプレッドで Unicode サロゲートペア対応
    if (chars.length === 0) continue
    const dur = (w.end - w.start) / chars.length
    for (let k = 0; k < chars.length; k++) {
      result.push({
        char: chars[k],
        start: w.start + dur * k,
        end: w.start + dur * (k + 1),
      })
    }
  }
  return result
}

/**
 * ASR生テキスト（文字TS付き）と補正後テキストの diff を取り、
 * 補正後テキストの各文字にタイムスタンプを付け直す。
 *
 * Python PoC の poc_text_correction_alignment.py の align_timestamps() に対応。
 *
 *   equal   → 元のタイムスタンプをそのまま引き継ぐ
 *   delete  → フィラー削除。タイムスタンプを捨てる（lastEnd を進める）
 *   insert  → 句読点追加。直前文字の end を使う（duration=0）
 *   replace → 誤字修正。元文字のTSを新文字に付け直す（1対1対応、余剰は lastEnd）
 *
 * @param originalChars - ASR生の文字TS（buildCharTS で構築）
 * @param correctedText - LLM補正後テキスト（originalChars の raw テキストと diff を取る）
 * @returns correctedText の各文字に対応した CharWithTS[]
 */
export function alignTimestamps(
  originalChars: readonly CharWithTS[],
  correctedText: string,
): readonly CharWithTS[] {
  if (originalChars.length === 0) return []

  const originalText = originalChars.map(c => c.char).join('')
  const ops = getOpcodes(originalText, correctedText)
  const result: CharWithTS[] = []
  let lastEnd = originalChars[0].start

  for (const [tag, i1, i2, j1, j2] of ops) {
    if (tag === 'equal') {
      for (let k = i1; k < i2; k++) {
        result.push(originalChars[k])
        lastEnd = originalChars[k].end
      }
    } else if (tag === 'delete') {
      // フィラー削除 → TSを捨て lastEnd を更新
      if (i2 > i1) lastEnd = originalChars[i2 - 1].end
    } else if (tag === 'insert') {
      // 句読点等の追加 → 直前 end を start/end に使う（duration=0）
      for (let k = j1; k < j2; k++) {
        result.push({ char: correctedText[k], start: lastEnd, end: lastEnd })
      }
    } else {
      // replace: 誤字修正 → 元文字のTSを新文字に付け直す
      const newLen = j2 - j1
      for (let k = 0; k < newLen; k++) {
        const src = k < i2 - i1 ? originalChars[i1 + k] : undefined
        result.push({
          char: correctedText[j1 + k],
          start: src ? src.start : lastEnd,
          end: src ? src.end : lastEnd,
        })
      }
      if (i2 > i1) lastEnd = originalChars[i2 - 1].end
    }
  }

  return result
}
