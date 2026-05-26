import fs from 'node:fs'
import path from 'node:path'
import { getGlobalTraceProvider, run, withTrace } from '@openai/agents'
import type { CandidateSplit, CueCandidateStats, FixtureChunk, FixtureFile, ChunkPlan, ChunkResult, MergeRewriteStats, OneWordRepairCheck, QualityFlag, StyleExample, ValidationIssue } from './schema.js'
import { loadDotEnv } from './env.js'
import { loadFixture } from './fixtureLoader.js'
import { RunLogger } from './logger.js'
import { validatePlan } from './validators.js'
import { makePlannerTools, type ToolContext } from './plannerTools.js'
import { createCriticAgent, createCueStructureAgent, createMergeRewriteAgent, createPlannerAgent, createRepairAgent, type ReasoningEffort } from './agents.js'
import { parseAgentPlan } from './agentOutput.js'
import { writeReports } from './report.js'
import { addUsage, collectTokenUsage, emptyUsage, estimateCost, estimateUsd } from './usage.js'
import { applyProductionGlossaryCorrection, loadSelfMadeCorrectionTerms } from './glossaryCorrection.js'
import { buildCueStructureInput, cueCandidateStats, parseCueStructureCandidates } from './cueStructureCandidates.js'
import { compactStyleExamples, loadStyleExamples } from './styleExamples.js'
import { assessMergeRewrite, buildMergeCandidates, buildMergeRewriteInput } from './mergeRewrite.js'

const PROJECT_ROOT = path.resolve('../..')
const DEFAULT_FIXTURE = path.join(PROJECT_ROOT, 'poc/subtitle_agent/fixtures/day4_whisperx_dummy_chunks.json')
const DEFAULT_GLOSSARY = path.join(PROJECT_ROOT, '00_context/files/drive-download-20260425T022314Z-3-002/self-made-glossary (1).json')
const DEFAULT_STYLE_EXAMPLES = 'C:\\Users\\n3oti\\Downloads\\subtitle-project_20265151201.json'

interface ModelPlan {
  cueStructure: string
  planner: string
  repair: string
  oneWord: string
  critic: string
  mergeRewrite: string
  fallback: string | null
  plannerEffort?: ReasoningEffort
  repairEfforts: ReasoningEffort[]
}

const VALID_EFFORTS: ReasoningEffort[] = ['minimal', 'low', 'medium', 'high']

function parseEfforts(name: string, fallback: ReasoningEffort[]): ReasoningEffort[] {
  const list = argList(name)
  if (!list) return fallback
  const result: ReasoningEffort[] = []
  for (const item of list) {
    if ((VALID_EFFORTS as string[]).includes(item)) {
      result.push(item as ReasoningEffort)
    } else {
      throw new Error(`Invalid reasoning effort: ${item}. Allowed: ${VALID_EFFORTS.join(',')}`)
    }
  }
  return result
}

function parseEffortOrUndefined(name: string): ReasoningEffort | undefined {
  const raw = argValue(name, '')
  if (!raw.trim()) return undefined
  if (!(VALID_EFFORTS as string[]).includes(raw)) {
    throw new Error(`Invalid reasoning effort: ${raw}. Allowed: ${VALID_EFFORTS.join(',')}`)
  }
  return raw as ReasoningEffort
}

function argValue(name: string, fallback: string): string {
  const idx = process.argv.indexOf(name)
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1]
  return fallback
}

function argNumber(name: string, fallback: number): number {
  const raw = argValue(name, String(fallback))
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : fallback
}

function argList(name: string): string[] | null {
  const raw = argValue(name, '')
  if (!raw.trim()) return null
  return raw.split(',').map((item) => item.trim()).filter(Boolean)
}

function compactChunkInput(chunk: FixtureChunk, fixture: FixtureFile, styleExamples: StyleExample[]): string {
  return JSON.stringify({
    chunk_id: chunk.chunk_id,
    start: chunk.start,
    end: chunk.end,
    context_before: chunk.context_before,
    context_after: chunk.context_after,
    constraints: fixture.constraints,
    style_examples: compactStyleExamples(styleExamples),
    style_example_instruction: styleExamples.length
      ? 'Use these human-edited examples as density and phrasing references. They are examples, not source content for this chunk.'
      : undefined,
    segments: chunk.segments.map((segment) => ({
      id: segment.id,
      start: segment.start,
      end: segment.end,
      ja_text: segment.ja_text,
      words: segment.words.map((word) => ({
        word: word.word,
        start: word.start,
        end: word.end,
      })),
    })),
  })
}

function buildRepairInput(chunk: FixtureChunk, fixture: FixtureFile, plan: ChunkPlan, issues: ValidationIssue[]): string {
  return JSON.stringify({
    chunk_id: chunk.chunk_id,
    constraints: fixture.constraints,
    chunk: {
      start: chunk.start,
      end: chunk.end,
      context_before: chunk.context_before,
      context_after: chunk.context_after,
    },
    current_plan: plan,
    validation_issues: issues,
  })
}

