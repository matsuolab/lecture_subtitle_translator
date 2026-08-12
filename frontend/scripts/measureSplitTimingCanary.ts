/**
 * 保存済みProject JSONに埋め込まれたWhisperX wordsとcorrectionEngine snapshotから、
 * 成功したsplit_blockの現行境界と発話根拠境界の差を非破壊で集計する。
 *
 * 実行:
 *   cd frontend
 *   npx tsx scripts/measureSplitTimingCanary.ts <project.json> [--whisperx raw.json] [--out report.json]
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import {
  compareSplitTimingPolicies,
  measureSplitTimingDrift,
  type SplitTimingBoundaryMeasurement,
  type SplitTimingCue,
  type SplitTimingGroup,
} from '../src/lib/pipeline/splitTimingDiagnostics'
import { countCpsChars } from '../src/lib/subtitleMetrics'
import type { TranscriptSegment } from '../src/lib/pipeline/types'

interface CorrectionAttemptSnapshot {
  strategy?: string
  changed?: boolean
  beforeTranscriptText?: string
  afterTranscriptText?: string
}

interface CorrectionEngineItem extends SplitTimingCue {
  subtitleText?: string
  correctionAttempts?: CorrectionAttemptSnapshot[]
}

interface StageSnapshot {
  stage?: string
  items?: CorrectionEngineItem[]
}

interface LegacyProjectWithDebug {
  stageSnapshots?: StageSnapshot[]
  settings?: { enMaxCps?: number; subtitleMinDurationSec?: number }
  session?: {
    adminSettings?: { enMaxCps?: number; subtitleMinDurationSec?: number }
    pipelineRun?: {
      debug?: {
        settingsSnapshot?: { enMaxCps?: number; subtitleMinDurationSec?: number }
        transcriptSegments?: TranscriptSegment[]
        stageSnapshots?: StageSnapshot[]
      }
    }
  }
}

interface ExternalTranscriptSegment extends TranscriptSegment {
  ja?: string
  ja_corrected?: string
}

interface DistributionSummary {
  p50: number | null
  p90: number | null
  p95: number | null
  max: number | null
}

interface CanaryReport {
  sourcePath: string
  transcriptSegmentCount: number
  transcriptWordCount: number
  correctionCueCount: number
  splitGroupCount: number
  boundaryCount: number
  resolvableBoundaryCount: number
  unresolvableBoundaryCount: number
  absBoundaryDeltaSec: DistributionSummary
  overThresholdSec: { '0.3': number; '0.5': number; '1': number }
  exactBoundaryCount: number
  partialBoundaryCount: number
  exactAbsBoundaryDeltaSec: DistributionSummary
  exactOverThresholdSec: { '0.3': number; '0.5': number; '1': number }
  rightCueStartsBeforeSpeechSec: { '0.3': number; '0.5': number; '1': number }
  rightCueStartsAfterSpeechSec: { '0.3': number; '0.5': number; '1': number }
  exactRightCueStartsBeforeSpeechSec: { '0.3': number; '0.5': number; '1': number }
  exactRightCueStartsAfterSpeechSec: { '0.3': number; '0.5': number; '1': number }
  policyAb: {
    maxCps: number
    minDurationSec: number
    gapSec: number
    comparableGroupCount: number
    exactComparableGroupCount: number
    autoEligibleGroupCount: number
    fallbackGroupCount: number
    infeasibleGroupCount: number
    current: PolicyAggregate
    speechAnchored: PolicyAggregate
    constrained: PolicyAggregate
    exactCurrent: PolicyAggregate
    exactSpeechAnchored: PolicyAggregate
    exactConstrained: PolicyAggregate
    eligibleCurrent: PolicyAggregate
    eligibleConstrained: PolicyAggregate
    guarded: PolicyAggregate
    constrainedVsCurrent: PolicyOutcomeAggregate
    exactConstrainedVsCurrent: PolicyOutcomeAggregate
    eligibleConstrainedVsCurrent: PolicyOutcomeAggregate
    guardedVsCurrent: PolicyOutcomeAggregate
    eligibleCurrentRightStartAbsDeltaSec: DistributionSummary
    eligibleConstrainedRightStartAbsDeltaSec: DistributionSummary
    eligibleCurrentRightStartOverThresholdSec: { '0.3': number; '0.5': number; '1': number }
    eligibleConstrainedRightStartOverThresholdSec: { '0.3': number; '0.5': number; '1': number }
    spokenSilenceBoundaryCount: number
    exactSpokenSilenceBoundaryCount: number
  }
  guardedWorsenedBoundaries: PolicyBoundaryOutcome[]
  worstBoundaries: SplitTimingBoundaryMeasurement[]
}

interface PolicyBoundaryOutcome {
  sourceBlockId: number
  leftCueId: number
  rightCueId: number
  spokenGapSec: number
  currentAbsDeltaSec: number
  constrainedAbsDeltaSec: number
  currentLeftEndAbsDeltaSec: number
  currentRightStartAbsDeltaSec: number
  constrainedLeftEndAbsDeltaSec: number
  constrainedRightStartAbsDeltaSec: number
  currentRightStartDeltaSec: number
  constrainedRightStartDeltaSec: number
  worseningSec: number
}

interface PolicyAggregate {
  groupCount: number
  cueCount: number
  cpsViolationCount: number
  minDurationViolationCount: number
  boundaryAbsDeltaSec: DistributionSummary
  boundaryAbsDeltasSec: number[]
  overBoundaryThresholdSec: { '0.3': number; '0.5': number; '1': number }
}

interface PolicyOutcomeAggregate {
  improvedBoundaryCount: number
  unchangedBoundaryCount: number
  worsenedBoundaryCount: number
  maxImprovementSec: number | null
  maxWorseningSec: number | null
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf-8')) as T
}

function successfulSplitSignature(item: CorrectionEngineItem): string | null {
  const split = item.correctionAttempts?.find(attempt =>
    attempt.strategy === 'split_block' && attempt.changed === true,
  )
  if (!split) return null
  return `${split.beforeTranscriptText ?? ''}\u0000${split.afterTranscriptText ?? ''}`
}

function extractSplitGroups(items: readonly CorrectionEngineItem[]): SplitTimingGroup[] {
  const itemById = new Map(items.map(item => [item.id, item]))
  const signatureById = new Map(items.map(item => [item.id, successfulSplitSignature(item)]))
  const groups: SplitTimingGroup[] = []

  for (const parent of items) {
    const signature = signatureById.get(parent.id)
    if (!signature) continue
    const children = items.filter(item => {
      if (item.id < 1000 || Math.floor(item.id / 1000) !== parent.id || item.id % 1000 < 2) return false
      return signatureById.get(item.id) === signature
    })
    if (children.length === 0) continue

    const cueIds = [parent, ...children]
      .filter(item => itemById.has(item.id))
      .sort((left, right) => left.start - right.start || left.id - right.id)
      .map(item => item.id)
    groups.push({ sourceBlockId: parent.id, cueIds })
  }

  return groups
}

function percentile(sorted: readonly number[], ratio: number): number | null {
  if (sorted.length === 0) return null
  const index = Math.max(0, Math.ceil(sorted.length * ratio) - 1)
  return sorted[index]
}

function summarizeDistribution(values: readonly number[]): DistributionSummary {
  const sorted = [...values].sort((left, right) => left - right)
  return {
    p50: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.9),
    p95: percentile(sorted, 0.95),
    max: sorted.at(-1) ?? null,
  }
}

function countThresholds(values: readonly number[]): { '0.3': number; '0.5': number; '1': number } {
  return {
    '0.3': values.filter(value => value > 0.3).length,
    '0.5': values.filter(value => value > 0.5).length,
    '1': values.filter(value => value > 1).length,
  }
}

function emptyPolicyAggregate(): PolicyAggregate {
  return {
    groupCount: 0,
    cueCount: 0,
    cpsViolationCount: 0,
    minDurationViolationCount: 0,
    boundaryAbsDeltaSec: summarizeDistribution([]),
    boundaryAbsDeltasSec: [],
    overBoundaryThresholdSec: countThresholds([]),
  }
}

function aggregatePolicies(
  entries: readonly {
    cueCount: number
    cpsViolationCount: number
    minDurationViolationCount: number
    boundaryDeltas: number[]
  }[],
): PolicyAggregate {
  const boundaryDeltas = entries.flatMap(entry => entry.boundaryDeltas)
  return {
    groupCount: entries.length,
    cueCount: entries.reduce((sum, entry) => sum + entry.cueCount, 0),
    cpsViolationCount: entries.reduce((sum, entry) => sum + entry.cpsViolationCount, 0),
    minDurationViolationCount: entries.reduce((sum, entry) => sum + entry.minDurationViolationCount, 0),
    boundaryAbsDeltaSec: summarizeDistribution(boundaryDeltas),
    boundaryAbsDeltasSec: boundaryDeltas.map(value => Math.round(value * 1000) / 1000),
    overBoundaryThresholdSec: countThresholds(boundaryDeltas),
  }
}

function aggregatePolicyOutcomes(
  entries: readonly { current: { boundaryDeltas: number[] }; constrained: { boundaryDeltas: number[] } }[],
): PolicyOutcomeAggregate {
  const changes = entries.flatMap(entry => entry.current.boundaryDeltas.map((current, index) =>
    current - entry.constrained.boundaryDeltas[index],
  ))
  const epsilon = 0.001
  const improvements = changes.filter(change => change > epsilon)
  const worsenings = changes.filter(change => change < -epsilon).map(change => -change)
  return {
    improvedBoundaryCount: improvements.length,
    unchangedBoundaryCount: changes.filter(change => Math.abs(change) <= epsilon).length,
    worsenedBoundaryCount: worsenings.length,
    maxImprovementSec: improvements.length > 0 ? Math.round(Math.max(...improvements) * 1000) / 1000 : null,
    maxWorseningSec: worsenings.length > 0 ? Math.round(Math.max(...worsenings) * 1000) / 1000 : null,
  }
}

function countDirectionalDeltas(
  boundaries: readonly SplitTimingBoundaryMeasurement[],
  direction: 'before' | 'after',
): { '0.3': number; '0.5': number; '1': number } {
  const deltas = boundaries
    .map(boundary => boundary.rightStartDeltaSec)
    .filter((value): value is number => value !== null)
    .map(value => direction === 'before' ? -value : value)
  return {
    '0.3': deltas.filter(value => value > 0.3).length,
    '0.5': deltas.filter(value => value > 0.5).length,
    '1': deltas.filter(value => value > 1).length,
  }
}

function loadExternalTranscriptSegments(path: string): TranscriptSegment[] {
  const raw = readJson<ExternalTranscriptSegment[] | { segments: ExternalTranscriptSegment[] }>(path)
  const segments = Array.isArray(raw) ? raw : raw.segments
  return segments.map((segment, index) => ({
    id: segment.id ?? index + 1,
    start: segment.start,
    end: segment.end,
    text: segment.text || segment.ja_corrected || segment.ja || '',
    words: segment.words,
  }))
}

function buildReport(
  projectPath: string,
  project: LegacyProjectWithDebug,
  externalTranscriptSegments?: readonly TranscriptSegment[],
): CanaryReport {
  const debug = project.session?.pipelineRun?.debug
  const transcriptSegments = externalTranscriptSegments ?? debug?.transcriptSegments
  if (!transcriptSegments?.length) {
    throw new Error('session.pipelineRun.debug.transcriptSegments がありません')
  }
  const stageSnapshots = debug?.stageSnapshots ?? project.stageSnapshots
  const correctionStage = stageSnapshots?.find(snapshot => snapshot.stage === 'correctionEngine')
  if (!correctionStage?.items?.length) {
    throw new Error('correctionEngine stage snapshot がありません')
  }

  const cues = correctionStage.items.map(item => ({
    id: item.id,
    start: item.start,
    end: item.end,
    transcriptText: item.transcriptText ?? '',
  }))
  const splitGroups = extractSplitGroups(correctionStage.items)
  const measurement = measureSplitTimingDrift({ transcriptSegments, cues, splitGroups })
  const resolved = measurement.boundaries.filter(boundary => boundary.resolvable)
  const absDeltas = resolved
    .map(boundary => boundary.absDeltaSec)
    .filter((value): value is number => value !== null)
  const exact = resolved.filter(boundary =>
    boundary.leftConfidence === 'exact' && boundary.rightConfidence === 'exact',
  )
  const exactAbsDeltas = exact
    .map(boundary => boundary.absDeltaSec)
    .filter((value): value is number => value !== null)
  const settings = debug?.settingsSnapshot ?? project.session?.adminSettings ?? project.settings ?? {}
  const maxCps = typeof settings.enMaxCps === 'number' && settings.enMaxCps > 0 ? settings.enMaxCps : 17
  const minDurationSec = typeof settings.subtitleMinDurationSec === 'number' && settings.subtitleMinDurationSec > 0
    ? Math.max(1.5, settings.subtitleMinDurationSec)
    : 1.5
  const gapSec = 0.08
  const itemById = new Map(correctionStage.items.map(item => [item.id, item]))
  const boundaryBySource = new Map<number, SplitTimingBoundaryMeasurement[]>()
  for (const boundary of measurement.boundaries) {
    const list = boundaryBySource.get(boundary.sourceBlockId) ?? []
    list.push(boundary)
    boundaryBySource.set(boundary.sourceBlockId, list)
  }
  const policyEntries: Array<{
    exact: boolean
    autoEligible: boolean
    spokenSilenceBoundaryCount: number
    current: { cueCount: number; cpsViolationCount: number; minDurationViolationCount: number; boundaryDeltas: number[] }
    speechAnchored: { cueCount: number; cpsViolationCount: number; minDurationViolationCount: number; boundaryDeltas: number[] }
    constrained: { cueCount: number; cpsViolationCount: number; minDurationViolationCount: number; boundaryDeltas: number[] }
  }> = []
  const policyBoundaryOutcomes: PolicyBoundaryOutcome[] = []
  let infeasibleGroupCount = 0
  for (const group of splitGroups) {
    const boundaries = boundaryBySource.get(group.sourceBlockId) ?? []
    if (boundaries.length !== group.cueIds.length - 1 || boundaries.some(boundary => !boundary.resolvable)) continue
    const groupItems = group.cueIds
      .map(id => itemById.get(id))
      .filter((item): item is CorrectionEngineItem => item !== undefined)
      .sort((left, right) => left.start - right.start || left.id - right.id)
    if (groupItems.length !== group.cueIds.length) continue
    const spokenBoundaries = boundaries.map(boundary => boundary.spokenBoundarySec as number)
    const spokenBoundaryEdges = boundaries.map(boundary => ({
      leftEndSec: boundary.spokenLeftEndSec as number,
      rightStartSec: boundary.spokenRightStartSec as number,
    }))
    const comparison = compareSplitTimingPolicies({
      cues: groupItems.map(item => ({
        id: item.id,
        start: item.start,
        end: item.end,
        enChars: countCpsChars(item.subtitleText ?? ''),
      })),
      spokenBoundarySec: spokenBoundaries,
      spokenBoundaryEdges,
      gapSec,
      maxClosableGapSec: 0.5,
      minDurationSec,
      maxCps,
    })
    const toEntry = (summary: typeof comparison.current) => ({
      cueCount: summary.cues.length,
      cpsViolationCount: summary.cpsViolationCount,
      minDurationViolationCount: summary.minDurationViolationCount,
      boundaryDeltas: summary.cues.slice(0, -1).map((cue, index) => {
        const leftDelta = Math.abs(cue.end - spokenBoundaryEdges[index].leftEndSec)
        const rightDelta = Math.abs(summary.cues[index + 1].start - spokenBoundaryEdges[index].rightStartSec)
        return Math.max(leftDelta, rightDelta)
      }),
    })
    const exact = boundaries.every(boundary =>
        boundary.leftConfidence === 'exact' && boundary.rightConfidence === 'exact',
    )
    const autoEligible = comparison.feasible && exact && boundaries.every(boundary =>
      boundary.leftMatchRate >= 0.8 && boundary.rightMatchRate >= 0.8,
    )
    if (!comparison.feasible) infeasibleGroupCount += 1
    const currentEntry = toEntry(comparison.current)
    const constrainedEntry = comparison.feasible ? toEntry(comparison.constrained) : currentEntry
    if (autoEligible) {
      boundaries.forEach((boundary, index) => {
        const currentAbsDeltaSec = currentEntry.boundaryDeltas[index]
        const constrainedAbsDeltaSec = constrainedEntry.boundaryDeltas[index]
        const currentLeftEndAbsDeltaSec = Math.abs(comparison.current.cues[index].end - spokenBoundaryEdges[index].leftEndSec)
        const currentRightStartAbsDeltaSec = Math.abs(comparison.current.cues[index + 1].start - spokenBoundaryEdges[index].rightStartSec)
        const constrainedLeftEndAbsDeltaSec = Math.abs(comparison.constrained.cues[index].end - spokenBoundaryEdges[index].leftEndSec)
        const constrainedRightStartAbsDeltaSec = Math.abs(comparison.constrained.cues[index + 1].start - spokenBoundaryEdges[index].rightStartSec)
        const currentRightStartDeltaSec = comparison.current.cues[index + 1].start - spokenBoundaryEdges[index].rightStartSec
        const constrainedRightStartDeltaSec = comparison.constrained.cues[index + 1].start - spokenBoundaryEdges[index].rightStartSec
        policyBoundaryOutcomes.push({
          sourceBlockId: group.sourceBlockId,
          leftCueId: boundary.leftCueId,
          rightCueId: boundary.rightCueId,
          spokenGapSec: Math.round((spokenBoundaryEdges[index].rightStartSec - spokenBoundaryEdges[index].leftEndSec) * 1000) / 1000,
          currentAbsDeltaSec: Math.round(currentAbsDeltaSec * 1000) / 1000,
          constrainedAbsDeltaSec: Math.round(constrainedAbsDeltaSec * 1000) / 1000,
          currentLeftEndAbsDeltaSec: Math.round(currentLeftEndAbsDeltaSec * 1000) / 1000,
          currentRightStartAbsDeltaSec: Math.round(currentRightStartAbsDeltaSec * 1000) / 1000,
          constrainedLeftEndAbsDeltaSec: Math.round(constrainedLeftEndAbsDeltaSec * 1000) / 1000,
          constrainedRightStartAbsDeltaSec: Math.round(constrainedRightStartAbsDeltaSec * 1000) / 1000,
          currentRightStartDeltaSec: Math.round(currentRightStartDeltaSec * 1000) / 1000,
          constrainedRightStartDeltaSec: Math.round(constrainedRightStartDeltaSec * 1000) / 1000,
          worseningSec: Math.round((constrainedAbsDeltaSec - currentAbsDeltaSec) * 1000) / 1000,
        })
      })
    }
    policyEntries.push({
      exact,
      autoEligible,
      spokenSilenceBoundaryCount: spokenBoundaryEdges.filter(edge =>
        edge.rightStartSec - edge.leftEndSec > 0.5,
      ).length,
      current: currentEntry,
      speechAnchored: toEntry(comparison.speechAnchored),
      constrained: constrainedEntry,
    })
  }
  const exactPolicyEntries = policyEntries.filter(entry => entry.exact)
  const autoEligiblePolicyEntries = policyEntries.filter(entry => entry.autoEligible)
  const guardedPolicyEntries = policyEntries.map(entry => ({
    ...entry,
    constrained: entry.autoEligible ? entry.constrained : entry.current,
  }))
  const spokenSilenceBoundaryCount = policyEntries.reduce((sum, entry) =>
    sum + entry.spokenSilenceBoundaryCount,
  0)
  const exactSpokenSilenceBoundaryCount = exactPolicyEntries.reduce((sum, entry) =>
    sum + entry.spokenSilenceBoundaryCount,
  0)

  return {
    sourcePath: resolve(projectPath),
    transcriptSegmentCount: transcriptSegments.length,
    transcriptWordCount: transcriptSegments.reduce((sum, segment) => sum + (segment.words?.length ?? 0), 0),
    correctionCueCount: cues.length,
    splitGroupCount: measurement.groupCount,
    boundaryCount: measurement.boundaryCount,
    resolvableBoundaryCount: measurement.resolvableBoundaryCount,
    unresolvableBoundaryCount: measurement.boundaryCount - measurement.resolvableBoundaryCount,
    absBoundaryDeltaSec: summarizeDistribution(absDeltas),
    overThresholdSec: measurement.overThresholdSec,
    exactBoundaryCount: exact.length,
    partialBoundaryCount: resolved.length - exact.length,
    exactAbsBoundaryDeltaSec: summarizeDistribution(exactAbsDeltas),
    exactOverThresholdSec: countThresholds(exactAbsDeltas),
    rightCueStartsBeforeSpeechSec: countDirectionalDeltas(resolved, 'before'),
    rightCueStartsAfterSpeechSec: countDirectionalDeltas(resolved, 'after'),
    exactRightCueStartsBeforeSpeechSec: countDirectionalDeltas(exact, 'before'),
    exactRightCueStartsAfterSpeechSec: countDirectionalDeltas(exact, 'after'),
    policyAb: {
      maxCps,
      minDurationSec,
      gapSec,
      comparableGroupCount: policyEntries.length,
      exactComparableGroupCount: exactPolicyEntries.length,
      autoEligibleGroupCount: autoEligiblePolicyEntries.length,
      fallbackGroupCount: policyEntries.length - autoEligiblePolicyEntries.length,
      infeasibleGroupCount,
      current: policyEntries.length > 0 ? aggregatePolicies(policyEntries.map(entry => entry.current)) : emptyPolicyAggregate(),
      speechAnchored: policyEntries.length > 0 ? aggregatePolicies(policyEntries.map(entry => entry.speechAnchored)) : emptyPolicyAggregate(),
      constrained: policyEntries.length > 0 ? aggregatePolicies(policyEntries.map(entry => entry.constrained)) : emptyPolicyAggregate(),
      exactCurrent: exactPolicyEntries.length > 0 ? aggregatePolicies(exactPolicyEntries.map(entry => entry.current)) : emptyPolicyAggregate(),
      exactSpeechAnchored: exactPolicyEntries.length > 0 ? aggregatePolicies(exactPolicyEntries.map(entry => entry.speechAnchored)) : emptyPolicyAggregate(),
      exactConstrained: exactPolicyEntries.length > 0 ? aggregatePolicies(exactPolicyEntries.map(entry => entry.constrained)) : emptyPolicyAggregate(),
      eligibleCurrent: aggregatePolicies(autoEligiblePolicyEntries.map(entry => entry.current)),
      eligibleConstrained: aggregatePolicies(autoEligiblePolicyEntries.map(entry => entry.constrained)),
      guarded: aggregatePolicies(guardedPolicyEntries.map(entry => entry.constrained)),
      constrainedVsCurrent: aggregatePolicyOutcomes(policyEntries),
      exactConstrainedVsCurrent: aggregatePolicyOutcomes(exactPolicyEntries),
      eligibleConstrainedVsCurrent: aggregatePolicyOutcomes(autoEligiblePolicyEntries),
      guardedVsCurrent: aggregatePolicyOutcomes(guardedPolicyEntries),
      eligibleCurrentRightStartAbsDeltaSec: summarizeDistribution(
        policyBoundaryOutcomes.map(outcome => outcome.currentRightStartAbsDeltaSec),
      ),
      eligibleConstrainedRightStartAbsDeltaSec: summarizeDistribution(
        policyBoundaryOutcomes.map(outcome => outcome.constrainedRightStartAbsDeltaSec),
      ),
      eligibleCurrentRightStartOverThresholdSec: countThresholds(
        policyBoundaryOutcomes.map(outcome => outcome.currentRightStartAbsDeltaSec),
      ),
      eligibleConstrainedRightStartOverThresholdSec: countThresholds(
        policyBoundaryOutcomes.map(outcome => outcome.constrainedRightStartAbsDeltaSec),
      ),
      spokenSilenceBoundaryCount,
      exactSpokenSilenceBoundaryCount,
    },
    guardedWorsenedBoundaries: policyBoundaryOutcomes
      .filter(outcome => outcome.worseningSec > 0.001)
      .sort((left, right) => right.worseningSec - left.worseningSec),
    worstBoundaries: [...resolved]
      .sort((left, right) => (right.absDeltaSec ?? 0) - (left.absDeltaSec ?? 0))
      .slice(0, 20),
  }
}

function main(): void {
  const args = process.argv.slice(2)
  const projectPath = args[0]
  if (!projectPath) {
    throw new Error('Usage: measureSplitTimingCanary.ts <project.json> [--whisperx raw.json] [--out report.json]')
  }
  let outPath: string | undefined
  let whisperxPath: string | undefined
  for (let index = 1; index < args.length; index += 1) {
    if (args[index] === '--out') outPath = args[index + 1]
    if (args[index] === '--whisperx') whisperxPath = args[index + 1]
  }
  const externalSegments = whisperxPath ? loadExternalTranscriptSegments(whisperxPath) : undefined
  const report = buildReport(projectPath, readJson<LegacyProjectWithDebug>(projectPath), externalSegments)
  const json = `${JSON.stringify(report, null, 2)}\n`
  if (outPath) {
    mkdirSync(dirname(resolve(outPath)), { recursive: true })
    writeFileSync(outPath, json, 'utf-8')
  }
  console.log(json)
}

main()
