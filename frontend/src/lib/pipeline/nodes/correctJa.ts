/**
 * correctJa ノード。
 * WhisperX の生書き起こしテキストを OpenAI でバッチ補正する。
 * 補正前後の意味乖離を Embedding コサイン距離でチェックしフラグを立てる。
 *
 * バッチ処理: BATCH_SIZE 件ずつ LLM に送る（トークン制限対策）
 * 乖離チェック: correctionDistance > threshold → correctionFlagged = true
 */

import OpenAI from 'openai'
import type { NodeContract, NodeContext } from '../nodeContract'
import type { TranscriptSegment, CorrectedSegment } from '../types'
import { formatNumberedInput, mergeWithFallback } from '../utils/numberedParse'
import { cosineDistance } from '../utils/cosine'
import type { EmbedProvider } from '../providers/openaiEmbedProvider'

const BATCH_SIZE = 20

const BASE_SYSTEM_PROMPT = `You are correcting Japanese lecture transcription errors produced by WhisperX ASR.

Rules:
- Fix obvious ASR errors (mishearing, homophones, missing punctuation)
- Add sentence-ending punctuation（。！？）where missing
- Preserve technical and academic terms exactly
- Do NOT change meaning or rephrase for style
- Do NOT translate — output must be Japanese
- Output format: [N] <corrected text> (one per line, same numbering as input)
- If a segment is already correct, output it unchanged`

function buildSystemPrompt(glossaryItems: readonly import('../types').GlossaryItem[]): string {
  if (glossaryItems.length === 0) return BASE_SYSTEM_PROMPT
  const termLines = glossaryItems
    .map(g => `  ${g.en}（カタカナ：${g.ja}）`)
    .join('\n')
  return BASE_SYSTEM_PROMPT + `\n\nDomain term normalization (use exact JA spelling):\n${termLines}`
}

export interface CorrectJaInput {
  readonly segments: readonly TranscriptSegment[]
  readonly embedProvider?: EmbedProvider  // 省略時はフラグチェックをスキップ
}

export const correctJaNode: NodeContract<CorrectJaInput, readonly CorrectedSegment[]> = {
  id: 'correctJa',
  schemaVersion: '1.0',

  async run(
    input: CorrectJaInput,
    ctx: NodeContext,
  ): Promise<readonly CorrectedSegment[]> {
    ctx.onProgress('correctJa: 日本語補正中...')

    const { segments, embedProvider } = input
    const { openaiApiKey, correctionModel } = ctx.config
    const correctionThreshold = ctx.config.qualityThresholds.correction

    const client = new OpenAI({ apiKey: openaiApiKey, dangerouslyAllowBrowser: true })

    // バッチごとに LLM 補正を実行
    const correctedTexts = new Map<number, string>()

    for (let i = 0; i < segments.length; i += BATCH_SIZE) {
      const batch = segments.slice(i, i + BATCH_SIZE)
      ctx.onProgress(`correctJa: ${i + 1}〜${Math.min(i + BATCH_SIZE, segments.length)} 件目を補正中...`)

      const inputMap = new Map(batch.map(s => [s.id, s.text]))
      const userPrompt = formatNumberedInput(inputMap)

      const response = await client.chat.completions.create({
        model: correctionModel,
        messages: [
          { role: 'system', content: buildSystemPrompt(ctx.glossary) },
          { role: 'user', content: userPrompt },
        ],
      })

      ctx.reportUsage({
        tokensIn: response.usage?.prompt_tokens ?? 0,
        tokensOut: response.usage?.completion_tokens ?? 0,
        model: correctionModel,
        provider: 'openai',
      })

      const content = response.choices[0]?.message.content ?? ''
      const batchResult = mergeWithFallback(inputMap, content)
      batchResult.forEach((text, id) => correctedTexts.set(id, text))
    }

    // Embedding 乖離チェック（embedProvider が渡された場合のみ）
    let distances: Map<number, number> = new Map()
    if (embedProvider) {
      distances = await computeDistances(segments, correctedTexts, embedProvider)
    }

    // correctionDistance > 0.5 は LLM が全く別の内容に置き換えた可能性が高い
    // タイムスタンプアライメントが破綻するため元テキストに差し戻す
    const REVERT_THRESHOLD = 0.5

    return segments.map(seg => {
      const rawCorrected = correctedTexts.get(seg.id) ?? seg.text
      const correctionDistance = distances.get(seg.id) ?? 0
      const correctionFlagged = correctionDistance > correctionThreshold
      // embedProvider なし（distanceが全て0）のときは差し戻しをスキップ
      const shouldRevert = embedProvider != null && correctionDistance > REVERT_THRESHOLD
      return {
        original: seg,
        correctedText: shouldRevert ? seg.text : rawCorrected,
        correctionDistance,
        correctionFlagged,
      }
    })
  },
}

// ---------------------------------------------------------------------------
// Embedding コサイン距離の一括計算
// ---------------------------------------------------------------------------

async function computeDistances(
  segments: readonly TranscriptSegment[],
  correctedTexts: Map<number, string>,
  embedProvider: EmbedProvider,
): Promise<Map<number, number>> {
  const originals = segments.map(s => s.text)
  const corrected = segments.map(s => correctedTexts.get(s.id) ?? s.text)

  // 変化がないセグメントは Embed をスキップ（コスト削減）
  const changedIndices = segments
    .map((s, i) => ({ s, i, changed: s.text !== corrected[i] }))
    .filter(x => x.changed)
    .map(x => x.i)

  if (changedIndices.length === 0) return new Map()

  const origTexts = changedIndices.map(i => originals[i])
  const corrTexts = changedIndices.map(i => corrected[i])

  const [origEmbeds, corrEmbeds] = await Promise.all([
    embedProvider.embed(origTexts),
    embedProvider.embed(corrTexts),
  ])

  const result = new Map<number, number>()
  changedIndices.forEach((segIdx, embedIdx) => {
    const segId = segments[segIdx].id
    const dist = cosineDistance(origEmbeds[embedIdx], corrEmbeds[embedIdx])
    result.set(segId, dist)
  })
  return result
}
