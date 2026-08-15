import { alignCuesToAsr, buildAsrCharStream, type AlignedSpan } from './asrAlignment'
import type { TranscriptSegment } from './types'

export interface SplitTimingCue {
  id: number
  start: number
  end: number
  transcriptText: string
}

export interface SplitTimingGroup {
  sourceBlockId: number
  cueIds: number[]
}

export interface SplitTimingDriftInput {
  transcriptSegments: readonly TranscriptSegment[]
  /**
   * splitGroupsから参照されるcueを渡す。同じstageの全cueを渡しても、各groupの親時間区間
   * 周辺だけをアライメント対象にするため、離れた反復表現へ誤対応しない。
   */
  cues: readonly SplitTimingCue[]
  splitGroups: readonly SplitTimingGroup[]
}

export interface SplitTimingBoundaryMeasurement {
  sourceBlockId: number
  leftCueId: number
  rightCueId: number
  assignedLeftEndSec: number
  assignedRightStartSec: number
  assignedBoundarySec: number
  spokenLeftEndSec: number | null
  spokenRightStartSec: number | null
  spokenBoundarySec: number | null
  leftEndDeltaSec: number | null
  rightStartDeltaSec: number | null
  deltaSec: number | null
  absDeltaSec: number | null
  resolvable: boolean
  leftConfidence: AlignedSpan['confidence']
  rightConfidence: AlignedSpan['confidence']
  leftMatchRate: number
  rightMatchRate: number
}

export interface SplitTimingDriftReport {
  groupCount: number
  boundaryCount: number
  resolvableBoundaryCount: number
  overThresholdSec: {
    '0.3': number
    '0.5': number
    '1': number
  }
  boundaries: SplitTimingBoundaryMeasurement[]
}

export interface SplitTimingPolicyCueInput {
  id: number
  start: number
  end: number
  enChars: number
}

export interface SplitTimingPolicyInput {
  cues: readonly SplitTimingPolicyCueInput[]
  spokenBoundarySec: readonly number[]
  spokenBoundaryEdges?: readonly { leftEndSec: number; rightStartSec: number }[]
  gapSec: number
  maxClosableGapSec?: number
  minDurationSec: number
  maxCps: number
}

export interface SplitTimingPolicyCueResult {
  id: number
  start: number
  end: number
  duration: number
  cps: number
}

export interface SplitTimingPolicySummary {
  cues: SplitTimingPolicyCueResult[]
  maxBoundaryAbsDeltaSec: number | null
  cpsViolationCount: number
  minDurationViolationCount: number
}

export interface SplitTimingPolicyComparison {
  feasible: boolean
  current: SplitTimingPolicySummary
  speechAnchored: SplitTimingPolicySummary
  constrained: SplitTimingPolicySummary
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000
}

function isResolved(span: AlignedSpan): boolean {
  return span.confidence !== 'interpolated'
}

function buildPolicySummary(
  cues: readonly SplitTimingPolicyCueInput[],
  spans: readonly { start: number; end: number }[],
  spokenEdges: readonly { leftEndSec: number; rightStartSec: number }[],
  minDurationSec: number,
  maxCps: number,
): SplitTimingPolicySummary {
  const results = spans.map((span, index): SplitTimingPolicyCueResult => {
    const duration = Math.max(0, span.end - span.start)
    return {
      id: cues[index].id,
      start: round3(span.start),
      end: round3(span.end),
      duration: round3(duration),
      cps: round3(cues[index].enChars / Math.max(0.001, duration)),
    }
  })
  const boundaryDeltas = spokenEdges.map((spoken, index) => {
    const leftDelta = Math.abs(results[index].end - spoken.leftEndSec)
    const rightDelta = Math.abs(results[index + 1].start - spoken.rightStartSec)
    return Math.max(leftDelta, rightDelta)
  })
  return {
    cues: results,
    maxBoundaryAbsDeltaSec: boundaryDeltas.length > 0 ? round3(Math.max(...boundaryDeltas)) : null,
    cpsViolationCount: results.filter(cue => cue.cps > maxCps + 0.001).length,
    minDurationViolationCount: results.filter(cue => cue.duration < minDurationSec - 0.001).length,
  }
}

function spansFromBoundaries(
  outerStart: number,
  outerEnd: number,
  boundaries: readonly number[],
  gaps: readonly number[],
): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = []
  let start = outerStart
  for (let index = 0; index < boundaries.length; index += 1) {
    const boundary = boundaries[index]
    const gap = gaps[index]
    const end = boundary - gap / 2
    spans.push({ start, end })
    start = boundary + gap / 2
  }
  spans.push({ start, end: outerEnd })
  return spans
}

