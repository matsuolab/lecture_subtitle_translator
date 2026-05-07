import type { AdminSettings } from '@/types/adminSettings'
import type { PipelineCorrectionAttemptSummary } from '@/types/pipeline'
import type { EnBlock, PipelineThresholds } from './blockTypes'
import { classifyViolation, computeMetrics } from './metrics'
import { formatLines } from './formatLines'
import { normalizeSpaces } from './textUtils'
import {
  hasContinuationEnd,
  hasFragmentStart,
  hasSentenceEnd,
  loadLanguageProfileConfig,
  type LanguageProfileConfig,
} from './languageProfileConfig'

type MergeDecisionKind = 'merge_prev' | 'merge_next' | 'keep'

interface MergeDecision {
  decision: MergeDecisionKind
  subtitleText: string
  transcriptText: string
  rationale: string
}

type OnWarning = (blockId: string, message: string) => void

const MAX_CONTEXT_MERGE_ATTEMPTS = 80
const MAX_ABSORB_GAP_SEC = 0.45
const MAX_MERGED_DURATION_SEC = 12

function compactText(text: string): string {
  return text.replace(/\s/g, '')
}

function countJapaneseChars(text: string): number {
  return text.match(/[\u3040-\u30ff\u3400-\u9fff]/g)?.length ?? 0
}

function countLatinChars(text: string): number {
  return text.match(/[A-Za-z]/g)?.length ?? 0
}

function isClearlyJapanese(text: string): boolean {
  const japanese = countJapaneseChars(text)
  const latin = countLatinChars(text)
  return japanese >= 8 && japanese > latin * 2
}

function isClearlyEnglish(text: string): boolean {
  const latin = countLatinChars(text)
  const japanese = countJapaneseChars(text)
  return latin >= 8 && japanese <= latin * 0.2
}

function endsWithTranscriptContinuation(text: string, config: LanguageProfileConfig): boolean {
  return hasContinuationEnd(text, config.transcript)
}

function isContextDependentSubtitle(text: string, config: LanguageProfileConfig): boolean {
  const normalized = text.trim().replace(/\s+/g, ' ')
  if (hasFragmentStart(normalized, config.subtitle)) return true
  if (config.subtitle.script === 'latin') {
    return !hasSentenceEnd(normalized, config.subtitle) && compactText(normalized).length <= 55
  }
  return !hasSentenceEnd(normalized, config.subtitle) && compactText(normalized).length <= 55
}

function isContextMergeCandidate(block: EnBlock, config: LanguageProfileConfig): boolean {
  const en = block.enText.trim().replace(/\s+/g, ' ')
  if (compactText(en).length === 0) return false
  if (compactText(en).length > 55) return false
  return isContextDependentSubtitle(en, config) || endsWithTranscriptContinuation(block.jaText, config)
}

function appendAttempt(block: EnBlock, attempt: PipelineCorrectionAttemptSummary): EnBlock {
  return {
    ...block,
    correctionAttempts: [...(block.correctionAttempts ?? []), attempt].slice(-20),
  }
}

