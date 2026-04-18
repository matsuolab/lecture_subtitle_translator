/**
 * expandEn ノード。
 * over_compressed（翻訳が短すぎる）ブロックを JA 原文参照で完全文に拡張再翻訳する。
 *
 * 検知条件（DiagnosticPattern: over_compressed）:
 *   - jaChars（空白除く）> 15
 *   - EN/JA 文字数比 < 0.25
 *   - CPS < 5（話者速度との比較で短すぎる）
 *
 * 処理フロー:
 *   1. 対象ブロックを特定
 *   2. JA を見て完全文で英訳し直す（最大 3 回）
 *   3. EN/JA 比 ≥ 0.30 を目標値とする
 *   4. 全ループ後にバッチ Embedding でトリプレット品質チェック
 *      [JA, EN_orig, EN_expanded] → distAB（翻訳品質）・distAC（拡張後品質）
 *
 * Embedding バッチ化:
 *   - 全ブロック処理後に 1 回の embed() 呼び出し
 *   - OpenAI キャッシュ活用のため system prompt を先頭固定
 *
 * LLM 使用: OpenAI Chat Completions（multi-turn）
 */

import OpenAI from 'openai'
import type { NodeContract, NodeContext } from '../nodeContract'
import type { EnglishBlock } from '../types'
import type { EmbedProvider } from '../providers/openaiEmbedProvider'
import { batchTripletDistances } from '../utils/embedUtils'

const MAX_EXPAND_ATTEMPTS = 3

/** EN/JA 比がこれ以上になれば拡張成功とみなす */
const TARGET_EN_JA_RATIO = 0.30

/** 検知閾値: EN/JA 比がこれ未満 + jaChars > MIN_JA_CHARS + CPS < MAX_CPS_TO_EXPAND */
const OVER_COMPRESSED_EN_JA_THRESHOLD = 0.25
const MIN_JA_CHARS = 15
const MAX_CPS_TO_EXPAND = 5.0

/**
 * JA→EN_expanded コサイン距離がこれを超えたら意味的乖離フラグ。
 * 拡張は圧縮より変化量が大きいため、compressEn (0.15) より少し広めに設定。
 */
const SEMANTIC_DISTANCE_THRESHOLD = 0.20

// System prompt を先頭固定にすることで OpenAI プロンプトキャッシュを活用する。
const SYSTEM_PROMPT = `You are a professional subtitle translator.
Your job is to ensure that English subtitle text fully represents the meaning of the Japanese original.

Rules:
- Output ONLY the subtitle text. No explanations, labels, or quotes.
- Use complete, natural sentences as spoken in a lecture.
- Preserve all technical terms, concepts, and the original scope.
- Do not omit important information or over-simplify key points.
- Match the information density of the Japanese text.`

function buildFirstUserMessage(jaText: string, enText: string): string {
  return `Japanese original: ${jaText}
Current English (too brief): ${enText}

Expand the English to fully capture the meaning of the Japanese. Use natural lecture phrasing.`
}

function buildRetryUserMessage(
  jaText: string,
  currentText: string,
  currentRatio: number,
  attempt: number,
): string {
  return `Still too brief (attempt ${attempt}/${MAX_EXPAND_ATTEMPTS}, EN/JA ratio: ${currentRatio.toFixed(2)}, target: ≥${TARGET_EN_JA_RATIO}).

Japanese original: ${jaText}
Current attempt: ${currentText}

Expand more to match the full scope of the Japanese.`
}

function computeEnJaRatio(enText: string, jaText: string): number {
  const jaChars = jaText.replace(/\s/g, '').length
  const enChars = enText.length
  return jaChars > 0 ? enChars / jaChars : 1.0
}

function normalizeOutput(raw: string): string {
  return raw
    .trim()
    .replace(/\\n/g, '\n')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
}

export interface ExpandEnInput {
  readonly blocks: readonly EnglishBlock[]
  readonly embedProvider?: EmbedProvider
}

export interface ExpandEnStats {
  readonly total: number
  readonly overCompressed: number  // over_compressed として検知されたブロック数
  readonly expanded: number        // EN/JA 比が目標に到達した数
  readonly flagged: number         // 3回後も EN/JA < 0.30（translationFlagged）
}

