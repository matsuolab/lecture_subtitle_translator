import type { PipelineCorrectionAttemptSummary } from '@/types/pipeline'
import {
  DEFAULT_PIPELINE_THRESHOLDS,
  type EnBlock,
  type PipelineThresholds,
  type ViolationCode,
} from './blockTypes'
import { classifyViolation, computeMetrics } from './metrics'
import { countCpsChars } from '../subtitleMetrics'
import { joinSubtitleParts, unwrapSubtitleLines } from './textUtils'

export type CpsReliefStrategy = 'retime_only' | 'split_evenly'
export type CpsReliefStatus = 'applied' | 'skipped'

export interface CpsReliefEntry {
  leftId: number
  rightId: number
  strategy: CpsReliefStrategy | 'none'
  status: CpsReliefStatus
  reason: string
  beforeCps: [number, number]
  afterCps?: [number, number]
  beforeDuration: [number, number]
  afterDuration?: [number, number]
}

export interface CpsReliefResult {
  blocks: EnBlock[]
  initialBlocks: number
  finalBlocks: number
  appliedCount: number
  skippedCount: number
  entries: CpsReliefEntry[]
}

const MAX_GAP_SEC = 0.6
const HARD_MAX_DURATION_SEC = 7.0
const MIN_DURATION_SEC = 1.0
const CPS_MARGIN = 0.5

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

function durationSec(block: EnBlock): number {
  return Math.max(0.001, block.end - block.start)
}

function gapSec(left: EnBlock, right: EnBlock): number {
  return right.start - left.end
}

/**
 * 短いテキストを長時間表示するのは UX 上 awkward (BBC/Netflix subtitle guidelines).
 * 文字数に応じて許容できる最大表示時間の目安を返す。
 */
function awkwardMaxDuration(chars: number): number {
  return Math.min(HARD_MAX_DURATION_SEC, Math.max(1.5, chars * 0.25 + 1.0))
}

function rebuildBlock(
  base: EnBlock,
  newStart: number,
  newEnd: number,
  newEnText: string,
  thresholds: PipelineThresholds,
  rationale: string,
  beforeForAttempt: { enText: string; jaText: string; violation: ViolationCode },
): EnBlock {
  const draft: EnBlock = {
    ...base,
    start: newStart,
    end: newEnd,
    enText: newEnText,
    enRaw: newEnText,
    // 決定的に時間を再配分したことを明示。これにより classifyViolation の
    // proportional_ts 早期 return を回避し、実 CPS で再分類される。
    alignConf: 'merged',
  }
  const metrics = computeMetrics(draft)
  const violation = classifyViolation(draft, thresholds)
  const attempt: PipelineCorrectionAttemptSummary = {
    strategy: 'cps_relief_rebalance',
    changed: true,
    beforeChars: countCpsChars(beforeForAttempt.enText),
    afterChars: metrics.enChars,
    beforeViolation: beforeForAttempt.violation,
    afterViolation: violation,
    beforeTranscriptText: beforeForAttempt.jaText,
    beforeSubtitleText: beforeForAttempt.enText,
    afterTranscriptText: draft.jaText,
    afterSubtitleText: draft.enText,
    rationale,
  }
  return {
    ...draft,
    enChars: metrics.enChars,
    cps: Math.round(metrics.cps * 10) / 10,
    maxLineLen: metrics.maxLineLen,
    violation,
    correctionAttempts: [...(base.correctionAttempts ?? []), attempt].slice(-20),
  }
}

interface PairCandidate {
  newLeftStart: number
  newLeftEnd: number
  newRightStart: number
  newRightEnd: number
  newLeftText: string
  newRightText: string
}

