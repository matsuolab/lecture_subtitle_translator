import type { EnBlock, JaBlock, PipelineThresholds } from './blockTypes'
import { countCpsChars } from '../subtitleMetrics'

export interface FragmentationDiagnosticEntry {
  id: number
  durationSec: number
  textChars: number
  cps?: number
  maxLineLen?: number
  gapToNextSec?: number
  flags: string[]
  splitCandidate?: boolean
  splitCandidateReason?: string
  mergeCandidateWithNext?: boolean
  mergeCandidateReason?: string
}

export interface FragmentationDiagnostics {
  stage: string
  blockCount: number
  totalDurationSec: number
  cuesPerMinute: number
  avgDurationSec: number
  medianDurationSec: number
  p10DurationSec: number
  p90DurationSec: number
  under1SecCount: number
  underShortDurationCount: number
  underShortDurationRate: number
  avgTextChars: number
  medianTextChars: number
  sentenceIncompleteEndCount: number
  sentenceIncompleteEndRate: number
  glueEndCount: number
  glueEndRate: number
  splitCandidateCount: number
  mergeCandidatePairCount: number
  constraintFeasibleMergePairCount: number
  avgGapSec: number
  entries: FragmentationDiagnosticEntry[]
}

type DiagnosticBlock = Pick<JaBlock, 'id' | 'start' | 'end' | 'jaText'> &
  Partial<Pick<JaBlock, 'alignConf' | 'contextGroupId' | 'contextGroupSize'>> &
  Partial<Pick<EnBlock, 'enText' | 'cps' | 'maxLineLen' | 'violation'>>

function round(value: number, digits = 3): number {
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}

function durationSec(block: Pick<DiagnosticBlock, 'start' | 'end'>): number {
  return Math.max(0.001, block.end - block.start)
}

function displayText(block: DiagnosticBlock): string {
  return (block.enText ?? block.jaText ?? '').trim()
}

function compactTextChars(text: string): number {
  return countCpsChars(text.replace(/\n/g, ' '))
}

function quantile(values: number[], q: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * q)))
  return sorted[index]
}

function avg(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0
}

function hasSentenceEnd(text: string): boolean {
  return /[.!?。！？）」』】\]]\s*$/.test(text.trim())
}

function endsWithGlueWord(text: string): boolean {
  const normalized = text.replace(/\n/g, ' ').replace(/[,.;:!?。！？、，]$/, '').trim()
  return /\b(of|and|or|the|a|an|to|with|for|in|on|at|by|as|if|that|which|because|while)$/i.test(normalized) ||
    /(?:の|が|を|に|へ|で|と|から|まで|より|という|として|なので|ため|場合|また|そして)$/.test(normalized)
}

function lineLengths(text: string): number[] {
  const lines = text.split('\n').filter(line => line.trim().length > 0)
  return lines.length ? lines.map(line => line.length) : [text.length]
}

function maxLineLen(text: string): number {
  return Math.max(0, ...lineLengths(text))
}

function gapSec(left: DiagnosticBlock, right: DiagnosticBlock): number {
  return right.start - left.end
}

function isMergeCandidateReason(left: DiagnosticBlock, right: DiagnosticBlock, thresholds: PipelineThresholds): string | undefined {
  const gap = gapSec(left, right)
  if (gap < 0 || gap > 0.8) return undefined
  const leftText = displayText(left)
  const leftDuration = durationSec(left)
  const rightDuration = durationSec(right)
  const leftFragment = !hasSentenceEnd(leftText) || endsWithGlueWord(leftText)
  const rightFragment = rightDuration < thresholds.shortDurationSec
  const leftShort = leftDuration < thresholds.shortDurationSec
  if (!leftShort && !rightFragment && !leftFragment) return undefined
  return [
    leftShort ? 'left_short_duration' : '',
    rightFragment ? 'right_short_duration' : '',
    leftFragment ? 'left_incomplete_or_glue_end' : '',
  ].filter(Boolean).join(',')
}

function isConstraintFeasibleMerge(left: DiagnosticBlock, right: DiagnosticBlock, thresholds: PipelineThresholds): boolean {
  const combinedDuration = right.end - left.start
  if (combinedDuration > thresholds.mergedLongDurationSec) return false
  const combinedText = `${displayText(left).replace(/\n/g, ' ')} ${displayText(right).replace(/\n/g, ' ')}`.trim()
  const chars = compactTextChars(combinedText)
  if (chars / Math.max(0.001, combinedDuration) > thresholds.verboseCps) return false
  return maxLineLen(combinedText) <= thresholds.maxLineLen * 2
}