function buildOneWordTightenInput(chunk: FixtureChunk, fixture: FixtureFile, plan: ChunkPlan, issues: ValidationIssue[]): string {
  const targetCueIds = new Set(
    issues
      .filter((issue) => issue.code === 'cps_over' && issue.severity === 'error')
      .map((issue) => issue.cue_id)
      .filter((cueId): cueId is string => Boolean(cueId)),
  )
  return JSON.stringify({
    chunk_id: chunk.chunk_id,
    constraints: fixture.constraints,
    instruction: 'Only repair cues listed in target_cues. For each target cue, preserve meaning and reduce the English text by exactly one word. Do not change cue timing, ja_span, source_segment_ids, or unrelated cues.',
    target_cues: plan.cues.filter((cue) => targetCueIds.has(cue.cue_id)),
    current_plan: plan,
    validation_issues: issues,
  })
}

function hasOnlyCpsIssues(issues: ValidationIssue[]): boolean {
  const errors = issues.filter((issue) => issue.severity === 'error')
  if (errors.length === 0) return false
  return errors.every((issue) => issue.code === 'cps_over')
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length
}

function compareOneWordRepair(before: ChunkPlan, after: ChunkPlan, targetCueIds: Set<string>): OneWordRepairCheck[] {
  const afterById = new Map(after.cues.map((cue) => [cue.cue_id, cue]))
  const checks: OneWordRepairCheck[] = []
  for (const beforeCue of before.cues) {
    const afterCue = afterById.get(beforeCue.cue_id)
    if (!afterCue) continue
    const beforeWords = wordCount(beforeCue.en)
    const afterWords = wordCount(afterCue.en)
    const targetCue = targetCueIds.has(beforeCue.cue_id)
    checks.push({
      cue_id: beforeCue.cue_id,
      before: beforeCue.en,
      after: afterCue.en,
      before_word_count: beforeWords,
      after_word_count: afterWords,
      delta: afterWords - beforeWords,
      passed: targetCue ? afterWords === beforeWords - 1 : afterCue.en === beforeCue.en,
      target_cue: targetCue,
    })
  }
  return checks
}

function parseQualityFlags(output: unknown): QualityFlag[] {
  if (typeof output !== 'string') return []
  try {
    const parsed = JSON.parse(output) as { quality_flags?: unknown }
    if (!Array.isArray(parsed.quality_flags)) return []
    return parsed.quality_flags.map((item) => {
      const record = item && typeof item === 'object' ? item as Record<string, unknown> : {}
      const severity = record.severity === 'error' || record.severity === 'warning' || record.severity === 'info'
        ? record.severity
        : 'info'
      return {
        cue_id: String(record.cue_id ?? ''),
        severity,
        message: String(record.message ?? ''),
      }
    })
  } catch {
    return []
  }
}

function errorSummary(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    }
  }
  return { message: String(error) }
}

function isMaxTurnsExceeded(error: unknown): boolean {
  return error instanceof Error && error.name === 'MaxTurnsExceededError'
}

function salvageValidatedPlan(ctx: ToolContext, logger: RunLogger, chunkId: string, phase: string): { plan: ChunkPlan; validation: NonNullable<ToolContext['lastValidation']> } | null {
  if (!ctx.lastValidatedPlan || !ctx.lastValidation) return null
  logger.event({
    chunk_id: chunkId,
    phase,
    event_type: ctx.lastValidation.ok ? 'candidate_scored' : 'validation_failed',
    summary: ctx.lastValidation.ok
      ? 'Recovered last validated plan after max-turn stop.'
      : 'Recovered last validated failing plan after max-turn stop.',
    data: ctx.lastValidation,
  })
  return { plan: ctx.lastValidatedPlan, validation: ctx.lastValidation }
}

async function runCritic(chunk: FixtureChunk, plan: ChunkPlan, model: string, logger: RunLogger): Promise<{ usage: ReturnType<typeof emptyUsage>; flags: QualityFlag[]; calls: number }> {
  const agent = createCriticAgent(model)
  const input = JSON.stringify({ chunk_id: chunk.chunk_id, plan })
  const result = await run(agent, input, { maxTurns: 2 })
  const ref = logger.writeJson(`responses/${chunk.chunk_id}.QualityCriticAgent.response.json`, {
    finalOutput: result.finalOutput,
    rawResponses: result.rawResponses,
    newItems: result.newItems,
  })
  logger.event({
    chunk_id: chunk.chunk_id,
    phase: 'quality',
    agent: 'QualityCriticAgent',
    event_type: 'agent_response',
    model,
    output_ref: ref,
    summary: 'Quality critic completed.',
  })
  return {
    usage: collectTokenUsage(result.rawResponses),
    flags: parseQualityFlags(result.finalOutput),
    calls: result.rawResponses.length,
  }
}

interface ReasoningSummary {
  index: number
  content_excerpt: string
  has_content: boolean
}

interface ReasoningLog {
  agent_label: string
  model: string
  effort?: ReasoningEffort
  reasoning_items_total: number
  reasoning_items_with_content: number
  reasoning_summaries: ReasoningSummary[]
  per_response_tokens: Array<{ output_total: number; reasoning_tokens: number }>
  reasoning_tokens_total: number
  output_tokens_total: number
}