function tryRetimeOnly(left: EnBlock, right: EnBlock, thresholds: PipelineThresholds): PairCandidate | null {
  const lChars = countCpsChars(left.enText)
  const rChars = countCpsChars(right.enText)
  if (lChars === 0 || rChars === 0) return null

  const gap = gapSec(left, right)
  const targetCps = thresholds.verboseCps - CPS_MARGIN
  if (targetCps <= 0) return null

  const totalEnvelopeStart = left.start
  const totalEnvelopeEnd = right.end
  const innerSpan = totalEnvelopeEnd - totalEnvelopeStart - gap // sum of left and right durations
  if (innerSpan <= 0) return null

  // 必要 duration: 各 cue がしきい値以下の CPS を満たす最小 duration
  const lMinNeeded = lChars / targetCps
  const rMinNeeded = rChars / targetCps

  if (lMinNeeded + rMinNeeded > innerSpan) {
    // 物理的に両方をしきい値以下にできない → A では不可
    return null
  }

  // 現状の boundary を起点に、不足側へ最小限だけ寄せる
  const currentLDur = durationSec(left)
  const currentRDur = durationSec(right)
  let newLDur = currentLDur
  let newRDur = currentRDur

  if (currentLDur < lMinNeeded) {
    // left を伸ばす（足りない分を right から借りる）
    const need = lMinNeeded - currentLDur
    const canBorrow = currentRDur - rMinNeeded
    if (canBorrow < need) return null
    newLDur = lMinNeeded
    newRDur = currentRDur - need
  } else if (currentRDur < rMinNeeded) {
    // right を伸ばす（足りない分を left から借りる）
    const need = rMinNeeded - currentRDur
    const canBorrow = currentLDur - lMinNeeded
    if (canBorrow < need) return null
    newRDur = rMinNeeded
    newLDur = currentLDur - need
  } else {
    // どちらも既に余裕あり — A 不要
    return null
  }

  if (newLDur < MIN_DURATION_SEC || newRDur < MIN_DURATION_SEC) return null
  if (newLDur > HARD_MAX_DURATION_SEC || newRDur > HARD_MAX_DURATION_SEC) return null

  // 短文・長表示の awkward 判定
  if (newLDur > awkwardMaxDuration(lChars)) return null
  if (newRDur > awkwardMaxDuration(rChars)) return null

  const newLeftEnd = totalEnvelopeStart + newLDur
  const newRightStart = newLeftEnd + gap
  return {
    newLeftStart: totalEnvelopeStart,
    newLeftEnd,
    newRightStart,
    newRightEnd: totalEnvelopeEnd,
    newLeftText: left.enText,
    newRightText: right.enText,
  }
}

interface SplitChoice {
  leftText: string
  rightText: string
  score: number
  naturalBoundary: boolean
}

function endsWithGlueWord(text: string): boolean {
  return /\b(of|and|or|the|a|an|to|with|for|in|on|at|by|as|its)$/i.test(text.replace(/[,.;:!?]$/, '').trim())
}

function startsWithConnector(text: string): boolean {
  return /^(so|but|and|or|because|then|which|that|when|where|if|while|though|although)\b/i.test(text)
}

function findBestSplit(combined: string, maxLineLen: number): SplitChoice | null {
  let best: SplitChoice | null = null
  for (let i = 1; i < combined.length - 1; i += 1) {
    if (combined[i] !== ' ') continue
    const left = combined.slice(0, i).trim()
    const right = combined.slice(i + 1).trim()
    if (!left || !right) continue
    if (left.length > maxLineLen || right.length > maxLineLen) continue

    const lChars = countCpsChars(left)
    const rChars = countCpsChars(right)
    const balance = Math.abs(lChars - rChars)

    const endsSentence = /[.!?]$/.test(left)
    const endsClause = /[,;:]$/.test(left)
    const startsConn = startsWithConnector(right)
    const startsCapital = /^[A-Z]/.test(right)
    const badGlue = endsWithGlueWord(left)

    let score = balance
    if (endsSentence) score -= 30
    else if (endsClause) score -= 15
    if (startsConn) score -= 8
    if (startsCapital) score -= 3
    if (badGlue) score += 50 // hard penalty: never split on glue words

    const naturalBoundary = endsSentence || endsClause || startsConn

    if (!best || score < best.score) {
      best = { leftText: left, rightText: right, score, naturalBoundary }
    }
  }
  return best
}

function trySplitEvenly(left: EnBlock, right: EnBlock, thresholds: PipelineThresholds): PairCandidate | null {
  const subtitleScript = thresholds.subtitleScript ?? 'latin'
  const combined = joinSubtitleParts(
    [unwrapSubtitleLines(left.enText, subtitleScript), unwrapSubtitleLines(right.enText, subtitleScript)],
    subtitleScript,
  )
  const totalDur = right.end - left.start
  const gap = gapSec(left, right)
  if (totalDur <= 0) return null

  const choice = findBestSplit(combined, thresholds.maxLineLen)
  if (!choice) return null
  // glue 語境界しか見つからなかった場合は採用しない（不自然なカットを避ける）
  if (!choice.naturalBoundary && endsWithGlueWord(choice.leftText)) return null

  const lChars = countCpsChars(choice.leftText)
  const rChars = countCpsChars(choice.rightText)
  const totalChars = lChars + rChars
  if (totalChars === 0) return null

  // 文字数比例で時間配分（gap は維持）
  const innerSpan = totalDur - gap
  if (innerSpan <= 0) return null
  const lDur = innerSpan * (lChars / totalChars)
  const rDur = innerSpan - lDur

  if (lDur < MIN_DURATION_SEC || rDur < MIN_DURATION_SEC) return null
  if (lDur > HARD_MAX_DURATION_SEC || rDur > HARD_MAX_DURATION_SEC) return null

  const targetCps = thresholds.verboseCps - CPS_MARGIN
  if (lChars / lDur > targetCps) return null
  if (rChars / rDur > targetCps) return null

  // どちらかが awkward (短文長表示) になる場合は不採用
  if (lDur > awkwardMaxDuration(lChars)) return null
  if (rDur > awkwardMaxDuration(rChars)) return null

  const newLeftEnd = left.start + lDur
  const newRightStart = newLeftEnd + gap
  return {
    newLeftStart: left.start,
    newLeftEnd,
    newRightStart,
    newRightEnd: right.end,
    newLeftText: choice.leftText,
    newRightText: choice.rightText,
  }
}

