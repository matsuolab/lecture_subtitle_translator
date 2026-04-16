/**
 * translateEn ノード。
 * 日本語文ブロックを OpenAI SDK でバッチ英訳する。
 * タイムスタンプは JapaneseSentenceBlock からそのまま継承する。
 * 用語辞書（GlossaryItem[]）が渡された場合、EN訳語を一貫させるルールをプロンプトに付加する。
 */

import OpenAI from 'openai'
import type { NodeContract, NodeContext } from '../nodeContract'
import type { JapaneseSentenceBlock, EnglishBlock, GlossaryItem } from '../types'
import { formatNumberedInput, mergeWithFallback } from '../utils/numberedParse'

const BASE_SYSTEM_PROMPT = `You are a professional subtitle translator for university lectures.
Translate each numbered Japanese sentence to English.

Rules:
- Output format: [N] <translation> (one per line, same numbering as input)
- SUBTITLE LENGTH (critical): Each translation must fit within 2 lines, max 42 characters per line
  - If the content cannot fit in 42 chars, compress: omit filler phrases, use shorter synonyms
  - A single long sentence is WORSE than a slightly compressed short one
- Keep translations concise and natural (subtitle style)
- Preserve technical and academic terms exactly
- Use active voice where possible
- Each subtitle must be self-contained (no dangling phrases)
- Do NOT split mid-clause; end at a natural phrase boundary`

function buildSystemPrompt(glossaryItems: readonly GlossaryItem[]): string {
  if (glossaryItems.length === 0) return BASE_SYSTEM_PROMPT
  const termLines = glossaryItems
    .map(g => `  ${g.ja} → ${g.en}${g.abbr ? ` (abbr: ${g.abbr})` : ''}`)
    .join('\n')
  return BASE_SYSTEM_PROMPT + `\n\nDomain term translations (use these exact English spellings):\n${termLines}`
}

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
        { role: 'system', content: buildSystemPrompt(ctx.glossary) },
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
      alignConfidence: block.alignConfidence,
      attempt: block.attempt,
      sourceSegmentIds: block.sourceSegmentIds,
      blockKey: block.blockKey,
    }))
  },
}