function extractReasoningLog(
  agentLabel: string,
  model: string,
  effort: ReasoningEffort | undefined,
  newItems: unknown[],
  rawResponses: unknown[],
): ReasoningLog {
  const summaries: ReasoningSummary[] = []
  let idx = 0
  for (const item of newItems) {
    if (!item || typeof item !== 'object') continue
    const t = (item as { type?: string }).type
    if (t !== 'reasoning_item') continue
    const raw = (item as { rawItem?: Record<string, unknown> }).rawItem ?? {}
    let content: string = ''
    const rawContent = raw.content
    if (typeof rawContent === 'string') {
      content = rawContent
    } else if (Array.isArray(rawContent)) {
      const parts: string[] = []
      for (const part of rawContent) {
        if (part && typeof part === 'object') {
          const text = (part as { text?: unknown; summary?: unknown }).text
            ?? (part as { summary?: unknown }).summary
          if (typeof text === 'string') parts.push(text)
        }
      }
      content = parts.join('\n')
    }
    if (!content) {
      const rawSummary = raw.summary
      if (typeof rawSummary === 'string') content = rawSummary
    }
    summaries.push({
      index: idx,
      content_excerpt: content.slice(0, 1000),
      has_content: content.length > 0,
    })
    idx += 1
  }

  const perResponse: Array<{ output_total: number; reasoning_tokens: number }> = []
  let reasoningTotal = 0
  let outputTotal = 0
  for (const r of rawResponses) {
    if (!r || typeof r !== 'object') continue
    const usage = (r as { usage?: Record<string, unknown> }).usage ?? {}
    const out = typeof usage.outputTokens === 'number' ? usage.outputTokens : 0
    let reasoning = 0
    const details = usage.outputTokensDetails
    if (Array.isArray(details)) {
      for (const d of details) {
        if (d && typeof d === 'object') {
          const rt = (d as { reasoning_tokens?: unknown }).reasoning_tokens
          if (typeof rt === 'number') reasoning += rt
        }
      }
    } else if (details && typeof details === 'object') {
      const rt = (details as { reasoning_tokens?: unknown }).reasoning_tokens
      if (typeof rt === 'number') reasoning = rt
    }
    perResponse.push({ output_total: out, reasoning_tokens: reasoning })
    outputTotal += out
    reasoningTotal += reasoning
  }

  return {
    agent_label: agentLabel,
    model,
    effort,
    reasoning_items_total: summaries.length,
    reasoning_items_with_content: summaries.filter((s) => s.has_content).length,
    reasoning_summaries: summaries,
    per_response_tokens: perResponse,
    reasoning_tokens_total: reasoningTotal,
    output_tokens_total: outputTotal,
  }
}