function shouldConsiderPair(left: EnBlock, right: EnBlock, thresholds: PipelineThresholds): boolean {
  const lDur = durationSec(left)
  const rDur = durationSec(right)
  const lCps = countCpsChars(left.enText) / lDur
  const rCps = countCpsChars(right.enText) / rDur
  // どちらかが CPS 超過 or proportional_ts かつ CPS が閾値近辺
  const overThreshold = thresholds.verboseCps
  const hasCpsIssue = lCps > overThreshold || rCps > overThreshold
  return hasCpsIssue
}

export function cpsReliefRebalance(blocks: EnBlock[], thresholds: PipelineThresholds): CpsReliefResult {
  const safeThresholds = normalizeThresholds(thresholds)
  const result: EnBlock[] = [...blocks]
  const entries: CpsReliefEntry[] = []
  let appliedCount = 0
  let skippedCount = 0

  for (let i = 0; i < result.length - 1; i += 1) {
    const left = result[i]
    const right = result[i + 1]
    if (!shouldConsiderPair(left, right, safeThresholds)) continue

    const gap = gapSec(left, right)
    if (gap < 0 || gap > MAX_GAP_SEC) {
      skippedCount += 1
      entries.push({
        leftId: left.id,
        rightId: right.id,
        strategy: 'none',
        status: 'skipped',
        reason: `gap ${gap.toFixed(2)}s outside [0, ${MAX_GAP_SEC.toFixed(2)}s]`,
        beforeCps: [left.cps, right.cps],
        beforeDuration: [durationSec(left), durationSec(right)],
      })
      continue
    }

    const candidateA = tryRetimeOnly(left, right, safeThresholds)
    if (candidateA) {
      applyCandidate(result, i, left, right, candidateA, 'retime_only', safeThresholds, entries)
      appliedCount += 1
      continue
    }

    const candidateC = trySplitEvenly(left, right, safeThresholds)
    if (candidateC) {
      applyCandidate(result, i, left, right, candidateC, 'split_evenly', safeThresholds, entries)
      appliedCount += 1
      continue
    }

    skippedCount += 1
    entries.push({
      leftId: left.id,
      rightId: right.id,
      strategy: 'none',
      status: 'skipped',
      reason: 'no feasible retime-only rebalance',
      beforeCps: [left.cps, right.cps],
      beforeDuration: [durationSec(left), durationSec(right)],
    })
  }

  return {
    blocks: result,
    initialBlocks: blocks.length,
    finalBlocks: result.length,
    appliedCount,
    skippedCount,
    entries,
  }
}

function applyCandidate(
  result: EnBlock[],
  index: number,
  left: EnBlock,
  right: EnBlock,
  candidate: PairCandidate,
  strategy: CpsReliefStrategy,
  thresholds: PipelineThresholds,
  entries: CpsReliefEntry[],
): void {
  const rationale = `deterministic CPS-relief retime; gap preserved at ${gapSec(left, right).toFixed(2)}s`
  const newLeft = rebuildBlock(
    left,
    candidate.newLeftStart,
    candidate.newLeftEnd,
    candidate.newLeftText,
    thresholds,
    rationale,
    { enText: left.enText, jaText: left.jaText, violation: left.violation },
  )
  const newRight = rebuildBlock(
    right,
    candidate.newRightStart,
    candidate.newRightEnd,
    candidate.newRightText,
    thresholds,
    rationale,
    { enText: right.enText, jaText: right.jaText, violation: right.violation },
  )
  result[index] = newLeft
  result[index + 1] = newRight
  entries.push({
    leftId: left.id,
    rightId: right.id,
    strategy,
    status: 'applied',
    reason: rationale,
    beforeCps: [left.cps, right.cps],
    afterCps: [newLeft.cps, newRight.cps],
    beforeDuration: [durationSec(left), durationSec(right)],
    afterDuration: [durationSec(newLeft), durationSec(newRight)],
  })
}
