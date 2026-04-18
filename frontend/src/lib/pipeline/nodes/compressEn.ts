/**
 * compressEn ノード。
 * formatLines 後に行長（maxChars）を超過した字幕ブロックを LLM フィードバックループで短縮する。
 *
 * 設計思想（PoC 実証済み前提）:
 *   - LLM はプロンプトで文字数制約に従えない（短くする・長くするという方向性しか伝えられない）
 *   - TypeScript が正確に計測 → "line 1 is 49 chars, 7 over limit" と伝える
 *   - LLM は「短くする」方向性のみ受け取り、TypeScript が合否判定（tool-use フィードバックループ）
 *
 * Embedding バッチ化（コスト最適化）:
 *   - 全ブロックの LLM ループ完了後に 1 回の embed() 呼び出しでバッチ処理
 *   - triplet [JA, EN_orig, EN_compressed] で同時チェック:
 *       distAB = JA→EN_orig   : translationDistance（translateEn の TODO を解消）
 *       distBC = EN_orig→EN_compressed : 圧縮による意味変化
 *       distAC = JA→EN_compressed : 最終的な翻訳品質（フラグ判定）
 *
 * LLM 使用: OpenAI Chat Completions（multi-turn）
 */

import OpenAI from 'openai'
import type { NodeContract, NodeContext } from '../nodeContract'
import type { EnglishBlock } from '../types'
import type { EmbedProvider } from '../providers/openaiEmbedProvider'
import { batchTripletDistances } from '../utils/embedUtils'

const MAX_COMPRESS_ATTEMPTS = 5

/**
 * CPS がこれ未満のブロックは圧縮をスキップする。
 * 既にテキストが短すぎる（講義感が失われる）ブロックをさらに短縮しないための安全弁。
 */
const MIN_CPS_TO_COMPRESS = 5.0

/**
 * JA→EN_compressed コサイン距離がこれを超えたら意味喪失とみなしてフラグを立てる。
 * PoC: 平均距離 0.05〜0.12 程度、0.15 を閾値に設定。
 */
const SEMANTIC_DISTANCE_THRESHOLD = 0.15

// System prompt を先頭固定にすることで OpenAI のプロンプトキャッシュを活用する。
const SYSTEM_PROMPT = `You are a professional subtitle editor specializing in compression.
Your job is to shorten subtitle text so each line fits within the character limit.

Rules:
- Output ONLY the subtitle text. No explanations, labels, or quotes.
- Use \\n to create a second line if needed.
- Preserve the core meaning and all technical terms.
- Prefer natural, direct phrasing.
- Drop filler words ("As I mentioned", "In other words", "Basically").`

function buildFirstUserMessage(text: string, maxChars: number): string {
  const lines = text.split('\n')
  const measurements = lines
    .map((line, i) => {
      const over = line.length - maxChars
      return over > 0
        ? `  Line ${i + 1}: "${line}" → ${line.length} chars, ${over} over the ${maxChars}-char limit`
        : `  Line ${i + 1}: "${line}" → ${line.length} chars (OK)`
    })
    .join('\n')

  return `Shorten this subtitle so each line is ≤${maxChars} characters:\n\n${text}\n\nMeasurements:\n${measurements}`
}

function buildRetryUserMessage(text: string, maxChars: number, attempt: number): string {
  const lines = text.split('\n')
  const measurements = lines
    .map((line, i) => {
      const over = line.length - maxChars
      return over > 0
        ? `  Line ${i + 1}: "${line}" → ${line.length} chars, still ${over} over`
        : `  Line ${i + 1}: "${line}" → ${line.length} chars (OK)`
    })
    .join('\n')

  return `Still too long (attempt ${attempt}/${MAX_COMPRESS_ATTEMPTS}). Shorten more:\n\n${measurements}`
}

function isWithinLimit(text: string, maxChars: number): boolean {
  return text.split('\n').every(l => l.length <= maxChars)
}

function totalOverflow(text: string, maxChars: number): number {
  return text.split('\n').reduce((sum, l) => sum + Math.max(0, l.length - maxChars), 0)
}

function normalizeOutput(raw: string): string {
  return raw
    .trim()
    .replace(/\\n/g, '\n')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
}

export interface CompressEnInput {
  readonly blocks: readonly EnglishBlock[]
  readonly embedProvider?: EmbedProvider
}

export interface CompressEnStats {
  readonly total: number
  readonly violating: number      // 行長超過（処理候補）
  readonly skippedLowCps: number  // CPS低すぎでスキップ
  readonly compressed: number     // 実際に圧縮成功
  readonly flagged: number        // translationFlagged になった数
}

export interface CompressEnOutput {
  readonly blocks: readonly EnglishBlock[]
  readonly stats: CompressEnStats
}

// LLM ループの結果を一時保持する内部型
interface LLMResult {
  readonly idx: number
  readonly jaText: string
  readonly originalText: string
  readonly bestText: string
  readonly succeeded: boolean
}

export const compressEnNode: NodeContract<
  CompressEnInput,
  CompressEnOutput
