import type { AdminSettings } from '@/types/adminSettings'
import type { EnBlock, PipelineThresholds } from '../../blockTypes'
import { normalizeSpaces } from '../../textUtils'
import { resolveTranslateModelId } from '../../prompts'
import { formatLines } from '../../formatLines'
import { computeMetrics } from '../../metrics'
import { requireAiConnection, resolveChatModelForProvider } from '../../aiProvider'
import type { AgentThresholds, DecisionContext, TimelinePatch, Tool } from '../types'
import { buildMetrics } from '../metrics'

interface SplitResult {
  units: SplitUnit[]
  warning?: string  // LLM が期待形式を返さなかった場合に診断情報を含む
}

interface SplitUnit {
  text: string
  reason?: string
  confidence?: number
}

function fallbackSplitJa(jaText: string): SplitResult | null {
  // 句点・読点・接続表現の近くで分割を試みる
  const sentenceEnd = /[。！？、]|(?:について|として|ために|踏まえて|また|そして|ただし|一方で)/g
  let match: RegExpExecArray | null
  const candidates: number[] = []
  while ((match = sentenceEnd.exec(jaText)) !== null) {
    const pos = match.index + match[0].length
    if (pos > 0 && pos < jaText.length) candidates.push(pos)
  }

  // 中央に最も近い分割位置を選ぶ
  const half = jaText.length / 2
  let bestPos = -1
  let bestDist = Infinity
  for (const pos of candidates) {
    if (pos > 0 && pos < jaText.length) {
      const dist = Math.abs(pos - half)
      if (dist < bestDist) {
        bestDist = dist
        bestPos = pos
      }
    }
  }

  if (bestPos === -1) return null

  const first = normalizeJaSplitUnit(jaText.slice(0, bestPos))
  const second = normalizeJaSplitUnit(jaText.slice(bestPos))
  if (!first || !second) return null

  return {
    units: [
      { text: first, reason: 'semantic_boundary_fallback' },
      { text: second, reason: 'semantic_boundary_fallback' },
    ],
  }
}

function normalizeJaSplitUnit(text: string): string {
  return normalizeSpaces(text)
    .replace(/[、,]\s*$/g, '')
    .trim()
}

function normalizeJaUnit(text: string): string {
  return normalizeSpaces(text).replace(/\s/g, '')
}

function endsWithIncompleteJapanese(text: string): boolean {
  const normalized = normalizeJaUnit(text)
  return /([、,]|の|と|を|に|が|は|で|て|から|ため|として|について|には|では|ので|し|か|点で)$/.test(normalized)
}

function isBadJapaneseUnit(text: string): boolean {
  const normalized = normalizeJaUnit(text)
  return normalized.length < 6 || endsWithIncompleteJapanese(normalized)
}

function isBadEnglishUnit(text: string): boolean {
  const normalized = normalizeSpaces(text).replace(/\n/g, ' ')
  if (normalized.replace(/\s/g, '').length < 8) return true
  if (/^[a-z]/.test(normalized)) return true
  return /^(This|That|It|These|There is\.?|There are\.?|In that case,?|In the case of|Each one|Means)\.?$/i.test(normalized)
}

function confidenceOf(unit: SplitUnit): number {
  return typeof unit.confidence === 'number' && Number.isFinite(unit.confidence)
    ? unit.confidence
    : 1
}

function sanitizeUnits(units: SplitUnit[]): SplitUnit[] {
  return units
    .map((unit) => ({
      ...unit,
      text: normalizeSpaces(unit.text ?? ''),
    }))
    .filter((unit) => unit.text.length > 0)
    .slice(0, 3)
}

