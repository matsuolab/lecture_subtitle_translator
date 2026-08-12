import type { EnBlock, PipelineThresholds } from './blockTypes'
import { countCpsChars } from '../subtitleMetrics'
import { normalizeSpaces } from './textUtils'

const MAX_GAP_SEC = 0.6
const HARD_MAX_DURATION_SEC = 7.0
const MIN_DURATION_SEC = 1.0
const CPS_MARGIN = 0.5

interface SplitChoice {
  leftText: string
  rightText: string
  score: number
  naturalBoundary: boolean
}

interface VirtualSplitCandidate {
  leftText: string
  rightText: string
  leftEnd: number
  rightStart: number
  leftDuration: number
  rightDuration: number
  leftCps: number
  rightCps: number
}

export interface SplitEvenlyObservation {
  leftId: number
  rightId: number
  strategy: 'split_evenly'
  beforeCps: [number, number]
  beforeDuration: [number, number]
  candidateCps: [number, number]
  candidateDuration: [number, number]
  boundaryShiftSec: number
  candidateLeftText: string
  candidateRightText: string
}

export interface SplitEvenlyDiagnostics {
  consideredPairCount: number
  candidateCount: number
  observations: SplitEvenlyObservation[]
}

function durationSec(block: EnBlock): number {
  return Math.max(0.001, block.end - block.start)
}

function gapSec(left: EnBlock, right: EnBlock): number {
  return right.start - left.end
}

function awkwardMaxDuration(chars: number): number {
  return Math.min(HARD_MAX_DURATION_SEC, Math.max(1.5, chars * 0.25 + 1.0))
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
    if (!left || !right || left.length > maxLineLen || right.length > maxLineLen) continue

    const balance = Math.abs(countCpsChars(left) - countCpsChars(right))
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
    if (badGlue) score += 50

    const choice = {
      leftText: left,
      rightText: right,
      score,
      naturalBoundary: endsSentence || endsClause || startsConn,
    }
    if (!best || choice.score < best.score) best = choice
  }
  return best
}

function buildVirtualSplit(
  left: EnBlock,
  right: EnBlock,
  thresholds: PipelineThresholds,
): VirtualSplitCandidate | null {
  const combined = normalizeSpaces(`${left.enText.replace(/\n/g, ' ')} ${right.enText.replace(/\n/g, ' ')}`)
  const gap = gapSec(left, right)
  const innerSpan = right.end - left.start - gap
  if (innerSpan <= 0) return null

  const choice = findBestSplit(combined, thresholds.maxLineLen)
  if (!choice || (!choice.naturalBoundary && endsWithGlueWord(choice.leftText))) return null

  const leftChars = countCpsChars(choice.leftText)
  const rightChars = countCpsChars(choice.rightText)
  const totalChars = leftChars + rightChars
  if (totalChars === 0) return null

  const leftDuration = innerSpan * (leftChars / totalChars)
  const rightDuration = innerSpan - leftDuration
  if (leftDuration < MIN_DURATION_SEC || rightDuration < MIN_DURATION_SEC) return null
  if (leftDuration > HARD_MAX_DURATION_SEC || rightDuration > HARD_MAX_DURATION_SEC) return null

  const targetCps = thresholds.verboseCps - CPS_MARGIN
  const leftCps = leftChars / leftDuration
  const rightCps = rightChars / rightDuration
  if (leftCps > targetCps || rightCps > targetCps) return null
  if (leftDuration > awkwardMaxDuration(leftChars) || rightDuration > awkwardMaxDuration(rightChars)) return null

  const leftEnd = left.start + leftDuration
  return {
    leftText: choice.leftText,
    rightText: choice.rightText,
    leftEnd,
    rightStart: leftEnd + gap,
    leftDuration,
    rightDuration,
    leftCps,
    rightCps,
  }
}

function hasCpsIssue(left: EnBlock, right: EnBlock, thresholds: PipelineThresholds): boolean {
  return countCpsChars(left.enText) / durationSec(left) > thresholds.verboseCps
    || countCpsChars(right.enText) / durationSec(right) > thresholds.verboseCps
}

function round(value: number, digits = 3): number {
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}

/**
 * 旧 `split_evenly` mutation が生成していた仮想候補だけを観測する。
 * block 配列を返さず、repair・Editor badge・後段分岐には接続しない。
 */
export function analyzeSplitEvenlyCandidates(
  blocks: readonly EnBlock[],
  thresholds: PipelineThresholds,
): SplitEvenlyDiagnostics {
  const observations: SplitEvenlyObservation[] = []
  let consideredPairCount = 0

  for (let index = 0; index < blocks.length - 1; index += 1) {
    const left = blocks[index]
    const right = blocks[index + 1]
    if (!hasCpsIssue(left, right, thresholds)) continue
    consideredPairCount += 1
    const gap = gapSec(left, right)
    if (gap < 0 || gap > MAX_GAP_SEC) continue

    const candidate = buildVirtualSplit(left, right, thresholds)
    if (!candidate) continue
    observations.push({
      leftId: left.id,
      rightId: right.id,
      strategy: 'split_evenly',
      beforeCps: [round(left.cps, 1), round(right.cps, 1)],
      beforeDuration: [round(durationSec(left)), round(durationSec(right))],
      candidateCps: [round(candidate.leftCps, 1), round(candidate.rightCps, 1)],
      candidateDuration: [round(candidate.leftDuration), round(candidate.rightDuration)],
      boundaryShiftSec: round(candidate.leftEnd - left.end),
      candidateLeftText: candidate.leftText,
      candidateRightText: candidate.rightText,
    })
  }

  return {
    consideredPairCount,
    candidateCount: observations.length,
    observations,
  }
}