export interface ExpandEnOutput {
  readonly blocks: readonly EnglishBlock[]
  readonly stats: ExpandEnStats
}

// LLM ループの結果を一時保持する内部型
interface LLMResult {
  readonly idx: number
  readonly jaText: string
  readonly originalText: string
  readonly bestText: string
  readonly succeeded: boolean
}

export const expandEnNode: NodeContract<
  ExpandEnInput,
  ExpandEnOutput
> = {
  id: 'expandEn',
  schemaVersion: '1.0',

  async run(
    input: ExpandEnInput,
    ctx: NodeContext,
  ): Promise<ExpandEnOutput> {
    const { blocks, embedProvider } = input

    // over_compressed 検知
    const overCompressedIndices = blocks
      .map((b, i) => ({ b, i }))
      .filter(({ b }) => {
        const jaChars = b.jaText.replace(/\s/g, '').length
        if (jaChars <= MIN_JA_CHARS) return false

        const enChars = b.enText.length
        const enToJaRatio = jaChars > 0 ? enChars / jaChars : 1.0
        if (enToJaRatio >= OVER_COMPRESSED_EN_JA_THRESHOLD) return false

        const dur = b.end - b.start
        if (dur <= 0) return false
        const cps = enChars / dur
        return cps < MAX_CPS_TO_EXPAND
      })
      .map(({ i }) => i)

    if (overCompressedIndices.length === 0) {
      ctx.onProgress('expandEn: over_compressed なし')
      return {
        blocks,
        stats: { total: blocks.length, overCompressed: 0, expanded: 0, flagged: 0 },
      }
    }

    ctx.onProgress(`expandEn: ${overCompressedIndices.length} ブロック拡張中...`)

    const { openaiApiKey, translationModel } = ctx.config
    const client = new OpenAI({ apiKey: openaiApiKey, dangerouslyAllowBrowser: true })

    // ── Phase 1: 全ブロックの LLM ループ（embed なし）──────────────────────
    const llmResults: LLMResult[] = []

    for (const idx of overCompressedIndices) {
      const block = blocks[idx]
      const originalText = block.enText

      const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildFirstUserMessage(block.jaText, originalText) },
      ]

      let bestText = originalText
      let bestRatio = computeEnJaRatio(originalText, block.jaText)
      let succeeded = false

      for (let attempt = 1; attempt <= MAX_EXPAND_ATTEMPTS; attempt++) {
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
        const currentRatio = computeEnJaRatio(currentText, block.jaText)

        if (currentRatio >= TARGET_EN_JA_RATIO) {
          bestText = currentText
          succeeded = true
          break
        }

        // 比率が改善していれば bestText を更新（最良試行選択）
        if (currentRatio > bestRatio) {
          bestText = currentText
          bestRatio = currentRatio
        }

        messages.push({ role: 'assistant', content: assistantContent })
        messages.push({
          role: 'user',
          content: buildRetryUserMessage(block.jaText, currentText, currentRatio, attempt + 1),
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
        // embed 失敗は無視
      }
    }

    // ── Phase 3: ブロック更新（フラグ・距離を反映）─────────────────────────
    const result: EnglishBlock[] = [...blocks]
    let expandedCount = 0
    let flaggedCount = 0

    for (let i = 0; i < llmResults.length; i++) {
      const r = llmResults[i]
      const dist = distances?.[i]

      // JA→EN_expanded 距離が閾値を超えたら意味的乖離フラグ
      const semanticFlag = dist != null && r.succeeded && dist.distAC > SEMANTIC_DISTANCE_THRESHOLD
      const translationFlagged = !r.succeeded || semanticFlag

      result[r.idx] = {
        ...blocks[r.idx],
        enText: r.bestText,
        translationFlagged,
        // distAB = JA→EN_orig（translateEn の translationDistance: 0 を解消）
        translationDistance: dist?.distAB ?? 0,
      }

      if (r.succeeded) expandedCount++
      if (translationFlagged) flaggedCount++
    }

    return {
      blocks: result,
      stats: {
        total: blocks.length,
        overCompressed: overCompressedIndices.length,
        expanded: expandedCount,
        flagged: flaggedCount,
      },
    }
  },
}