function parseSplitUnits(content: string): { units: SplitUnit[]; warning?: string } {
  let parsed: { units?: unknown; ja1?: unknown; ja2?: unknown; cannot_split?: unknown; warnings?: unknown } = {}
  try {
    parsed = JSON.parse(content) as typeof parsed
  } catch {
    return { units: [], warning: content ? `LLM returned invalid JSON: ${content.slice(0, 400)}` : 'LLM returned empty content' }
  }

  if (parsed.cannot_split === true) {
    return { units: [], warning: 'LLM reported cannot_split' }
  }

  if (Array.isArray(parsed.units)) {
    const units = parsed.units
      .map((item): SplitUnit | null => {
        if (typeof item === 'string') return { text: item }
        if (!item || typeof item !== 'object') return null
        const row = item as Record<string, unknown>
        const text = typeof row.text === 'string' ? row.text : ''
        return {
          text,
          reason: typeof row.reason === 'string' ? row.reason : undefined,
          confidence: typeof row.confidence === 'number' ? row.confidence : undefined,
        }
      })
      .filter((unit): unit is SplitUnit => unit !== null)
    return {
      units: sanitizeUnits(units),
      warning: Array.isArray(parsed.warnings) && parsed.warnings.length > 0
        ? `LLM warnings: ${parsed.warnings.map(String).join('; ')}`
        : undefined,
    }
  }

  const ja1 = typeof parsed.ja1 === 'string' ? parsed.ja1.trim() : ''
  const ja2 = typeof parsed.ja2 === 'string' ? parsed.ja2.trim() : ''
  if (ja1 && ja2) {
    return { units: sanitizeUnits([{ text: ja1 }, { text: ja2 }]) }
  }

  return { units: [], warning: content ? `LLM returned unexpected format: ${content.slice(0, 400)}` : 'LLM returned empty content' }
}

async function splitJaText(
  jaText: string,
  settings: AdminSettings,
): Promise<SplitResult> {  // warning フィールドが設定される場合がある
  const connection = requireAiConnection(settings)
  const model = resolveChatModelForProvider(settings, settings.correctionModel)

  const response = await fetch(`${connection.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${connection.apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.0,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            'Resegment this Japanese academic lecture subtitle into 1 to 3 subtitle units. ' +
            'Use 1 unit if splitting would be unnatural. Use 2 or 3 units only at clear semantic boundaries. ' +
            'Each unit must make sense independently and must not end with a particle, conjunction, or unfinished clause. ' +
            'Preserve technical terms, numbers, formulas, definitions, negations, conditions, and causal relations. ' +
            'You may remove filler, repeated setup phrases, and redundant lecture asides if no information is lost. ' +
            'If the text cannot be split safely, return {"cannot_split": true, "units": [], "warnings": ["reason"]}. ' +
            'Respond only with JSON: {"units":[{"text":"...","reason":"...","confidence":0.0}],"warnings":[]}',
        },
        { role: 'user', content: jaText },
      ],
    }),
  })

  if (!response.ok) {
    const detail = await response.text()
    throw new Error(`split_block (JA split) API returned HTTP ${response.status}: ${detail}`)
  }

  const payload = await response.json()
  const content: string = payload?.choices?.[0]?.message?.content ?? ''

  const parsed = parseSplitUnits(content)
  if (parsed.units.length > 0) return parsed

  // LLM が期待形式を返さなかった → 実レスポンスを記録して句点ベースのフォールバックへ
  const llmActual = parsed.warning ?? (content.length > 0
    ? `LLM returned: ${content.slice(0, 400)}`
    : 'LLM returned empty content')
  const warning = `split_block: could not use LLM units, fell back to sentence-boundary split. ${llmActual}`

  const fallback = fallbackSplitJa(jaText)
  if (fallback) {
    return { ...fallback, warning }
  }

  throw new Error(`split_block: could not split (no sentence boundary). ${llmActual}`)
}

const SINGLE_TRANSLATE_SYSTEM =
  'Translate this Japanese subtitle text into natural English. ' +
  'Keep technical terms, proper nouns, and formulas. Use casual-academic tone. Contractions are fine. ' +
  'The subtitle must make sense on its own. Do not start with This, That, It, or These when they refer to previous context. ' +
  'Repeat the noun when needed. Keep logical connectors, conditions, negations, numbers, and definitions. ' +
  'Use concise subtitle wording without adding explanations. ' +
  'Respond with JSON: {"text": "<translation>"}'

async function translateSingle(
  jaText: string,
  settings: AdminSettings,
): Promise<string> {
  const connection = requireAiConnection(settings)
  const model = resolveChatModelForProvider(settings, resolveTranslateModelId(settings.translationModel))

  const response = await fetch(`${connection.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${connection.apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SINGLE_TRANSLATE_SYSTEM },
        { role: 'user', content: jaText },
      ],
    }),
  })

  if (!response.ok) {
    const detail = await response.text()
    throw new Error(`split_block (translate) API returned HTTP ${response.status}: ${detail}`)
  }

  const payload = await response.json()
  const content: string = payload?.choices?.[0]?.message?.content ?? ''
  const parsed = JSON.parse(content) as { text?: unknown }
  const text = typeof parsed.text === 'string' ? parsed.text : ''
  return normalizeSpaces(text.trim())
}

