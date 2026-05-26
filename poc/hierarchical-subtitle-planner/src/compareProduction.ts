import fs from 'node:fs'
import path from 'node:path'
import { loadFixture } from './fixtureLoader.js'
import { buildProductionBaselinePlan } from './productionBaseline.js'
import { validatePlan, validateTimeline } from './validators.js'
import type { ChunkPlan, Constraints, CuePlan, FixtureChunk, FixtureFile, ValidationIssue } from './schema.js'
import { visibleLength } from './lineFormat.js'

const PROJECT_ROOT = path.resolve('../..')
const DEFAULT_FIXTURE = path.join(PROJECT_ROOT, 'poc/subtitle_agent/fixtures/day4_whisperx_dummy_chunks.json')

interface ComparableMetrics {
  chunks: number
  cues: number
  avgCuesPerChunk: number
  avgDuration: number
  minDuration: number
  maxDuration: number
  durationPassRate: number
  timelineErrorChunks: number
  timelineErrors: number
  textUndercovered: number
  microCueCount: number
  avgJaChars: number
}

function argValue(name: string, fallback: string): string {
  const idx = process.argv.indexOf(name)
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1]
  return fallback
}

function argList(name: string): string[] | null {
  const raw = argValue(name, '')
  if (!raw.trim()) return null
  return raw.split(',').map((item) => item.trim()).filter(Boolean)
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}

function pct(numerator: number, denominator: number): number {
  if (denominator === 0) return 0
  return Math.round((numerator / denominator) * 1000) / 10
}

function loadAgentPlan(agentRunDir: string, chunkId: string): ChunkPlan | null {
  const planPath = path.join(agentRunDir, 'plans', `${chunkId}.final.json`)
  if (!fs.existsSync(planPath)) return null
  return JSON.parse(fs.readFileSync(planPath, 'utf8')) as ChunkPlan
}

function textCoverageErrors(issues: ValidationIssue[]): number {
  return issues.filter((issue) => issue.code === 'source_text_undercovered' && issue.severity === 'error').length
}

function isMicroCue(cue: CuePlan): boolean {
  const duration = cue.end - cue.start
  const jaChars = visibleLength(cue.ja_span)
  return duration < 1.0 || jaChars < 8
}

function metricsForPlans(
  fixture: FixtureFile,
  rows: Array<{ chunk: FixtureChunk; plan: ChunkPlan; mode: 'agent' | 'production' }>,
): ComparableMetrics {
  const allCues = rows.flatMap((row) => row.plan.cues)
  const durations = allCues.map((cue) => cue.end - cue.start)
  let timelineErrors = 0
  let timelineErrorChunks = 0
  let undercovered = 0
  for (const row of rows) {
    const issues = row.mode === 'agent'
      ? validatePlan(row.plan, row.chunk, fixture.constraints).issues
      : validateTimeline(row.plan, row.chunk, fixture.constraints)
    const errors = issues.filter((issue) => issue.severity === 'error')
    timelineErrors += errors.length
    if (errors.length > 0) timelineErrorChunks += 1
    undercovered += textCoverageErrors(issues)
  }
  return {
    chunks: rows.length,
    cues: allCues.length,
    avgCuesPerChunk: round(allCues.length / Math.max(1, rows.length)),
    avgDuration: round(durations.reduce((sum, duration) => sum + duration, 0) / Math.max(1, durations.length)),
    minDuration: round(durations.length ? Math.min(...durations) : 0),
    maxDuration: round(durations.length ? Math.max(...durations) : 0),
    durationPassRate: pct(
      durations.filter((duration) => duration >= fixture.constraints.min_duration && duration <= fixture.constraints.max_duration).length,
      durations.length,
    ),
    timelineErrorChunks,
    timelineErrors,
    textUndercovered: undercovered,
    microCueCount: allCues.filter(isMicroCue).length,
    avgJaChars: round(allCues.reduce((sum, cue) => sum + visibleLength(cue.ja_span), 0) / Math.max(1, allCues.length)),
  }
}

function markdownTable(metrics: Record<string, ComparableMetrics>): string {
  const rows = [
    ['chunks', (m: ComparableMetrics) => String(m.chunks)],
    ['cues', (m: ComparableMetrics) => String(m.cues)],
    ['avg cues / chunk', (m: ComparableMetrics) => String(m.avgCuesPerChunk)],
    ['avg duration', (m: ComparableMetrics) => String(m.avgDuration)],
    ['min duration', (m: ComparableMetrics) => String(m.minDuration)],
    ['max duration', (m: ComparableMetrics) => String(m.maxDuration)],
    ['duration pass rate', (m: ComparableMetrics) => `${m.durationPassRate}%`],
    ['timeline error chunks', (m: ComparableMetrics) => String(m.timelineErrorChunks)],
    ['timeline errors', (m: ComparableMetrics) => String(m.timelineErrors)],
    ['text undercovered errors', (m: ComparableMetrics) => String(m.textUndercovered)],
    ['micro cues', (m: ComparableMetrics) => String(m.microCueCount)],
    ['avg JA chars / cue', (m: ComparableMetrics) => String(m.avgJaChars)],
  ] as const
  const modes = Object.keys(metrics)
  return [
    `| Metric | ${modes.join(' | ')} |`,
    `|---|${modes.map(() => '---:').join('|')}|`,
    ...rows.map(([label, getter]) => `| ${label} | ${modes.map((mode) => getter(metrics[mode])).join(' | ')} |`),
  ].join('\n')
}

function main(): void {
  const fixturePath = argValue('--fixture', DEFAULT_FIXTURE)
  const agentRun = argValue('--agent-run', '')
  const output = argValue('--out', '')
  const fixture = loadFixture(fixturePath)
  const chunkIds = argList('--chunks')
  const chunks = chunkIds
    ? fixture.chunks.filter((chunk) => chunkIds.includes(chunk.chunk_id))
    : fixture.chunks.slice(0, Number(argValue('--limit', '3')))

  const productionRows = chunks.map((chunk) => ({
    chunk,
    mode: 'production' as const,
    plan: buildProductionBaselinePlan(chunk, fixture.constraints as Constraints),
  }))
  const metrics: Record<string, ComparableMetrics> = {
    production_copy: metricsForPlans(fixture, productionRows),
  }

  let missingAgentPlans: string[] = []
  if (agentRun) {
    const agentRunDir = path.resolve(agentRun)
    const agentRows = chunks
      .map((chunk) => {
        const plan = loadAgentPlan(agentRunDir, chunk.chunk_id)
        if (!plan) {
          missingAgentPlans.push(chunk.chunk_id)
          return null
        }
        return { chunk, mode: 'agent' as const, plan }
      })
      .filter((row): row is { chunk: FixtureChunk; mode: 'agent'; plan: ChunkPlan } => Boolean(row))
    metrics.agent_poc = metricsForPlans(fixture, agentRows)
  }

  const md = `# Production Copy vs Agent PoC Comparison

> fixture: ${path.resolve(fixturePath)}
> chunks: ${chunks.map((chunk) => chunk.chunk_id).join(', ')}
> agent_run: ${agentRun ? path.resolve(agentRun) : 'n/a'}

This comparison uses the current production split/timing copy for the baseline: correction/translation API calls are not included. The shared metrics therefore focus on Japanese cue structure, timing, text coverage, and duration constraints.

${markdownTable(metrics)}

${missingAgentPlans.length > 0 ? `\nMissing agent plans: ${missingAgentPlans.join(', ')}\n` : ''}
`
  if (output) {
    fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true })
    fs.writeFileSync(path.resolve(output), md, 'utf8')
  }
  console.log(md)
}

main()
