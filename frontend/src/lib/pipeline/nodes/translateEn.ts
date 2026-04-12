/**
 * translateEn ノード。
 * 日本語文ブロックを OpenAI SDK でバッチ英訳する。
 * タイムスタンプは JapaneseSentenceBlock からそのまま継承する。
 */

import OpenAI from 'openai'
import type { NodeContract, NodeContext } from '../nodeContract'
import type { JapaneseSentenceBlock, EnglishBlock } from '../types'
import { formatNumberedInput, mergeWithFallback } from '../utils/numberedParse'

const SYSTEM_PROMPT = `You are a professional subtitle translator for university lectures.
Translate each numbered Japanese sentence to English.
Rules:
- Output format: [N] <translation> (one per line, same numbering as input)
- Keep translations concise and natural (subtitle style)
- Preserve technical and academic terms
- Use active voice where possible
- Each line must be self-contained`

export const translateEnNode: NodeContract<
  readonly JapaneseSentenceBlock[],
  readonly EnglishBlock[]
> = {
  id: 'translateEn',
  schemaVersion: '1.0',

  async run(
    input: readonly JapaneseSentenceBlock[],
    ctx: NodeContext,
  ): Promise<readonly EnglishBlock[]> {
    ctx.onProgress('translateEn: 英訳中...')

    const { openaiApiKey, translationModel } = ctx.config

    const client = new OpenAI({
      apiKey: openaiApiKey,
      dangerouslyAllowBrowser: true,
    })

    const inputMap = new Map(input.map(b => [b.id, b.jaText]))
    const userPrompt = formatNumberedInput(inputMap)

    const response = await client.chat.completions.create({
      model: translationModel,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
    })

    ctx.reportUsage({
      tokensIn: response.usage?.prompt_tokens ?? 0,
      tokensOut: response.usage?.completion_tokens ?? 0,
      model: translationModel,
      provider: 'openai',
    })

    const content = response.choices[0]?.message.content ?? ''
    const translated = mergeWithFallback(inputMap, content)

    return input.map(block => ({
      id: block.id,
      start: block.start,
      end: block.end,
      jaText: block.jaText,
      enText: translated.get(block.id) ?? block.jaText,
      translationDistance: 0,   // TODO: cosine similarity (Phase 3)
      translationFlagged: false,
      attempt: block.attempt,
      sourceSegmentIds: block.sourceSegmentIds,
      blockKey: block.blockKey,
    }))
  },
}
