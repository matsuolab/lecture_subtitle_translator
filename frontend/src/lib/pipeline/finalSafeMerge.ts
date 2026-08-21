import type { PipelineCorrectionAttemptSummary } from '@/types/pipeline'
import { DEFAULT_PIPELINE_THRESHOLDS, type EnBlock, type PipelineThresholds, type ViolationCode } from './blockTypes'
import { reindexContextGroups } from './contextGrouping'
import { formatLines } from './formatLines'
import { classifyViolation, computeMetrics } from './metrics'
import { joinSubtitleParts, unwrapSubtitleLines } from './textUtils'
import { mergeCueSourceRefs } from '@/types/sourceEvidence'

export interface FinalSafeMergeEntry {
  leftId: number
  rightId: number
  contextGroupId?: string
  status: 'merged' | 'rejected'
  reason: string
  beforeDurationSec: number
  afterDurationSec: number
  beforeLineCount: number
  afterLineCount: number
  beforeViolation: ViolationCode[]
  afterViolation?: ViolationCode
}

export interface FinalSafeMergeResult {
  blocks: EnBlock[]
  initialBlocks: number
  finalBlocks: number
  mergedCount: number
  rejectedCount: number
  entries: FinalSafeMergeEntry[]
}

const MAX_FINAL_SAFE_GAP_SEC = 0.45

function finiteOrDefault(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback
}

function normalizeThresholds(thresholds: PipelineThresholds): PipelineThresholds {
  return {
    // 数値以外のフィールド（言語 script など）は素通しする。
    // 列挙し忘れると結合・行分割の言語作法が黙って既定へ落ちるため、先にスプレッドする。
    ...thresholds,
    shortDurationSec: finiteOrDefault(thresholds.shortDurationSec, DEFAULT_PIPELINE_THRESHOLDS.shortDurationSec),
    longDurationSec: finiteOrDefault(thresholds.longDurationSec, DEFAULT_PIPELINE_THRESHOLDS.longDurationSec),
    mergedLongDurationSec: finiteOrDefault(thresholds.mergedLongDurationSec, DEFAULT_PIPELINE_THRESHOLDS.mergedLongDurationSec),
    overCompressedRatio: finiteOrDefault(thresholds.overCompressedRatio, DEFAULT_PIPELINE_THRESHOLDS.overCompressedRatio),
    overCompressedJaChars: finiteOrDefault(thresholds.overCompressedJaChars, DEFAULT_PIPELINE_THRESHOLDS.overCompressedJaChars),
    verboseCps: finiteOrDefault(thresholds.verboseCps, DEFAULT_PIPELINE_THRESHOLDS.verboseCps),
    maxLineLen: finiteOrDefault(thresholds.maxLineLen, DEFAULT_PIPELINE_THRESHOLDS.maxLineLen),
    slowCps: finiteOrDefault(thresholds.slowCps, DEFAULT_PIPELINE_THRESHOLDS.slowCps),
    maxExpandPerBlock: finiteOrDefault(thresholds.maxExpandPerBlock, DEFAULT_PIPELINE_THRESHOLDS.maxExpandPerBlock),
    maxCompressPerBlock: finiteOrDefault(thresholds.maxCompressPerBlock, DEFAULT_PIPELINE_THRESHOLDS.maxCompressPerBlock),
  }
}

function gapSec(left: EnBlock, right: EnBlock): number {
  return right.start - left.end
}

function lineCount(text: string): number {
  return text.split('\n').filter(line => line.trim().length > 0).length
}

function compactLength(text: string): number {
  return text.replace(/\s/g, '').length
}

function sameContextGroup(left: EnBlock, right: EnBlock): boolean {
  return Boolean(left.contextGroupId && right.contextGroupId && left.contextGroupId === right.contextGroupId)
}