function splitCandidateReason(block: DiagnosticBlock, thresholds: PipelineThresholds): string | undefined {
  const text = displayText(block)
  const duration = durationSec(block)
  const chars = compactTextChars(text)
  const cps = chars / duration
  const reasons = [
    duration > thresholds.mergedLongDurationSec ? 'duration_over_merged_long_limit' : '',
    duration > thresholds.longDurationSec ? 'duration_over_long_limit' : '',
    cps > thresholds.verboseCps ? 'cps_over_limit' : '',
    maxLineLen(text) > thresholds.maxLineLen ? 'line_over_limit' : '',
    chars > thresholds.maxLineLen * 2 ? 'text_over_two_line_budget' : '',
  ].filter(Boolean)
  return reasons.length ? reasons.join(',') : undefined
}

export function analyzeFragmentation(
  blocks: DiagnosticBlock[],
  thresholds: PipelineThresholds,
  stage: string,
): FragmentationDiagnostics {
  const durations = blocks.map(durationSec)
  const texts = blocks.map(displayText)
  const textChars = texts.map(compactTextChars)
  const gaps = blocks.slice(0, -1).map((block, index) => Math.max(0, gapSec(block, blocks[index + 1])))
  const totalDuration = blocks.length
    ? Math.max(0.001, blocks[blocks.length - 1].end - blocks[0].start)
    : 0

  let mergeCandidatePairCount = 0
  let constraintFeasibleMergePairCount = 0
  let splitCandidateCount = 0
  const entries: FragmentationDiagnosticEntry[] = blocks.map((block, index) => {
    const text = texts[index]
    const duration = durations[index]
    const chars = textChars[index]
    const flags: string[] = []
    if (duration < 1.0) flags.push('under_1_sec')
    if (duration < thresholds.shortDurationSec) flags.push('under_short_duration')
    if (!hasSentenceEnd(text)) flags.push('sentence_incomplete_end')
    if (endsWithGlueWord(text)) flags.push('glue_end')
    if (block.alignConf === 'proportional' || block.alignConf === 'no_words') flags.push('uncertain_timing')
    if (block.violation && block.violation !== 'ok' && block.violation !== 'slow_speech') flags.push(`violation:${block.violation}`)

    const next = blocks[index + 1]
    const reason = next ? isMergeCandidateReason(block, next, thresholds) : undefined
    const feasible = Boolean(reason && next && isConstraintFeasibleMerge(block, next, thresholds))
    const splitReason = splitCandidateReason(block, thresholds)
    if (reason) mergeCandidatePairCount += 1
    if (feasible) constraintFeasibleMergePairCount += 1
    if (splitReason) splitCandidateCount += 1

    return {
      id: block.id,
      durationSec: round(duration),
      textChars: chars,
      cps: block.enText ? round(chars / duration, 1) : undefined,
      maxLineLen: block.enText ? maxLineLen(block.enText) : undefined,
      gapToNextSec: next ? round(gapSec(block, next)) : undefined,
      flags,
      splitCandidate: Boolean(splitReason),
      splitCandidateReason: splitReason,
      mergeCandidateWithNext: Boolean(reason),
      mergeCandidateReason: reason,
    }
  })

  const underShort = durations.filter(duration => duration < thresholds.shortDurationSec).length
  const incomplete = texts.filter(text => !hasSentenceEnd(text)).length
  const glue = texts.filter(endsWithGlueWord).length

  return {
    stage,
    blockCount: blocks.length,
    totalDurationSec: round(totalDuration),
    cuesPerMinute: round(blocks.length / Math.max(totalDuration / 60, 0.001), 2),
    avgDurationSec: round(avg(durations)),
    medianDurationSec: round(quantile(durations, 0.5)),
    p10DurationSec: round(quantile(durations, 0.1)),
    p90DurationSec: round(quantile(durations, 0.9)),
    under1SecCount: durations.filter(duration => duration < 1.0).length,
    underShortDurationCount: underShort,
    underShortDurationRate: round(blocks.length ? underShort / blocks.length : 0, 4),
    avgTextChars: round(avg(textChars), 1),
    medianTextChars: round(quantile(textChars, 0.5), 1),
    sentenceIncompleteEndCount: incomplete,
    sentenceIncompleteEndRate: round(blocks.length ? incomplete / blocks.length : 0, 4),
    glueEndCount: glue,
    glueEndRate: round(blocks.length ? glue / blocks.length : 0, 4),
    splitCandidateCount,
    mergeCandidatePairCount,
    constraintFeasibleMergePairCount,
    avgGapSec: round(avg(gaps)),
    entries,
  }
}
