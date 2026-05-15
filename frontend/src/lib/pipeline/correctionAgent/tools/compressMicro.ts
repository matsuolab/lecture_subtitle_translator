import type { AdminSettings } from '@/types/adminSettings'
import type { EnBlock, PipelineThresholds } from '../../blockTypes'
import { normalizeSpaces } from '../../textUtils'
import { resolveMicroModelId } from '../../prompts'
import { computeMetrics, classifyViolation } from '../../metrics'
import { requireAiConnection, requireChatModelForProvider, resolveJsonResponseFormatForProvider } from '../../aiProvider'
import type { AgentThresholds, DecisionContext, TimelinePatch, Tool } from '../types'
import { buildMetrics } from '../metrics'
import { tauriFetch } from '@/lib/tauriFetch'
import { parseJsonObjectFromLlmContent } from '../../jsonResponse'

const MICRO_MAX_RETRIES = 5

function buildMicroSystemPrompt(): string {
  return (
    'You are a subtitle editor making the smallest possible edit. ' +
    'Your task: Remove EXACTLY ONE word from the current English subtitle while keeping its meaning unchanged.\n' +
    '\n' +
    'Rules:\n' +
    '- Keep all technical terms, proper nouns, numbers, and equations\n' +
    '- Keep the subject and main verb intact\n' +
    '- The result must remain a grammatical, readable English subtitle\n' +
    '- Prefer to remove: redundant adverbs, soft modifiers, articles where natural, hedges, repeated topic markers\n' +
    '- Do NOT rephrase, paraphrase, or restructure — only remove a single word\n' +
    '- Do NOT remove the same word that was already removed in previous iterations\n' +
    '\n' +
    'Respond with JSON: {"text": "<subtitle with exactly one word removed>"}'
  )
}

function countWords(text: string): number {
  const trimmed = text.trim()
  if (!trimmed) return 0
  return trimmed.split(/\s+/).length
}

async function microCompressOnce(
  currentEn: string,
  jaText: string,
  removedWordsSoFar: string[],
  settings: AdminSettings,
): Promise<string> {
  const connection = requireAiConnection(settings)
  const model = requireChatModelForProvider(settings, resolveMicroModelId(settings), 'compress micro')
  const systemPrompt = buildMicroSystemPrompt()

  const removedHint = removedWordsSoFar.length > 0
    ? `\n\nWords already removed in earlier iterations (do not remove these again): ${removedWordsSoFar.join(', ')}`
    : ''

  const response = await tauriFetch(`${connection.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(connection.apiKey ? { Authorization: `Bearer ${connection.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model,
      temperature: 0.0,
      response_format: resolveJsonResponseFormatForProvider(settings),
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: `Japanese source:\n${jaText}\n\nCurrent English subtitle:\n${currentEn}${removedHint}`,
        },
      ],
    }),
  })

  if (!response.ok) {
    const detail = await response.text()
    throw new Error(`compress_micro API returned HTTP ${response.status}: ${detail}`)
  }

  const payload = await response.json()
  const content: string = payload?.choices?.[0]?.message?.content ?? ''
  const parsed = parseJsonObjectFromLlmContent(content, 'compress_micro')
  const text = typeof parsed.text === 'string' ? parsed.text : ''
  return normalizeSpaces(text.trim())
}

// 削除された単語を推定（簡易版: 差分で消えた単語のうち最初のものを返す）
function detectRemovedWord(before: string, after: string): string | null {
  const beforeWords = before.trim().split(/\s+/)
  const afterWords = after.trim().split(/\s+/)
  if (beforeWords.length <= afterWords.length) return null

  // 単純な diff: 連続マッチで最初の不一致点を探す
  let i = 0
  while (i < afterWords.length && beforeWords[i] === afterWords[i]) i++
  return beforeWords[i] ?? null
}

interface MicroResult {
  finalText: string
  changed: boolean
  iterations: number
  reason: 'success' | 'no_progress' | 'duplicate' | 'max_retries' | 'no_change'
}