function mergeCandidateText(
  left: EnBlock,
  right: EnBlock,
  thresholds: PipelineThresholds,
): { enText: string; jaText: string } {
  const subtitleScript = thresholds.subtitleScript ?? 'latin'
  const transcriptScript = thresholds.transcriptScript ?? 'latin'
  return {
    enText: joinSubtitleParts(
      [unwrapSubtitleLines(left.enText, subtitleScript), unwrapSubtitleLines(right.enText, subtitleScript)],
      subtitleScript,
    ),
    jaText: joinSubtitleParts([left.jaText, right.jaText], transcriptScript),
  }
}

function sourceIdsFor(block: EnBlock): number[] {
  return block.contextGroupSourceIds && block.contextGroupSourceIds.length > 0
    ? block.contextGroupSourceIds
    : [block.id]
}

function rejectionEntry(left: EnBlock, right: EnBlock, reason: string): FinalSafeMergeEntry {
  return {
    leftId: left.id,
    rightId: right.id,
    contextGroupId: left.contextGroupId,
    status: 'rejected',
    reason,
    beforeDurationSec: Math.max(left.end - left.start, right.end - right.start),
    afterDurationSec: right.end - left.start,
    beforeLineCount: lineCount(left.enText) + lineCount(right.enText),
    afterLineCount: 0,
    beforeViolation: [left.violation, right.violation],
  }
}

function appendFinalSafeMergeAttempt(
  block: EnBlock,
  pair: EnBlock,
  changed: boolean,
  after: EnBlock | undefined,
  rationale: string,
  thresholds: PipelineThresholds,
): PipelineCorrectionAttemptSummary[] {
  const before = mergeCandidateText(block, pair, thresholds)
  const attempt: PipelineCorrectionAttemptSummary = {
    strategy: 'final_safe_merge',
    changed,
    beforeChars: block.enChars + pair.enChars,
    afterChars: after?.enChars ?? block.enChars + pair.enChars,
    beforeViolation: `${block.violation},${pair.violation}`,
    afterViolation: after?.violation ?? block.violation,
    beforeTranscriptText: before.jaText,
    beforeSubtitleText: before.enText,
    afterTranscriptText: after?.jaText,
    afterSubtitleText: after?.enText,
    rationale,
  }
  return [
    ...(block.correctionAttempts ?? []),
    ...(pair.correctionAttempts ?? []),
    attempt,
  ].slice(-20)
}