> = {
  id: 'compressEn',
  schemaVersion: '1.0',

  async run(
    input: CompressEnInput,
    ctx: NodeContext,
  ): Promise<CompressEnOutput> {
    const { blocks, embedProvider } = input
    const { maxChars } = ctx.config.subtitleConstraints

    // 行長超過ブロックを特定し、低CPS スキップを分けてカウント
    const allViolatingIndices = blocks
      .map((_, i) => i)
      .filter(i => blocks[i].enText.split('\n').some(l => l.length > maxChars))

    const violatingIndices = allViolatingIndices.filter(i => {
      const b = blocks[i]
      const dur = b.end - b.start
      if (dur > 0) {
        const charCount = b.enText.split('\n').reduce((s, l) => s + l.length, 0)
        const cps = charCount / dur
        if (cps < MIN_CPS_TO_COMPRESS) return false
      }
      return true
    })

    const skippedLowCps = allViolatingIndices.length - violatingIndices.length

    if (violatingIndices.length === 0) {
      ctx.onProgress(`compressEn: 行長超過なし / ${skippedLowCps > 0 ? `低CPS スキップ ${skippedLowCps}件` : 'スキップ'}`)
      return {
        blocks,
        stats: { total: blocks.length, violating: allViolatingIndices.length, skippedLowCps, compressed: 0, flagged: 0 },
      }
    }

    ctx.onProgress(`compressEn: ${violatingIndices.length} ブロック短縮中...${skippedLowCps > 0 ? `（低CPS スキップ: ${skippedLowCps}件）` : ''}`)

    const { openaiApiKey, translationModel } = ctx.config
    const client = new OpenAI({ apiKey: openaiApiKey, dangerouslyAllowBrowser: true })

    // ── Phase 1: 全ブロックの LLM ループ（embed なし）──────────────────────
    const llmResults: LLMResult[] = []

    for (const idx of violatingIndices) {
      const block = blocks[idx]
      const originalText = block.enText

      const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildFirstUserMessage(originalText, maxChars) },
      ]

      let bestText = originalText
      let bestOverflow = totalOverflow(originalText, maxChars)
      let succeeded = false

      for (let attempt = 1; attempt <= MAX_COMPRESS_ATTEMPTS; attempt++) {
        const response = await client.chat.completions.create({
          model: translationModel,
          messages,
        })

        ctx.reportUsage({
          tokensIn: response.usage?.prompt_tokens ?? 0,
          tokensOut: response.usage?.completion_tokens ?? 0,
          model: translationModel,
          provider: 'openai',
        })

        const assistantContent = response.choices[0]?.message.content ?? ''
        const currentText = normalizeOutput(assistantContent)

        if (isWithinLimit(currentText, maxChars)) {
          bestText = currentText
          succeeded = true
          break
        }

        const overflow = totalOverflow(currentText, maxChars)
        if (overflow < bestOverflow) {
          bestText = currentText
          bestOverflow = overflow
        }

        messages.push({ role: 'assistant', content: assistantContent })
        messages.push({
          role: 'user',
          content: buildRetryUserMessage(currentText, maxChars, attempt + 1),
        })
      }

      llmResults.push({ idx, jaText: block.jaText, originalText, bestText, succeeded })
    }

    // ── Phase 2: バッチ Embedding（1 回の API 呼び出しで全ブロック処理）────
    let distances: ReadonlyArray<{ distAB: number; distBC: number; distAC: number }> | null = null
    if (embedProvider && llmResults.length > 0) {
      try {
        const triplets = llmResults.map(r => [r.jaText, r.originalText, r.bestText] as const)
        distances = await batchTripletDistances(triplets, (texts) => embedProvider.embed(texts))
      } catch {
        // embed 失敗は無視（フラグは succeeded ベースのみ）
      }
    }

    // ── Phase 3: ブロック更新（フラグ・距離を反映）─────────────────────────
    const result: EnglishBlock[] = [...blocks]
    let compressedCount = 0
    let flaggedCount = 0

    for (let i = 0; i < llmResults.length; i++) {
      const r = llmResults[i]
      const dist = distances?.[i]

      // JA→EN_compressed 距離が閾値を超えたら意味喪失フラグ
      const semanticFlag = dist != null && r.succeeded && dist.distAC > SEMANTIC_DISTANCE_THRESHOLD
      const translationFlagged = !r.succeeded || semanticFlag

      result[r.idx] = {
        ...blocks[r.idx],
        enText: r.bestText,
        translationFlagged,
        // distAB = JA→EN_orig（translateEn の translationDistance: 0 を解消）
        translationDistance: dist?.distAB ?? 0,
      }

      if (r.succeeded) compressedCount++
      if (translationFlagged) flaggedCount++
    }

    return {
      blocks: result,
      stats: {
        total: blocks.length,
        violating: allViolatingIndices.length,
        skippedLowCps,
        compressed: compressedCount,
        flagged: flaggedCount,
      },
    }
  },
}