async function processChunk(fixture: FixtureFile, chunk: FixtureChunk, models: ModelPlan, logger: RunLogger, styleExamples: StyleExample[], glossaryTerms: string[]): Promise<ChunkResult> {
  const toolContext: ToolContext = { chunk, constraints: fixture.constraints, logger }
  let modelCalls = 0
  let repairIterations = 0
  let oneWordRepairAttempted = false
  let tokenUsage = emptyUsage()
  let estimatedUsd = 0
  let qualityFlags: QualityFlag[] = []
  const oneWordRepairChecks: OneWordRepairCheck[] = []
  let cueStructureStats: CueCandidateStats | undefined
  let mergeRewriteStats: MergeRewriteStats | undefined

  function addAgentUsage(model: string, rawResponses: unknown[]): void {
    const usage = collectTokenUsage(rawResponses)
    modelCalls += rawResponses.length
    tokenUsage = addUsage(tokenUsage, usage)
    estimatedUsd += estimateUsd(model, usage) ?? 0
  }

  logger.event({
    chunk_id: chunk.chunk_id,
    phase: 'chunk',
    event_type: 'chunk_started',
    summary: `Processing ${chunk.chunk_id}`,
  })

  const cueStructureAgent = createCueStructureAgent(models.cueStructure)
  const cueStructureInput = buildCueStructureInput(chunk, fixture.constraints)
  const cueStructurePromptRef = logger.writeText(`prompts/${chunk.chunk_id}.CueStructureCandidateAgent.input.json`, cueStructureInput)
  logger.event({
    chunk_id: chunk.chunk_id,
    phase: 'cue_structure',
    agent: 'CueStructureCandidateAgent',
    event_type: 'agent_prompt',
    model: models.cueStructure,
    input_ref: cueStructurePromptRef,
    summary: 'Cue structure candidate input saved.',
  })
  const cueStructureResult = await withTrace(`hsp:${chunk.chunk_id}:cue-structure`, async (trace) => {
    const result = await run(cueStructureAgent, cueStructureInput, { maxTurns: 2 })
    logger.writeJson(`traces/${chunk.chunk_id}.cue-structure.trace.json`, trace.toJSON())
    return result
  }, { metadata: { chunk_id: chunk.chunk_id, run_id: logger.runId } })
  addAgentUsage(models.cueStructure, cueStructureResult.rawResponses)
  logger.writeJson(`responses/${chunk.chunk_id}.CueStructureCandidateAgent.result.json`, {
    finalOutput: cueStructureResult.finalOutput,
    rawResponses: cueStructureResult.rawResponses,
    newItems: cueStructureResult.newItems,
  })
  const cueStructureCandidates = parseCueStructureCandidates(cueStructureResult.finalOutput, chunk, fixture.constraints, glossaryTerms)
  const selectedCueStructureCandidates: CandidateSplit[] = cueStructureCandidates
    .filter((candidate) => !candidate.metrics.hard_reject)
    .slice(0, 8)
  cueStructureStats = cueCandidateStats(cueStructureCandidates, selectedCueStructureCandidates)
  toolContext.extraCandidateSplits = selectedCueStructureCandidates
  const cueCandidateRef = logger.writeJson(`candidates/${chunk.chunk_id}.cue-structure-candidates.json`, {
    stats: cueStructureStats,
    selected_candidate_ids: selectedCueStructureCandidates.map((candidate) => candidate.candidate_id),
    candidates: cueStructureCandidates,
  })
  logger.event({
    chunk_id: chunk.chunk_id,
    phase: 'cue_structure',
    agent: 'CueStructureCandidateAgent',
    event_type: 'candidate_scored',
    model: models.cueStructure,
    output_ref: cueCandidateRef,
    summary: `Generated ${cueStructureStats.generated} cue structure candidates; selected ${cueStructureStats.selected}.`,
    data: cueStructureStats,
  })

  const tools = makePlannerTools(toolContext)
  const planner = createPlannerAgent(models.planner, tools, models.plannerEffort)
  const oneWordRepairer = createRepairAgent(models.oneWord, tools)

  const plannerInput = compactChunkInput(chunk, fixture, styleExamples)
  const plannerPromptRef = logger.writeText(`prompts/${chunk.chunk_id}.ChunkPlannerAgent.input.json`, plannerInput)
  logger.event({
    chunk_id: chunk.chunk_id,
    phase: 'planning',
    agent: 'ChunkPlannerAgent',
    event_type: 'agent_prompt',
    model: models.planner,
    input_ref: plannerPromptRef,
    summary: 'Planner input saved.',
  })

  let plan: ChunkPlan
  let validation: ReturnType<typeof validatePlan>
  try {
    toolContext.lastValidatedPlan = undefined
    toolContext.lastValidation = undefined
    const plannerResult = await withTrace(`hsp:${chunk.chunk_id}:planner`, async (trace) => {
      const result = await run(planner, plannerInput, { maxTurns: 8 })
      logger.writeJson(`traces/${chunk.chunk_id}.planner.trace.json`, trace.toJSON())
      return result
    }, { metadata: { chunk_id: chunk.chunk_id, run_id: logger.runId } })
    addAgentUsage(models.planner, plannerResult.rawResponses)
    logger.writeJson(`responses/${chunk.chunk_id}.ChunkPlannerAgent.result.json`, {
      finalOutput: plannerResult.finalOutput,
      rawResponses: plannerResult.rawResponses,
      newItems: plannerResult.newItems,
    })
    const plannerReasoningLog = extractReasoningLog('ChunkPlanner', models.planner, models.plannerEffort, plannerResult.newItems, plannerResult.rawResponses)
    if (plannerReasoningLog.reasoning_items_total > 0 || plannerReasoningLog.reasoning_tokens_total > 0) {
      const ref = logger.writeJson(`reasoning/${chunk.chunk_id}.ChunkPlanner.reasoning.json`, plannerReasoningLog)
      logger.event({
        chunk_id: chunk.chunk_id,
        phase: 'planning',
        agent: 'ChunkPlannerAgent',
        event_type: 'agent_response',
        model: models.planner,
        output_ref: ref,
        summary: `Planner reasoning: ${plannerReasoningLog.reasoning_tokens_total} tokens, ${plannerReasoningLog.reasoning_items_with_content}/${plannerReasoningLog.reasoning_items_total} items with content.`,
        data: { reasoning_tokens: plannerReasoningLog.reasoning_tokens_total, items_with_content: plannerReasoningLog.reasoning_items_with_content },
      })
    }

    plan = parseAgentPlan(plannerResult.finalOutput, chunk)
    validation = validatePlan(plan, chunk, fixture.constraints)
  } catch (error) {
    const recovered = isMaxTurnsExceeded(error) ? salvageValidatedPlan(toolContext, logger, chunk.chunk_id, 'planning') : null
    if (!recovered) throw error
    plan = recovered.plan
    validation = recovered.validation
  }
  logger.event({
    chunk_id: chunk.chunk_id,
    phase: 'validation',
    event_type: validation.ok ? 'candidate_scored' : 'validation_failed',
    summary: validation.ok ? 'Planner plan passed hard validation.' : 'Planner plan failed hard validation.',
    data: validation,
  })

  const maxRepairs = models.repairEfforts.length
  while (!validation.ok && repairIterations < maxRepairs) {
    const currentEffort = models.repairEfforts[repairIterations]
    repairIterations += 1
    const escalatedRepairer = createRepairAgent(models.repair, tools, currentEffort)
    const repairInput = buildRepairInput(chunk, fixture, plan, validation.issues)
    const repairPromptRef = logger.writeText(`prompts/${chunk.chunk_id}.RepairPlannerAgent.${repairIterations}.input.json`, repairInput)
    logger.event({
      chunk_id: chunk.chunk_id,
      phase: 'repair',
      agent: 'RepairPlannerAgent',
      event_type: 'repair_decision',
      attempt: repairIterations,
      model: models.repair,
      input_ref: repairPromptRef,
      summary: `Repair agent invoked (effort=${currentEffort}).`,
      data: { effort: currentEffort },
    })
    try {
      toolContext.lastValidatedPlan = undefined
      toolContext.lastValidation = undefined
      const repairResult = await withTrace(`hsp:${chunk.chunk_id}:repair:${repairIterations}`, async (trace) => {
        const result = await run(escalatedRepairer, repairInput, { maxTurns: 12 })
        logger.writeJson(`traces/${chunk.chunk_id}.repair.${repairIterations}.trace.json`, trace.toJSON())
        return result
      }, { metadata: { chunk_id: chunk.chunk_id, run_id: logger.runId, attempt: String(repairIterations), effort: currentEffort } })
      addAgentUsage(models.repair, repairResult.rawResponses)
      const repairReasoningLog = extractReasoningLog(`RepairPlanner#${repairIterations}`, models.repair, currentEffort, repairResult.newItems, repairResult.rawResponses)
      if (repairReasoningLog.reasoning_items_total > 0 || repairReasoningLog.reasoning_tokens_total > 0) {
        const ref = logger.writeJson(`reasoning/${chunk.chunk_id}.RepairPlanner.${repairIterations}.reasoning.json`, repairReasoningLog)
        logger.event({
          chunk_id: chunk.chunk_id,
          phase: 'repair',
          agent: 'RepairPlannerAgent',
          event_type: 'agent_response',
          attempt: repairIterations,
          model: models.repair,
          output_ref: ref,
          summary: `Repair#${repairIterations} (effort=${currentEffort}) reasoning: ${repairReasoningLog.reasoning_tokens_total} tokens, ${repairReasoningLog.reasoning_items_with_content}/${repairReasoningLog.reasoning_items_total} items with content.`,
          data: { effort: currentEffort, reasoning_tokens: repairReasoningLog.reasoning_tokens_total, items_with_content: repairReasoningLog.reasoning_items_with_content },
        })
      }
      logger.writeJson(`responses/${chunk.chunk_id}.RepairPlannerAgent.${repairIterations}.result.json`, {
        finalOutput: repairResult.finalOutput,
        rawResponses: repairResult.rawResponses,
        newItems: repairResult.newItems,
      })
      plan = parseAgentPlan(repairResult.finalOutput, chunk)
      validation = validatePlan(plan, chunk, fixture.constraints)
    } catch (error) {
      const recovered = isMaxTurnsExceeded(error) ? salvageValidatedPlan(toolContext, logger, chunk.chunk_id, 'repair') : null
      if (!recovered) throw error
      plan = recovered.plan
      validation = recovered.validation
    }
    logger.event({
      chunk_id: chunk.chunk_id,
      phase: 'validation',
      event_type: validation.ok ? 'candidate_scored' : 'validation_failed',
      attempt: repairIterations,
      summary: validation.ok ? 'Repair plan passed hard validation.' : 'Repair plan failed hard validation.',
      data: validation,
    })

    if (!validation.ok && repairIterations >= 1 && !oneWordRepairAttempted && hasOnlyCpsIssues(validation.issues)) {
      const beforeOneWordPlan = plan
      const targetCueIds = new Set(validation.issues.map((issue) => issue.cue_id).filter((cueId): cueId is string => Boolean(cueId)))
      oneWordRepairAttempted = true
      repairIterations += 1
      const tightenInput = buildOneWordTightenInput(chunk, fixture, plan, validation.issues)
      const tightenPromptRef = logger.writeText(`prompts/${chunk.chunk_id}.RepairPlannerAgent.${repairIterations}.one-word.input.json`, tightenInput)
      logger.event({
        chunk_id: chunk.chunk_id,
        phase: 'repair',
        agent: 'RepairPlannerAgent',
        event_type: 'repair_decision',
        attempt: repairIterations,
        model: models.oneWord,
        input_ref: tightenPromptRef,
        summary: 'One-word CPS repair invoked.',
      })
      let tightenResult
      try {
        toolContext.lastValidatedPlan = undefined
        toolContext.lastValidation = undefined
        tightenResult = await withTrace(`hsp:${chunk.chunk_id}:repair:${repairIterations}:one-word`, async (trace) => {
          const result = await run(oneWordRepairer, tightenInput, { maxTurns: 8 })
          logger.writeJson(`traces/${chunk.chunk_id}.repair.${repairIterations}.one-word.trace.json`, trace.toJSON())
          return result
        }, { metadata: { chunk_id: chunk.chunk_id, run_id: logger.runId, attempt: String(repairIterations), repair_type: 'one_word_cps' } })
      } catch (error) {
        const recovered = isMaxTurnsExceeded(error) ? salvageValidatedPlan(toolContext, logger, chunk.chunk_id, 'repair') : null
        if (recovered) {
          plan = recovered.plan
          validation = recovered.validation
          break
        }
        const ref = logger.writeJson(`errors/${chunk.chunk_id}.repair.${repairIterations}.one-word.error.json`, errorSummary(error))
        logger.event({
          chunk_id: chunk.chunk_id,
          phase: 'repair',
          agent: 'RepairPlannerAgent',
          event_type: 'validation_failed',
          attempt: repairIterations,
          model: models.oneWord,
          output_ref: ref,
          summary: 'One-word repair failed before final output.',
        })
        break
      }
      addAgentUsage(models.oneWord, tightenResult.rawResponses)
      logger.writeJson(`responses/${chunk.chunk_id}.RepairPlannerAgent.${repairIterations}.one-word.result.json`, {
        finalOutput: tightenResult.finalOutput,
        rawResponses: tightenResult.rawResponses,
        newItems: tightenResult.newItems,
      })
      plan = parseAgentPlan(tightenResult.finalOutput, chunk)
      const checks = compareOneWordRepair(beforeOneWordPlan, plan, targetCueIds)
      oneWordRepairChecks.push(...checks)
      logger.writeJson(`repairs/${chunk.chunk_id}.one-word.${repairIterations}.check.json`, checks)
      logger.event({
        chunk_id: chunk.chunk_id,
        phase: 'repair',
        agent: 'RepairPlannerAgent',
        event_type: checks.every((check) => check.passed) ? 'candidate_scored' : 'validation_failed',
        attempt: repairIterations,
        model: models.oneWord,
        summary: checks.every((check) => check.passed)
          ? 'One-word repair word-count check passed.'
          : 'One-word repair word-count check failed.',
        data: checks,
      })
      validation = validatePlan(plan, chunk, fixture.constraints)
      logger.event({
        chunk_id: chunk.chunk_id,
        phase: 'validation',
        event_type: validation.ok ? 'candidate_scored' : 'validation_failed',
        attempt: repairIterations,
        summary: validation.ok ? 'One-word repair plan passed hard validation.' : 'One-word repair plan failed hard validation.',
        data: validation,
      })
    }
  }

  if (!validation.ok && models.fallback) {
    repairIterations += 1
    const fallbackRepairer = createRepairAgent(models.fallback, tools)
    const fallbackInput = buildRepairInput(chunk, fixture, plan, validation.issues)
    const fallbackPromptRef = logger.writeText(`prompts/${chunk.chunk_id}.RepairPlannerAgent.${repairIterations}.fallback.input.json`, fallbackInput)
    logger.event({
      chunk_id: chunk.chunk_id,
      phase: 'repair',
      agent: 'RepairPlannerAgent',
      event_type: 'repair_decision',
      attempt: repairIterations,
      model: models.fallback,
      input_ref: fallbackPromptRef,
      summary: 'Fallback high-capability repair invoked.',
    })
    try {
      toolContext.lastValidatedPlan = undefined
      toolContext.lastValidation = undefined
      const fallbackResult = await withTrace(`hsp:${chunk.chunk_id}:repair:${repairIterations}:fallback`, async (trace) => {
        const result = await run(fallbackRepairer, fallbackInput, { maxTurns: 8 })
        logger.writeJson(`traces/${chunk.chunk_id}.repair.${repairIterations}.fallback.trace.json`, trace.toJSON())
        return result
      }, { metadata: { chunk_id: chunk.chunk_id, run_id: logger.runId, attempt: String(repairIterations), repair_type: 'fallback' } })
      addAgentUsage(models.fallback, fallbackResult.rawResponses)
      logger.writeJson(`responses/${chunk.chunk_id}.RepairPlannerAgent.${repairIterations}.fallback.result.json`, {
        finalOutput: fallbackResult.finalOutput,
        rawResponses: fallbackResult.rawResponses,
        newItems: fallbackResult.newItems,
      })
      plan = parseAgentPlan(fallbackResult.finalOutput, chunk)
      validation = validatePlan(plan, chunk, fixture.constraints)
      logger.event({
        chunk_id: chunk.chunk_id,
        phase: 'validation',
        event_type: validation.ok ? 'candidate_scored' : 'validation_failed',
        attempt: repairIterations,
        summary: validation.ok ? 'Fallback repair plan passed hard validation.' : 'Fallback repair plan failed hard validation.',
        data: validation,
      })
    } catch (error) {
      const recovered = isMaxTurnsExceeded(error) ? salvageValidatedPlan(toolContext, logger, chunk.chunk_id, 'repair') : null
      if (recovered) {
        plan = recovered.plan
        validation = recovered.validation
      } else {
      const ref = logger.writeJson(`errors/${chunk.chunk_id}.repair.${repairIterations}.fallback.error.json`, errorSummary(error))
      logger.event({
        chunk_id: chunk.chunk_id,
        phase: 'repair',
        agent: 'RepairPlannerAgent',
        event_type: 'validation_failed',
        attempt: repairIterations,
        model: models.fallback,
        output_ref: ref,
        summary: 'Fallback repair failed before final output.',
      })
      }
    }
  }

  if (!validation.ok) {
    plan.status = 'manual_review'
    plan.review_items.push('Hard constraints were still failing after repair loop limit.')
  }
  if (validation.ok) {
    const mergeCandidates = buildMergeCandidates(plan, fixture.constraints)
    if (mergeCandidates.length > 0) {
      const mergeAgent = createMergeRewriteAgent(models.mergeRewrite)
      const mergeInput = buildMergeRewriteInput(chunk, fixture.constraints, plan, mergeCandidates, styleExamples)
      const mergePromptRef = logger.writeText(`prompts/${chunk.chunk_id}.CueMergeRewriteAgent.input.json`, mergeInput)
      const beforeMergePlan = plan
      logger.event({
        chunk_id: chunk.chunk_id,
        phase: 'merge_rewrite',
        agent: 'CueMergeRewriteAgent',
        event_type: 'agent_prompt',
        model: models.mergeRewrite,
        input_ref: mergePromptRef,
        summary: `Merge rewrite input saved with ${mergeCandidates.length} candidates.`,
      })
      try {
        const mergeResult = await withTrace(`hsp:${chunk.chunk_id}:merge-rewrite`, async (trace) => {
          const result = await run(mergeAgent, mergeInput, { maxTurns: 2 })
          logger.writeJson(`traces/${chunk.chunk_id}.merge-rewrite.trace.json`, trace.toJSON())
          return result
        }, { metadata: { chunk_id: chunk.chunk_id, run_id: logger.runId } })
        addAgentUsage(models.mergeRewrite, mergeResult.rawResponses)
        logger.writeJson(`responses/${chunk.chunk_id}.CueMergeRewriteAgent.result.json`, {
          finalOutput: mergeResult.finalOutput,
          rawResponses: mergeResult.rawResponses,
          newItems: mergeResult.newItems,
        })
        const rewrittenPlan = parseAgentPlan(mergeResult.finalOutput, chunk)
        const assessment = assessMergeRewrite(beforeMergePlan, rewrittenPlan, chunk, fixture.constraints, mergeCandidates.length)
        mergeRewriteStats = assessment.stats
        logger.event({
          chunk_id: chunk.chunk_id,
          phase: 'merge_rewrite',
          agent: 'CueMergeRewriteAgent',
          event_type: assessment.accepted ? 'candidate_scored' : 'validation_failed',
          model: models.mergeRewrite,
          summary: assessment.accepted
            ? 'Merge rewrite accepted.'
            : `Merge rewrite rejected: ${assessment.stats.rejection_reason ?? 'unknown'}`,
          data: assessment.stats,
        })
        if (assessment.accepted) {
          plan = rewrittenPlan
          validation = validatePlan(plan, chunk, fixture.constraints)
        }
      } catch (error) {
        const ref = logger.writeJson(`errors/${chunk.chunk_id}.merge-rewrite.error.json`, errorSummary(error))
        mergeRewriteStats = {
          candidates: mergeCandidates.length,
          attempted: true,
          accepted: false,
          before_cues: beforeMergePlan.cues.length,
          after_cues: beforeMergePlan.cues.length,
          before_avg_capacity_utilization: 0,
          after_avg_capacity_utilization: 0,
          before_avg_constraint_quality_score: 0,
          after_avg_constraint_quality_score: 0,
          rejection_reason: 'merge_rewrite_runtime_error',
        }
        logger.event({
          chunk_id: chunk.chunk_id,
          phase: 'merge_rewrite',
          agent: 'CueMergeRewriteAgent',
          event_type: 'validation_failed',
          model: models.mergeRewrite,
          output_ref: ref,
          summary: 'Merge rewrite failed before final output; keeping previous valid plan.',
        })
      }
    } else {
      mergeRewriteStats = {
        candidates: 0,
        attempted: false,
        accepted: false,
        before_cues: plan.cues.length,
        after_cues: plan.cues.length,
        before_avg_capacity_utilization: 0,
        after_avg_capacity_utilization: 0,
        before_avg_constraint_quality_score: 0,
        after_avg_constraint_quality_score: 0,
        rejection_reason: 'no_merge_candidates',
      }
    }
    plan.status = 'accepted'
    const critic = await runCritic(chunk, plan, models.critic, logger)
    modelCalls += critic.calls
    tokenUsage = addUsage(tokenUsage, critic.usage)
    estimatedUsd += estimateUsd(models.critic, critic.usage) ?? 0
    qualityFlags = critic.flags
  }

  const finalRef = logger.writeJson(`plans/${chunk.chunk_id}.final.json`, plan)
  const status = validation.ok ? 'accepted' : 'manual_review'
  logger.event({
    chunk_id: chunk.chunk_id,
    phase: 'chunk',
    event_type: 'chunk_finished',
    output_ref: finalRef,
    summary: `${chunk.chunk_id} finished as ${status}`,
  })

  return {
    chunk_id: chunk.chunk_id,
    status,
    plan,
    cue_validations: validation.cueValidations,
    issues: validation.issues,
    repair_iterations: repairIterations,
    model_calls: modelCalls,
    token_usage: tokenUsage,
    cost_estimate: {
      ...estimateCost('mixed', tokenUsage),
      model: `planner=${models.planner};repair=${models.repair};oneWord=${models.oneWord};mergeRewrite=${models.mergeRewrite};critic=${models.critic};fallback=${models.fallback ?? 'none'}`,
      estimated_usd: Math.round(estimatedUsd * 1_000_000) / 1_000_000,
      pricing_source: 'phase model pricing',
      notes: [],
    },
    quality_flags: qualityFlags,
    one_word_repairs: oneWordRepairChecks,
    cue_candidate_stats: cueStructureStats,
    merge_rewrite_stats: mergeRewriteStats,
  }
}