function parseDecisionWithSettings(content: string, settings: AdminSettings): MergeDecision {
  const parsed = JSON.parse(content) as {
    decision?: unknown
    subtitle_text?: unknown
    transcript_text?: unknown
    subtitleText?: unknown
    transcriptText?: unknown
    english_text?: unknown
    japanese_text?: unknown
    englishText?: unknown
    japaneseText?: unknown
    source?: unknown
    target?: unknown
    rationale?: unknown
  }
  const decision = parsed.decision
  if (decision !== 'merge_prev' && decision !== 'merge_next' && decision !== 'keep') {
    throw new Error(`invalid merge decision: ${String(decision)}`)
  }
  const explicitSubtitle = readString(parsed.subtitle_text) ?? readString(parsed.subtitleText)
  const explicitTranscript = readString(parsed.transcript_text) ?? readString(parsed.transcriptText)
  const legacyEnglish = readString(parsed.english_text) ?? readString(parsed.englishText)
  const legacyJapanese = readString(parsed.japanese_text) ?? readString(parsed.japaneseText)
  const legacySource = readString(parsed.source)
  const legacyTarget = readString(parsed.target)
  const config = loadLanguageProfileConfig(settings)
  const fallback = legacyFieldsForConfiguredLanguages(config, legacyEnglish, legacyJapanese, legacySource, legacyTarget)
  const normalized = normalizeDecisionRoles(
    explicitSubtitle ?? fallback.subtitleText,
    explicitTranscript ?? fallback.transcriptText,
    config,
  )

  return {
    decision,
    subtitleText: normalized.subtitleText,
    transcriptText: normalized.transcriptText,
    rationale: typeof parsed.rationale === 'string' ? parsed.rationale : '',
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function legacyFieldsForConfiguredLanguages(
  config: LanguageProfileConfig,
  legacyEnglish: string | undefined,
  legacyJapanese: string | undefined,
  legacySource: string | undefined,
  legacyTarget: string | undefined,
): { subtitleText: string; transcriptText: string } {
  if (config.subtitle.script === 'latin' && config.transcript.script === 'japanese') {
    return {
      subtitleText: legacyEnglish ?? legacySource ?? '',
      transcriptText: legacyJapanese ?? legacyTarget ?? '',
    }
  }
  if (config.subtitle.script === 'japanese' && config.transcript.script === 'latin') {
    return {
      subtitleText: legacyJapanese ?? legacySource ?? '',
      transcriptText: legacyEnglish ?? legacyTarget ?? '',
    }
  }
  return { subtitleText: '', transcriptText: '' }
}

function normalizeDecisionRoles(
  subtitleCandidate: string,
  transcriptCandidate: string,
  config: LanguageProfileConfig,
): { subtitleText: string; transcriptText: string } {
  const subtitleText = sanitizeMergedSubtitle(subtitleCandidate)
  const transcriptText = normalizeSpaces(transcriptCandidate)

  if (shouldSwapConfiguredRoles(subtitleText, transcriptText, config)) {
    return {
      subtitleText: sanitizeMergedSubtitle(transcriptText),
      transcriptText: normalizeSpaces(subtitleText),
    }
  }

  return { subtitleText, transcriptText }
}

function shouldSwapConfiguredRoles(subtitleText: string, transcriptText: string, config: LanguageProfileConfig): boolean {
  if (config.subtitle.script === 'latin' && config.transcript.script === 'japanese') {
    return isClearlyJapanese(subtitleText) && isClearlyEnglish(transcriptText)
  }
  if (config.subtitle.script === 'japanese' && config.transcript.script === 'latin') {
    return isClearlyEnglish(subtitleText) && isClearlyJapanese(transcriptText)
  }
  return false
}

function validateConfiguredRoles(subtitleText: string, transcriptText: string, config: LanguageProfileConfig): string | null {
  if (config.subtitle.script === 'latin' && isClearlyJapanese(subtitleText)) {
    return `context merge rejected role inversion: subtitle_text does not look like ${config.subtitle.label}`
  }
  if (config.subtitle.script === 'japanese' && isClearlyEnglish(subtitleText)) {
    return `context merge rejected role inversion: subtitle_text does not look like ${config.subtitle.label}`
  }
  if (config.transcript.script === 'latin' && isClearlyJapanese(transcriptText)) {
    return `context merge rejected role inversion: transcript_text does not look like ${config.transcript.label}`
  }
  if (config.transcript.script === 'japanese' && isClearlyEnglish(transcriptText)) {
    return `context merge rejected role inversion: transcript_text does not look like ${config.transcript.label}`
  }
  return null
}

async function decideContextMerge(
  prev: EnBlock | undefined,
  current: EnBlock,
  next: EnBlock | undefined,
  settings: AdminSettings,
): Promise<MergeDecision> {
  const apiKey = settings.openaiApiKey.trim()
  const baseUrl = (settings.openaiCompatibleBaseUrl.trim() || 'https://api.openai.com/v1').replace(/\/$/, '')
  const model = settings.contextMergeModel.trim() || settings.correctionModel || 'gpt-4.1'
  const config = loadLanguageProfileConfig(settings)

  if (!apiKey && !settings.openaiCompatibleBaseUrl.trim()) {
    throw new Error('context merge requires OpenAI API key or compatible base URL')
  }

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({
      model,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            `You are an expert subtitle editor for academic lectures. The displayed subtitle language is ${config.subtitle.label}. ` +
            `The reference transcript language is ${config.transcript.label}. ` +
            'The CURRENT subtitle may be a context-dependent fragment. Decide whether it should be merged into the previous subtitle, merged into the next subtitle, or kept separate. ' +
            'Choose keep when neither merge is semantically appropriate. Preserve technical terms, formulas, negations, conditions, and lecture flow. ' +
            'If merging, return a complete natural subtitle_text for viewers and the corresponding transcript_text for reference. ' +
            'Use subtitle_text for the displayed subtitle, and transcript_text for the reference transcript. ' +
            'Do not use source/target keys because they are ambiguous in this app. ' +
            'Do not include line breaks in subtitle_text. Keep the merged subtitle_text compact enough for two subtitle lines. ' +
            'Respond only with JSON: {"decision":"merge_prev|merge_next|keep","subtitle_text":"...","transcript_text":"...","rationale":"..."}',
        },
        {
          role: 'user',
          content: JSON.stringify({
            previous: prev ? blockForPrompt(prev) : null,
            current: blockForPrompt(current),
            next: next ? blockForPrompt(next) : null,
          }, null, 2),
        },
      ],
    }),
  })

  if (!response.ok) {
    const detail = await response.text()
    throw new Error(`context merge API returned HTTP ${response.status}: ${detail}`)
  }

  const payload = await response.json()
  const content: string = payload?.choices?.[0]?.message?.content ?? ''
  return parseDecisionWithSettings(content, settings)
}