function clampMs(ms: number, minMs: number): number {
  return Math.max(ms, minMs)
}

function buildFailurePatch(block: EnBlock, warning: string): TimelinePatch {
  return {
    replaceBlocks: [block],
    dirtyBlockIds: [String(block.id)],
    changed: false,
    warning,
  }
}

function allocateDurationsMs(weights: number[], availableMs: number, minDurationMs: number): number[] | null {
  if (weights.length === 0) return []
  if (availableMs < minDurationMs * weights.length) return null

  const remainingMs = availableMs - minDurationMs * weights.length
  const totalWeight = weights.reduce((sum, weight) => sum + Math.max(1, weight), 0)
  const durations = weights.map((weight) => minDurationMs + Math.floor(remainingMs * Math.max(1, weight) / totalWeight))
  let remainder = availableMs - durations.reduce((sum, duration) => sum + duration, 0)
  let index = 0
  while (remainder > 0) {
    durations[index % durations.length] += 1
    index += 1
    remainder -= 1
  }
  return durations
}

function validateSplitCandidates(
  original: EnBlock,
  candidates: EnBlock[],
  thresholds: PipelineThresholds & AgentThresholds,
): { ok: true; blocks: EnBlock[] } | { ok: false; warning: string } {
  const formatted = formatLines(candidates, thresholds)
  const originalMetrics = computeMetrics(formatLines([original], thresholds)[0])

  const invalid = formatted
    .map((block) => ({ block, metrics: computeMetrics(block) }))
    .find(({ metrics }) =>
      metrics.duration < thresholds.shortDurationSec ||
      metrics.cps > thresholds.verboseCps ||
      metrics.maxLineLen > thresholds.maxLineLen * 2
    )

  if (invalid) {
    return {
      ok: false,
      warning:
        `split_block: rejected candidate #${invalid.block.id}; ` +
        `duration=${invalid.metrics.duration.toFixed(2)}s, ` +
        `cps=${invalid.metrics.cps.toFixed(1)}, ` +
        `maxLine=${invalid.metrics.maxLineLen}`,
    }
  }

  const worstCps = Math.max(...formatted.map(block => computeMetrics(block).cps))
  const worstLine = Math.max(...formatted.map(block => computeMetrics(block).maxLineLen))
  const longestDuration = Math.max(...formatted.map(block => computeMetrics(block).duration))
  const improved =
    worstCps < originalMetrics.cps ||
    worstLine < originalMetrics.maxLineLen ||
    longestDuration < originalMetrics.duration

  if (!improved) {
    return {
      ok: false,
      warning: 'split_block: rejected candidate because it does not improve cps, line length, or duration',
    }
  }

  return { ok: true, blocks: formatted }
}