function buildMergedBlock(left: EnBlock, right: EnBlock, thresholds: PipelineThresholds): { block?: EnBlock; reason?: string } {
  if (!sameContextGroup(left, right)) {
    return { reason: 'different contextGroupId' }
  }
  if ((left.contextGroupSize ?? 1) <= 1 || (right.contextGroupSize ?? 1) <= 1) {
    return { reason: 'singleton context group' }
  }
  if (left.alignConf !== 'exact' || right.alignConf !== 'exact') {
    return { reason: `non-exact timing (${left.alignConf}, ${right.alignConf})` }
  }
  const mergeableExistingViolations: ViolationCode[] = ['ok', 'slow_speech', 'cps_over', 'line_length_only', 'short_duration']
  if (![left.violation, right.violation].every(v => mergeableExistingViolations.includes(v))) {
    return { reason: `existing violation (${left.violation}, ${right.violation})` }
  }

  const gap = gapSec(left, right)
  if (gap < 0) return { reason: `overlapping timing gap ${gap.toFixed(2)}s` }
  if (gap > MAX_FINAL_SAFE_GAP_SEC) {
    return { reason: `gap ${gap.toFixed(2)}s > ${MAX_FINAL_SAFE_GAP_SEC.toFixed(2)}s` }
  }

  const duration = right.end - left.start
  if (duration > thresholds.mergedLongDurationSec) {
    return { reason: `duration ${duration.toFixed(2)}s > ${thresholds.mergedLongDurationSec.toFixed(2)}s` }
  }

  const mergedText = mergeCandidateText(left, right, thresholds)
  const sourceRefs = mergeCueSourceRefs(left.sourceRefs, right.sourceRefs)
  const expectedJaLength = compactLength(left.jaText) + compactLength(right.jaText)
  if (compactLength(mergedText.jaText) < expectedJaLength) {
    return { reason: 'transcript coverage would shrink' }
  }

  const draft: EnBlock = {
    ...left,
    end: right.end,
    jaText: mergedText.jaText,
    jaChars: compactLength(mergedText.jaText),
    enText: mergedText.enText,
    enRaw: mergedText.enText,
    enTextOriginal: undefined,
    merged: true,
    contextGroupSourceIds: [...new Set([...sourceIdsFor(left), ...sourceIdsFor(right)])],
    ...(sourceRefs ? { sourceRefs } : {}),
  }
  const formatted = formatLines([draft], thresholds)[0]
  const metrics = computeMetrics(formatted)
  const violation = classifyViolation(formatted, thresholds)
  const lines = lineCount(formatted.enText)

  if (lines > 2) return { reason: `${lines} lines after formatting` }
  if (metrics.maxLineLen > thresholds.maxLineLen) {
    return { reason: `line length ${metrics.maxLineLen} > ${thresholds.maxLineLen}` }
  }
  if (metrics.cps > thresholds.verboseCps) {
    return { reason: `CPS ${metrics.cps.toFixed(1)} > ${thresholds.verboseCps.toFixed(1)}` }
  }
  // 従来 verbose_en は enJaRatio でも立っていたため、結合後に行長超過になったブロックも
  // verbose_en として許可されていた。line_length_only を許可に加えないと、この変更で
  // 結合が従来より厳しくなりキュー数が変わってしまう。CPS 超過は直前の176行で別途拒否している。
  if (
    violation !== 'ok' && violation !== 'slow_speech'
    && violation !== 'cps_over' && violation !== 'line_length_only'
  ) {
    return { reason: `new violation ${violation}` }
  }

  const block: EnBlock = {
    ...formatted,
    enChars: metrics.enChars,
    cps: Math.round(metrics.cps * 10) / 10,
    maxLineLen: metrics.maxLineLen,
    violation,
    correctionAttempts: appendFinalSafeMergeAttempt(
      left,
      right,
      true,
      formatted,
      `deterministic same-context final merge; gapSec=${gap.toFixed(2)}`,
      thresholds,
    ),
  }
  return { block }
}

export function finalSafeMerge(blocks: EnBlock[], thresholds: PipelineThresholds): FinalSafeMergeResult {
  const safeThresholds = normalizeThresholds(thresholds)
  const result = [...blocks]
  const entries: FinalSafeMergeEntry[] = []
  let mergedCount = 0
  let rejectedCount = 0

  for (let i = 0; i < result.length - 1; i += 1) {
    const left = result[i]
    const right = result[i + 1]
    if (!sameContextGroup(left, right)) continue

    const beforeLineCount = lineCount(left.enText) + lineCount(right.enText)
    const merged = buildMergedBlock(left, right, safeThresholds)
    if (!merged.block) {
      rejectedCount += 1
      entries.push(rejectionEntry(left, right, merged.reason ?? 'unknown rejection'))
      continue
    }

    entries.push({
      leftId: left.id,
      rightId: right.id,
      contextGroupId: left.contextGroupId,
      status: 'merged',
      reason: 'same contextGroupId and display constraints preserved',
      beforeDurationSec: Math.max(left.end - left.start, right.end - right.start),
      afterDurationSec: merged.block.end - merged.block.start,
      beforeLineCount,
      afterLineCount: lineCount(merged.block.enText),
      beforeViolation: [left.violation, right.violation],
      afterViolation: merged.block.violation,
    })
    result[i] = merged.block
    result.splice(i + 1, 1)
    mergedCount += 1
    i = Math.max(-1, i - 1)
  }

  return {
    blocks: reindexContextGroups(result) as EnBlock[],
    initialBlocks: blocks.length,
    finalBlocks: result.length,
    mergedCount,
    rejectedCount,
    entries,
  }
}