function blockForPrompt(block: EnBlock) {
  return {
    id: block.id,
    start: block.start,
    end: block.end,
    subtitle_text: block.enText.replace(/\n/g, ' '),
    transcript_text: block.jaText,
  }
}

function mergeTextFallback(host: EnBlock, fragment: EnBlock): { subtitleText: string; transcriptText: string } {
  return {
    subtitleText: sanitizeMergedSubtitle(`${host.enText.replace(/\n/g, ' ')} ${fragment.enText.replace(/\n/g, ' ')}`),
    transcriptText: normalizeSpaces(`${host.jaText}${fragment.jaText}`),
  }
}

function sanitizeMergedSubtitle(text: string): string {
  return normalizeSpaces(text.replace(/\n+/g, ' '))
}

function countLines(text: string): number {
  return text.split('\n').filter(line => line.trim().length > 0).length
}

function gapSec(left: EnBlock, right: EnBlock): number {
  return Math.max(0, right.start - left.end)
}

function buildMergeWindow(
  host: EnBlock,
  fragment: EnBlock,
  direction: 'prev' | 'next',
): { ok: true; start: number; end: number; gap: number } | { ok: false; warning: string } {
  const gap = direction === 'prev'
    ? gapSec(host, fragment)
    : gapSec(fragment, host)

  if (gap > MAX_ABSORB_GAP_SEC) {
    return {
      ok: false,
      warning: `context merge rejected large inter-block gap: ${gap.toFixed(2)}s > ${MAX_ABSORB_GAP_SEC.toFixed(2)}s`,
    }
  }

  const start = direction === 'prev' ? host.start : fragment.start
  const end = direction === 'prev' ? fragment.end : host.end
  const duration = end - start
  if (duration > MAX_MERGED_DURATION_SEC) {
    return {
      ok: false,
      warning: `context merge rejected long merged duration: ${duration.toFixed(2)}s > ${MAX_MERGED_DURATION_SEC.toFixed(2)}s`,
    }
  }

  return { ok: true, start, end, gap }
}

function buildMergedBlock(
  host: EnBlock,
  fragment: EnBlock,
  start: number,
  end: number,
  absorbedGapSec: number,
  subtitleText: string,
  transcriptText: string,
  thresholds: PipelineThresholds,
  settings: AdminSettings,
  rationale: string,
): { ok: true; block: EnBlock } | { ok: false; warning: string } {
  const config = loadLanguageProfileConfig(settings)
  const fallback = mergeTextFallback(host, fragment)
  const normalized = normalizeDecisionRoles(
    subtitleText || fallback.subtitleText,
    transcriptText || fallback.transcriptText,
    config,
  )
  const enText = normalized.subtitleText
  const jaText = normalized.transcriptText
  if (!enText || !jaText) {
    return { ok: false, warning: 'context merge rejected empty merged text' }
  }
  const roleError = validateConfiguredRoles(enText, jaText, config)
  if (roleError) {
    return { ok: false, warning: roleError }
  }

  const rawBlock: EnBlock = {
    ...host,
    start,
    end,
    enText,
    enRaw: enText,
    jaText,
    jaChars: jaText.replace(/\s/g, '').length,
    merged: true,
  }
  const formatted = formatLines([rawBlock], thresholds)[0]
  const metrics = computeMetrics(formatted)
  const violation = classifyViolation(formatted, thresholds)
  const lineCount = countLines(formatted.enText)

  if (lineCount > 2) {
    return {
      ok: false,
      warning: `context merge rejected ${lineCount} subtitle lines after formatting`,
    }
  }

  if (metrics.cps > thresholds.verboseCps * 1.15) {
    return {
      ok: false,
      warning: `context merge rejected high CPS: ${metrics.cps.toFixed(1)} > ${(thresholds.verboseCps * 1.15).toFixed(1)}`,
    }
  }
  if (metrics.maxLineLen > thresholds.maxLineLen) {
    return {
      ok: false,
      warning: `context merge rejected long line: ${metrics.maxLineLen} > ${thresholds.maxLineLen}`,
    }
  }

  const attempt: PipelineCorrectionAttemptSummary = {
    strategy: 'merge_window',
    changed: true,
    beforeChars: fragment.enChars,
    afterChars: metrics.enChars,
    beforeViolation: fragment.violation,
    afterViolation: violation,
    rationale: `${rationale}; absorbedGapSec=${absorbedGapSec.toFixed(2)}`,
  }

  return {
    ok: true,
    block: {
      ...formatted,
      enChars: metrics.enChars,
      cps: Math.round(metrics.cps * 10) / 10,
      maxLineLen: metrics.maxLineLen,
      violation,
      correctionAttempts: [
        ...(host.correctionAttempts ?? []),
        ...(fragment.correctionAttempts ?? []),
        attempt,
      ].slice(-20),
    },
  }
}

