/**
 * compressEn ノード。
 * formatLines 後に行長（maxChars）を超過した字幕ブロックを LLM フィードバックループで短縮する。
 *
 * 設計思想（PoC 実証済み前提）:
 *   - LLM はプロンプトで文字数制約に従えない（短くする・長くするという方向性しか伝えられない）
 *   - TypeScript が正確に計測 → "line 1 is 49 chars, 7 over limit" と伝える
 *   - LLM は「短くする」方向性のみ受け取り、TypeScript が合否判定（tool-use フィードバックループ）
 *   - 成功後: EmbedProvider があればコサイン距離で意味喪失チェック → 閾値超えは translationFlagged
 *   - MAX_COMPRESS_ATTEMPTS 回失敗: 最良試行を保持し translationFlagged = true（人間レビュー）
 *
 * LLM 使用: OpenAI Chat Completions（multi-turn）
 */

import OpenAI from 'openai'
import type { NodeContract, NodeContext } from '../nodeContract'
import type { EnglishBlock } from '../types'
import type { EmbedProvider } from '../providers/openaiEmbedProvider'

const MAX_COMPRESS_ATTEMPTS = 5

/**
 * コサイン距離がこれを超えたら意味喪失とみなす。
 * PoC: 平均距離 0.05〜0.12 程度、0.15 を閾値に設定。
 */
const SEMANTIC_DISTANCE_THRESHOLD = 0.15

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

function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  let dot = 0, normA = 0, normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  if (normA === 0 || normB === 0) return 1
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

/** LLM 出力から字幕テキストを正規化する（\n リテラルの正規化など） */
function normalizeOutput(raw: string): string {
  return raw
    .trim()
    .replace(/\\n/g, '\n')   // バックスラッシュ+n → 改行
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
}

export interface CompressEnInput {
  readonly blocks: readonly EnglishBlock[]
  readonly embedProvider?: EmbedProvider
}

export const compressEnNode: NodeContract<
  CompressEnInput,
  readonly EnglishBlock[]
> = {
  id: 'compressEn',
  schemaVersion: '1.0',

  async run(
    input: CompressEnInput,
    ctx: NodeContext,
  ): Promise<readonly EnglishBlock[]> {
    const { blocks, embedProvider } = input
    const { maxChars } = ctx.config.subtitleConstraints

    const violatingIndices = blocks
      .map((b, i) => i)
      .filter(i => blocks[i].enText.split('\n').some(l => l.length > maxChars))

    if (violatingIndices.length === 0) {
      ctx.onProgress('compressEn: 行長超過なし、スキップ')
      return blocks
    }

    ctx.onProgress(`compressEn: ${violatingIndices.length} ブロック短縮中...`)

    const { openaiApiKey, translationModel } = ctx.config
    const client = new OpenAI({ apiKey: openaiApiKey, dangerouslyAllowBrowser: true })

    // mutable コピー（index アクセスで更新）
    const result: EnglishBlock[] = [...blocks]

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

        // 改善していれば bestText を更新
        const overflow = totalOverflow(currentText, maxChars)
        if (overflow < bestOverflow) {
          bestText = currentText
          bestOverflow = overflow
        }

        // フィードバックを追加してリトライ
        messages.push({ role: 'assistant', content: assistantContent })
        messages.push({
          role: 'user',
          content: buildRetryUserMessage(currentText, maxChars, attempt + 1),
        })
      }

      // 意味喪失チェック（embedProvider が渡された場合のみ）
      let translationFlagged = !succeeded

      if (succeeded && embedProvider) {
        try {
          const embeddings = await embedProvider.embed([originalText, bestText])
          const similarity = cosineSimilarity(embeddings[0], embeddings[1])
          const distance = 1 - similarity
          if (distance > SEMANTIC_DISTANCE_THRESHOLD) {
            translationFlagged = true
          }
        } catch {
          // embed 失敗は無視（フラグは立てない）
        }
      }

      result[idx] = {
        ...block,
        enText: bestText,
        translationFlagged,
      }
    }

    return result
  },
}