export const splitBlockTool: Tool = {
  name: 'split_block',
  description: 'Split Japanese into 2 semantic sentences. Re-translate each with proportional time.',

  canApply(ctx: DecisionContext): boolean {
    const m = buildMetrics(ctx, ctx.thresholds as PipelineThresholds & AgentThresholds)
    return m.splitViable && !ctx.attemptHistory.some(a => a.strategy === 'split_block')
  },

  async execute(
    block: EnBlock,
    _ctx: DecisionContext,
    settings: AdminSettings,
    thresholds: PipelineThresholds & AgentThresholds,
  ): Promise<TimelinePatch> {
    const { units, warning: splitWarning } = await splitJaText(block.jaText, settings)
    const cleanUnits = sanitizeUnits(units)

    if (cleanUnits.length < 2) {
      return buildFailurePatch(block, splitWarning ?? 'split_block: LLM returned fewer than 2 usable units')
    }

    const lowConfidence = cleanUnits.find(unit => confidenceOf(unit) < 0.65)
    if (lowConfidence) {
      return buildFailurePatch(block, 'split_block: rejected low-confidence split unit')
    }

    const badJa = cleanUnits.find(unit => isBadJapaneseUnit(unit.text))
    if (badJa) {
      return buildFailurePatch(block, `split_block: rejected incomplete or too-short Japanese unit: ${badJa.text}`)
    }

    const translated = await Promise.all(cleanUnits.map(unit => translateSingle(unit.text, settings)))
    const badEn = translated.find(en => isBadEnglishUnit(en))
    if (badEn) {
      return buildFailurePatch(block, `split_block: rejected fragment-like English unit: ${badEn}`)
    }

    const totalDurationMs = Math.round((block.end - block.start) * 1000)
    const gapMs = thresholds.minInterSubtitleGapMs
    const availableMs = totalDurationMs - gapMs * (cleanUnits.length - 1)
    const minDurationMs = Math.round(thresholds.subtitleMinDurationSec * 1000)

    const durationsMs = allocateDurationsMs(translated.map(en => en.length), availableMs, minDurationMs)
    if (!durationsMs) {
      return buildFailurePatch(block, 'split_block: rejected split because total duration cannot satisfy minimum display time')
    }

    const prevSplitDepth = (block as { splitDepth?: number }).splitDepth ?? 0
    let cursor = block.start
    const replaceBlocks = cleanUnits.map((unit, index): EnBlock => {
      const start = cursor
      const end = index === cleanUnits.length - 1
        ? block.end
        : start + clampMs(durationsMs[index], minDurationMs) / 1000
      cursor = end + gapMs / 1000
      const enText = translated[index]
      const nextBlock: EnBlock = {
        ...block,
        id: index === 0 ? block.id : block.id * 1000 + index + 1,
        start,
        end,
        jaText: unit.text,
        jaChars: unit.text.replace(/\s/g, '').length,
        enText,
        enRaw: enText,
        enChars: enText.length,
        cps: enText.length / Math.max(0.001, end - start),
        maxLineLen: enText.length,
        compressCount: 0,
        expandCount: 0,
        enTextOriginal: block.enTextOriginal ?? block.enText,
      }
      ;(nextBlock as unknown as Record<string, unknown>).splitDepth = prevSplitDepth + 1
      ;(nextBlock as unknown as Record<string, unknown>).splitFrom = block.id
      ;(nextBlock as unknown as Record<string, unknown>).splitIndex = index + 1
      return nextBlock
    })

    const validated = validateSplitCandidates(block, replaceBlocks, thresholds)
    if (!validated.ok) {
      return buildFailurePatch(block, validated.warning)
    }

    return {
      replaceBlocks: validated.blocks,
      dirtyBlockIds: validated.blocks.map(nextBlock => String(nextBlock.id)),
      changed: true,
      warning: splitWarning,
    }
  },
}