async function main(): Promise<void> {
  loadDotEnv(path.join(PROJECT_ROOT, 'poc/.env'))
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is required. No non-SDK fallback is available for this PoC.')
  }
  const fixturePath = argValue('--fixture', DEFAULT_FIXTURE)
  const limit = argNumber('--limit', 3)
  const model = argValue('--model', process.env.HSP_MODEL || process.env.OPENAI_MODEL || 'gpt-5.4-mini')
  const models: ModelPlan = {
    cueStructure: argValue('--cue-structure-model', process.env.HSP_CUE_STRUCTURE_MODEL || process.env.HSP_CANDIDATE_MODEL || 'gpt-5.4-nano'),
    planner: argValue('--planner-model', process.env.HSP_PLANNER_MODEL || model),
    repair: argValue('--repair-model', process.env.HSP_REPAIR_MODEL || model),
    oneWord: argValue('--one-word-model', process.env.HSP_ONE_WORD_MODEL || process.env.HSP_REPAIR_MODEL || model),
    critic: argValue('--critic-model', process.env.HSP_CRITIC_MODEL || model),
    mergeRewrite: argValue('--merge-rewrite-model', process.env.HSP_MERGE_REWRITE_MODEL || process.env.HSP_REPAIR_MODEL || model),
    fallback: argValue('--fallback-model', process.env.HSP_FALLBACK_MODEL || ''),
    plannerEffort: parseEffortOrUndefined('--planner-effort'),
    repairEfforts: parseEfforts('--repair-efforts', ['low', 'medium']),
  }
  if (!models.fallback) models.fallback = null
  const correctionModel = argValue('--correction-model', process.env.HSP_CORRECTION_MODEL || model)
  const glossaryPath = argValue('--glossary', DEFAULT_GLOSSARY)
  const styleExamplesPath = argValue('--style-examples', process.env.HSP_STYLE_EXAMPLES || DEFAULT_STYLE_EXAMPLES)
  const styleExampleLimit = argNumber('--style-example-limit', 12)
  const skipCorrection = process.argv.includes('--skip-correction')
  const runId = argValue('--run-id', `hsp_${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`)
  const resultsRoot = path.resolve('results')
  const logger = new RunLogger(runId, resultsRoot)
  const fixture = loadFixture(fixturePath)
  const styleExamples = loadStyleExamples(styleExamplesPath, fixture.constraints, styleExampleLimit)
  const baseGlossaryTerms = !skipCorrection && fs.existsSync(glossaryPath)
    ? loadSelfMadeCorrectionTerms(glossaryPath)
    : []
  const chunkIds = argList('--chunks')
  const chunks = chunkIds
    ? fixture.chunks.filter((chunk) => chunkIds.includes(chunk.chunk_id))
    : fixture.chunks.slice(0, limit)

  logger.writeJson('run.json', {
    run_id: runId,
    fixture: path.resolve(fixturePath),
    model,
    models,
    correction_model: correctionModel,
    glossary: skipCorrection ? null : path.resolve(glossaryPath),
    glossary_term_count: baseGlossaryTerms.length,
    style_examples: styleExamplesPath ? path.resolve(styleExamplesPath) : null,
    style_example_count: styleExamples.length,
    limit,
    sdk: '@openai/agents',
    fallback: false,
  })
  logger.event({
    phase: 'run',
    event_type: 'run_started',
    model: models.planner,
    summary: `Starting run with ${chunks.length} chunks.`,
  })

  // Tool body smoke test before exposing the functions through SDK tools.
  const first = chunks[0]
  if (!first) throw new Error('Fixture contains no chunks.')
  const smokePlan: ChunkPlan = {
    chunk_id: first.chunk_id,
    status: 'accepted',
    cues: [{
      cue_id: `${first.chunk_id}_smoke`,
      start: first.start,
      end: Math.min(first.start + 2, first.end),
      ja_span: first.segments[0]?.ja_text ?? '',
      en: 'Smoke test.',
      source_segment_ids: [first.segments[0]?.id ?? 1],
      strategy: 'smoke',
    }],
    review_items: [],
  }
  const smoke = validatePlan(smokePlan, first, fixture.constraints)
  logger.event({
    chunk_id: first.chunk_id,
    phase: 'preflight',
    event_type: 'tool_finished',
    summary: 'Tool body smoke test completed before SDK agent run.',
    data: smoke,
  })

  const results: ChunkResult[] = []
  for (const chunk of chunks) {
    try {
      let effectiveChunk = chunk
      let glossaryTerms = baseGlossaryTerms
      if (!skipCorrection && fs.existsSync(glossaryPath)) {
        const corrected = await applyProductionGlossaryCorrection(chunk, glossaryPath, correctionModel)
        effectiveChunk = corrected.chunk
        glossaryTerms = corrected.correctionTerms
        logger.writeJson(`corrections/${chunk.chunk_id}.production-glossary-correction.json`, corrected)
        logger.event({
          chunk_id: chunk.chunk_id,
          phase: 'preprocess',
          event_type: 'tool_finished',
          model: correctionModel,
          summary: `Production glossary correction applied to ${corrected.changedSegments} segments with ${corrected.correctionTerms.length} terms.`,
        })
      }
      results.push(await processChunk(fixture, effectiveChunk, models, logger, styleExamples, glossaryTerms))
    } catch (error) {
      const ref = logger.writeJson(`errors/${chunk.chunk_id}.error.json`, errorSummary(error))
      logger.event({
        chunk_id: chunk.chunk_id,
        phase: 'chunk',
        event_type: 'validation_failed',
        output_ref: ref,
        summary: `${chunk.chunk_id} failed with an unhandled agent/runtime error.`,
      })
      results.push({
        chunk_id: chunk.chunk_id,
        status: 'invalid_output',
        plan: {
          chunk_id: chunk.chunk_id,
          status: 'invalid_output',
          cues: [],
          review_items: ['Unhandled agent/runtime error. See errors log for details.'],
        },
        cue_validations: [],
        issues: [{
          code: 'agent_runtime_error',
          severity: 'error',
          message: error instanceof Error ? error.message : String(error),
        }],
        repair_iterations: 0,
        model_calls: 0,
        token_usage: emptyUsage(),
        cost_estimate: estimateCost(model, emptyUsage()),
        quality_flags: [],
        one_word_repairs: [],
      })
    }
  }
  writeReports(logger, fixture, results)
  logger.event({
    phase: 'run',
    event_type: 'run_finished',
    summary: 'Run completed.',
  })
  await getGlobalTraceProvider().forceFlush()
  await getGlobalTraceProvider().shutdown(1000)
  console.log(`run_id=${runId}`)
  console.log(`summary=${path.join(logger.baseDir, 'reports', 'summary.md')}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