/**
 * split後の本文を変えず、内部境界だけについて現行・ASR直採用・表示制約付きASRを比較する。
 * constrainedは親cueの外側を固定し、ASR境界に最も近い位置をCPS/最低表示時間の実行可能域へ投影する。
 */
export function compareSplitTimingPolicies(input: SplitTimingPolicyInput): SplitTimingPolicyComparison {
  const cues = [...input.cues]
  if (cues.length === 0 || input.spokenBoundarySec.length !== cues.length - 1) {
    throw new Error('spokenBoundarySec must contain exactly cues.length - 1 boundaries')
  }
  if (input.maxCps <= 0 || input.minDurationSec < 0 || input.gapSec < 0) {
    throw new Error('timing constraints must be non-negative and maxCps must be positive')
  }
  if (cues.some((cue, index) => cue.enChars < 0 || cue.end < cue.start || (index > 0 && cue.start < cues[index - 1].start))) {
    throw new Error('cues must be valid and ordered by start time')
  }
  const outerStart = cues[0].start
  const outerEnd = cues[cues.length - 1].end
  const spokenEdges = input.spokenBoundaryEdges ?? input.spokenBoundarySec.map(boundary => ({
    leftEndSec: boundary,
    rightStartSec: boundary,
  }))
  if (spokenEdges.length !== input.spokenBoundarySec.length) {
    throw new Error('spokenBoundaryEdges must contain exactly cues.length - 1 boundaries')
  }
  if (spokenEdges.some((edge, index) =>
    edge.rightStartSec < edge.leftEndSec
    || (index > 0 && edge.leftEndSec < spokenEdges[index - 1].rightStartSec)
  )) {
    throw new Error('spokenBoundaryEdges must be monotonic and non-overlapping')
  }
  const maxClosableGapSec = input.maxClosableGapSec ?? 0.5
  const constrainedGaps = spokenEdges.map(edge => {
    const spokenGap = Math.max(0, edge.rightStartSec - edge.leftEndSec)
    return spokenGap > maxClosableGapSec ? Math.max(input.gapSec, spokenGap) : input.gapSec
  })
  const targetBoundaryCenters = spokenEdges.map((edge, index) => {
    const spokenGap = Math.max(0, edge.rightStartSec - edge.leftEndSec)
    // closeSubtitleGapsは短いgapでは次cueのstartを動かさず、前cueのendだけを延長する。
    // 発話gapが0でも表示上の80ms gapは維持するため、左cueは発話終端より80ms早く消える。
    // これは誤差ではなく既存の字幕間gap制約であり、spokenRangesとdisplayRangesを分けて記録する。
    if (spokenGap <= maxClosableGapSec) return edge.rightStartSec - constrainedGaps[index] / 2
    return (edge.leftEndSec + edge.rightStartSec) / 2
  })
  const currentSpans = cues.map(cue => ({ start: cue.start, end: cue.end }))
  const speechSpans = spansFromBoundaries(outerStart, outerEnd, targetBoundaryCenters, constrainedGaps)
  const current = buildPolicySummary(cues, currentSpans, spokenEdges, input.minDurationSec, input.maxCps)
  const speechAnchored = buildPolicySummary(cues, speechSpans, spokenEdges, input.minDurationSec, input.maxCps)

  const availableDuration = outerEnd - outerStart - constrainedGaps.reduce((sum, gap) => sum + gap, 0)
  // 最終SRTは1ms単位なので、数学上ちょうどCPS上限でも小数msを切り捨てると
  // 実出力で上限超過になる。必要尺は1ms単位で安全側へ切り上げ、投影前に
  // 「実際に出力可能か」を判定する。
  const requiredDurations = cues.map(cue => Math.ceil(
    Math.max(input.minDurationSec, cue.enChars / input.maxCps) * 1000,
  ) / 1000)
  if (requiredDurations.reduce((sum, duration) => sum + duration, 0) > availableDuration + 0.001) {
    return {
      feasible: false,
      current,
      speechAnchored,
      constrained: {
        cues: [],
        maxBoundaryAbsDeltaSec: null,
        cpsViolationCount: 0,
        minDurationViolationCount: 0,
      },
    }
  }

  const cumulativeDurations: number[] = []
  let previous = 0
  for (let index = 0; index < input.spokenBoundarySec.length; index += 1) {
    const lower = requiredDurations.slice(0, index + 1).reduce((sum, duration) => sum + duration, 0)
    const remainingRequired = requiredDurations.slice(index + 1).reduce((sum, duration) => sum + duration, 0)
    const upper = availableDuration - remainingRequired
    const previousGapDuration = constrainedGaps.slice(0, index).reduce((sum, gap) => sum + gap, 0)
    const desired = targetBoundaryCenters[index] - constrainedGaps[index] / 2 - outerStart - previousGapDuration
    const cumulative = Math.min(upper, Math.max(lower, previous + requiredDurations[index], desired))
    cumulativeDurations.push(cumulative)
    previous = cumulative
  }
  const constrainedBoundaries = cumulativeDurations.map((cumulative, index) =>
    outerStart + cumulative + constrainedGaps.slice(0, index).reduce((sum, gap) => sum + gap, 0) + constrainedGaps[index] / 2,
  )
  const constrainedSpans = spansFromBoundaries(outerStart, outerEnd, constrainedBoundaries, constrainedGaps)

  return {
    feasible: true,
    current,
    speechAnchored,
    constrained: buildPolicySummary(
      cues,
      constrainedSpans,
      spokenEdges,
      input.minDurationSec,
      input.maxCps,
    ),
  }
}