async function runMicroLoop(
  block: EnBlock,
  thresholds: PipelineThresholds & AgentThresholds,
  settings: AdminSettings,
): Promise<MicroResult> {
  const originalEnText = block.enText.replace(/\n/g, ' ')
  let current = originalEnText
  const history: string[] = [current]
  const removedWords: string[] = []

  for (let i = 0; i < MICRO_MAX_RETRIES; i++) {
    // 現状で合格判定（コード側で決定的に判定）
    const candidateBlock: EnBlock = {
      ...block,
      enText: current,
      enRaw: current,
      enChars: current.length,
      maxLineLen: current.length,
      cps: current.length / Math.max(0.001, block.end - block.start),
    }
    const candidateViolation = classifyViolation(candidateBlock, thresholds)
    if (candidateViolation === 'ok') {
      return {
        finalText: current,
        changed: current !== originalEnText,
        iterations: i,
        reason: 'success',
      }
    }

    // 1単語削減を試行
    let candidate: string
    try {
      candidate = await microCompressOnce(current, block.jaText, removedWords, settings)
    } catch {
      // API 失敗 → ループ打ち切り（最後に持っていた current を返す）
      return {
        finalText: current,
        changed: current !== originalEnText,
        iterations: i,
        reason: 'max_retries',
      }
    }

    // ガード: 空応答 or 単語数が減っていない → 進捗なし
    if (!candidate) {
      return {
        finalText: current,
        changed: current !== originalEnText,
        iterations: i,
        reason: 'no_progress',
      }
    }
    if (countWords(candidate) >= countWords(current)) {
      return {
        finalText: current,
        changed: current !== originalEnText,
        iterations: i,
        reason: 'no_progress',
      }
    }
    // ガード: 重複（ループ検出）
    if (history.includes(candidate)) {
      return {
        finalText: current,
        changed: current !== originalEnText,
        iterations: i,
        reason: 'duplicate',
      }
    }

    const removed = detectRemovedWord(current, candidate)
    if (removed) removedWords.push(removed)
    current = candidate
    history.push(candidate)
  }

  // max retries 到達 → 最終状態で再度合否判定
  const finalCandidate: EnBlock = {
    ...block,
    enText: current,
    enRaw: current,
    enChars: current.length,
    maxLineLen: current.length,
    cps: current.length / Math.max(0.001, block.end - block.start),
  }
  const finalViolation = classifyViolation(finalCandidate, thresholds)
  return {
    finalText: current,
    changed: current !== originalEnText,
    iterations: MICRO_MAX_RETRIES,
    reason: finalViolation === 'ok' ? 'success' : 'max_retries',
  }
}

export const compressMicroTool: Tool = {
  name: 'compress_micro',
  description: 'Remove exactly one word at a time, up to 5 retries. For tiny overshoot only.',

  canApply(ctx: DecisionContext): boolean {
    const compressCount = ctx.block.compressCount ?? 0
    const m = buildMetrics(ctx, ctx.thresholds as PipelineThresholds & AgentThresholds)
    return (
      m.tier === 'tiny' &&
      compressCount < ctx.thresholds.maxCompressPerBlock &&
      !ctx.attemptHistory.some(a => a.strategy === 'compress_micro')
    )
  },

  async execute(
    block: EnBlock,
    _ctx: DecisionContext,
    settings: AdminSettings,
    thresholds: PipelineThresholds & AgentThresholds,
  ): Promise<TimelinePatch> {
    const result = await runMicroLoop(block, thresholds, settings)

    const newEnText = result.changed ? result.finalText : block.enText
    const updatedBlock: EnBlock = {
      ...block,
      enText: newEnText,
      enRaw: result.changed ? result.finalText : block.enRaw,
      compressCount: (block.compressCount ?? 0) + 1,
      enTextOriginal: block.enTextOriginal ?? block.enText,
    }
    // metrics を最新化
    const metrics = computeMetrics(updatedBlock)
    updatedBlock.enChars = metrics.enChars
    updatedBlock.maxLineLen = metrics.maxLineLen
    updatedBlock.cps = metrics.cps

    const warning = result.reason !== 'success'
      ? `compress_micro: ${result.reason} after ${result.iterations} iteration(s)`
      : undefined

    return {
      replaceBlocks: [updatedBlock],
      dirtyBlockIds: [String(block.id)],
      changed: result.changed,
      warning,
    }
  },
}