export async function mergeContextFragments(
  blocks: EnBlock[],
  settings: AdminSettings,
  thresholds: PipelineThresholds,
  onWarning?: OnWarning,
): Promise<EnBlock[]> {
  if (!settings.openaiApiKey.trim() && !settings.openaiCompatibleBaseUrl.trim()) {
    return blocks
  }

  let attempts = 0
  const result = [...blocks]
  const languageConfig = loadLanguageProfileConfig(settings)

  for (let i = 0; i < result.length && attempts < MAX_CONTEXT_MERGE_ATTEMPTS; i += 1) {
    const current = result[i]
    if (!isContextMergeCandidate(current, languageConfig)) continue

    const prev = result[i - 1]
    const next = result[i + 1]
    if (!prev && !next) continue

    attempts += 1
    let decision: MergeDecision
    try {
      decision = await decideContextMerge(prev, current, next, settings)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      onWarning?.(String(current.id), message)
      result[i] = appendAttempt(current, {
        strategy: 'merge_window',
        changed: false,
        beforeChars: current.enChars,
        afterChars: current.enChars,
        beforeViolation: current.violation,
        afterViolation: current.violation,
        rationale: message,
      })
      continue
    }

    if (decision.decision === 'keep') {
      result[i] = appendAttempt(current, {
        strategy: 'merge_window',
        changed: false,
        beforeChars: current.enChars,
        afterChars: current.enChars,
        beforeViolation: current.violation,
        afterViolation: current.violation,
        rationale: decision.rationale || 'LLM chose keep',
      })
      continue
    }

    if (decision.decision === 'merge_prev' && prev) {
      const window = buildMergeWindow(prev, current, 'prev')
      if (!window.ok) {
        onWarning?.(String(current.id), window.warning)
        result[i] = appendAttempt(current, {
          strategy: 'merge_window',
          changed: false,
          beforeChars: current.enChars,
          afterChars: current.enChars,
          beforeViolation: current.violation,
          afterViolation: current.violation,
          rationale: window.warning,
        })
        continue
      }
      const merged = buildMergedBlock(
        prev,
        current,
        window.start,
        window.end,
        window.gap,
        decision.subtitleText,
        decision.transcriptText,
        thresholds,
        settings,
        decision.rationale || 'LLM chose merge_prev',
      )
      if (!merged.ok) {
        onWarning?.(String(current.id), merged.warning)
        result[i] = appendAttempt(current, {
          strategy: 'merge_window',
          changed: false,
          beforeChars: current.enChars,
          afterChars: current.enChars,
          beforeViolation: current.violation,
          afterViolation: current.violation,
          rationale: merged.warning,
        })
        continue
      }
      result[i - 1] = merged.block
      result.splice(i, 1)
      i = Math.max(-1, i - 2)
      continue
    }

    if (decision.decision === 'merge_next' && next) {
      const window = buildMergeWindow(next, current, 'next')
      if (!window.ok) {
        onWarning?.(String(current.id), window.warning)
        result[i] = appendAttempt(current, {
          strategy: 'merge_window',
          changed: false,
          beforeChars: current.enChars,
          afterChars: current.enChars,
          beforeViolation: current.violation,
          afterViolation: current.violation,
          rationale: window.warning,
        })
        continue
      }
      const merged = buildMergedBlock(
        next,
        current,
        window.start,
        window.end,
        window.gap,
        decision.subtitleText,
        decision.transcriptText,
        thresholds,
        settings,
        decision.rationale || 'LLM chose merge_next',
      )
      if (!merged.ok) {
        onWarning?.(String(current.id), merged.warning)
        result[i] = appendAttempt(current, {
          strategy: 'merge_window',
          changed: false,
          beforeChars: current.enChars,
          afterChars: current.enChars,
          beforeViolation: current.violation,
          afterViolation: current.violation,
          rationale: merged.warning,
        })
        continue
      }
      result[i + 1] = merged.block
      result.splice(i, 1)
      i = Math.max(-1, i - 1)
      continue
    }

    const warning = `context merge rejected unavailable neighbor for decision: ${decision.decision}`
    onWarning?.(String(current.id), warning)
    result[i] = appendAttempt(current, {
      strategy: 'merge_window',
      changed: false,
      beforeChars: current.enChars,
      afterChars: current.enChars,
      beforeViolation: current.violation,
      afterViolation: current.violation,
      rationale: warning,
    })
  }

  return result
}