const ASR_WINDOW_MARGIN_SEC = 1

/**
 * 現行のsplit cue時刻を変更せず、WhisperX単語時刻へ再アラインした境界との差だけを返す。
 */
export function measureSplitTimingDrift(input: SplitTimingDriftInput): SplitTimingDriftReport {
  const cueById = new Map(input.cues.map(cue => [cue.id, cue]))
  const asr = buildAsrCharStream(input.transcriptSegments, { script: 'japanese' })

  const boundaries: SplitTimingBoundaryMeasurement[] = []
  for (const group of input.splitGroups) {
    const groupCues = group.cueIds
      .map(cueId => cueById.get(cueId))
      .filter((cue): cue is SplitTimingCue => cue !== undefined)
      .sort((left, right) => left.start - right.start || left.id - right.id)
    if (groupCues.length < 2) continue
    const groupStart = Math.min(...groupCues.map(cue => cue.start)) - ASR_WINDOW_MARGIN_SEC
    const groupEnd = Math.max(...groupCues.map(cue => cue.end)) + ASR_WINDOW_MARGIN_SEC
    const localAsr = asr.filter(char => char.end >= groupStart && char.start <= groupEnd)
    const aligned = alignCuesToAsr(
      groupCues.map(cue => cue.transcriptText),
      localAsr,
      { script: 'japanese' },
    )

    for (let index = 0; index < groupCues.length - 1; index += 1) {
      const leftCue = groupCues[index]
      const rightCue = groupCues[index + 1]
      const leftCueId = leftCue.id
      const rightCueId = rightCue.id
      const leftSpan = aligned[index]
      const rightSpan = aligned[index + 1]
      const assignedLeftEndSec = round3(leftCue.end)
      const assignedRightStartSec = round3(rightCue.start)
      const assignedBoundarySec = round3((assignedLeftEndSec + assignedRightStartSec) / 2)
      const resolvable = isResolved(leftSpan) && isResolved(rightSpan)
      const spokenLeftEndSec = resolvable ? round3(leftSpan.endSec) : null
      const spokenRightStartSec = resolvable ? round3(rightSpan.startSec) : null
      const spokenBoundarySec = resolvable
        ? round3((leftSpan.endSec + rightSpan.startSec) / 2)
        : null
      const deltaSec = spokenBoundarySec === null
        ? null
        : round3(assignedBoundarySec - spokenBoundarySec)

      boundaries.push({
        sourceBlockId: group.sourceBlockId,
        leftCueId,
        rightCueId,
        assignedLeftEndSec,
        assignedRightStartSec,
        assignedBoundarySec,
        spokenLeftEndSec,
        spokenRightStartSec,
        spokenBoundarySec,
        leftEndDeltaSec: spokenLeftEndSec === null ? null : round3(assignedLeftEndSec - spokenLeftEndSec),
        rightStartDeltaSec: spokenRightStartSec === null ? null : round3(assignedRightStartSec - spokenRightStartSec),
        deltaSec,
        absDeltaSec: deltaSec === null ? null : round3(Math.abs(deltaSec)),
        resolvable,
        leftConfidence: leftSpan.confidence,
        rightConfidence: rightSpan.confidence,
        leftMatchRate: round3(leftSpan.matchRate),
        rightMatchRate: round3(rightSpan.matchRate),
      })
    }
  }

  const resolvedDeltas = boundaries
    .map(boundary => boundary.absDeltaSec)
    .filter((value): value is number => value !== null)

  return {
    groupCount: input.splitGroups.length,
    boundaryCount: boundaries.length,
    resolvableBoundaryCount: resolvedDeltas.length,
    overThresholdSec: {
      '0.3': resolvedDeltas.filter(delta => delta > 0.3).length,
      '0.5': resolvedDeltas.filter(delta => delta > 0.5).length,
      '1': resolvedDeltas.filter(delta => delta > 1).length,
    },
    boundaries,
  }
}
