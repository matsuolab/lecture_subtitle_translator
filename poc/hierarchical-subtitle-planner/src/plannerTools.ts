import { tool } from '@openai/agents'
import { z } from 'zod'
import type { CandidateSplit, ChunkPlan, Constraints, FixtureChunk } from './schema.js'
import { formatSubtitleLines } from './lineFormat.js'
import { validatePlan } from './validators.js'
import { generateCandidateSplits } from './candidateSplits.js'
import type { RunLogger } from './logger.js'

type ValidationResult = ReturnType<typeof validatePlan>

export interface ToolContext {
  chunk: FixtureChunk
  constraints: Constraints
  logger: RunLogger
  extraCandidateSplits?: CandidateSplit[]
  lastValidatedPlan?: ChunkPlan
  lastValidation?: ValidationResult
}

const cueSchema = z.object({
  cue_id: z.string(),
  start: z.number(),
  end: z.number(),
  ja_span: z.string(),
  en: z.string(),
  source_segment_ids: z.array(z.number()),
  strategy: z.string(),
  notes: z.string().optional(),
})

const planSchema = z.object({
  chunk_id: z.string(),
  status: z.enum(['accepted', 'needs_repair', 'manual_review', 'invalid_output']),
  cues: z.array(cueSchema),
  review_items: z.array(z.string()),
})

function logTool(ctx: ToolContext, name: string, input: unknown, output: unknown): void {
  ctx.logger.event({
    chunk_id: ctx.chunk.chunk_id,
    phase: 'tool',
    event_type: 'tool_finished',
    summary: name,
    data: { input, output },
  })
}

export function makePlannerTools(ctx: ToolContext) {
  const generateCandidateSplitsTool = tool({
    name: 'generate_candidate_splits',
    description: 'Generate deterministic subtitle timing and Japanese-span candidate splits for the current chunk. Use these candidates as timing skeletons before writing English text.',
    parameters: z.object({
      preferred_strategy: z.enum(['word_budget', 'segment_boundary', 'short_cues', 'all']),
    }),
    strict: true,
    execute: ({ preferred_strategy }: { preferred_strategy: 'word_budget' | 'segment_boundary' | 'short_cues' | 'all' }) => {
      const candidates = generateCandidateSplits(ctx.chunk, ctx.constraints, ctx.extraCandidateSplits ?? [])
      const output = preferred_strategy === 'all'
        ? candidates
        : candidates.filter((candidate) => candidate.strategy === preferred_strategy)
      logTool(ctx, 'generate_candidate_splits', { preferred_strategy }, output)
      return output
    },
  })

  const validatePlanTool = tool({
    name: 'validate_plan',
    description: 'Validate a full chunk plan. This is the final hard-constraint checker and returns cue metrics plus all validation issues.',
    parameters: planSchema,
    strict: true,
    execute: (plan: ChunkPlan) => {
      const output = validatePlan(plan, ctx.chunk, ctx.constraints)
      ctx.lastValidatedPlan = plan
      ctx.lastValidation = output
      logTool(ctx, 'validate_plan', plan, output)
      return output
    },
  })

  const formatSubtitleLinesTool = tool({
    name: 'format_subtitle_lines',
    description: 'Format English subtitle text into lines and return line metrics.',
    parameters: z.object({
      text: z.string(),
    }),
    strict: true,
    execute: ({ text }: { text: string }) => {
      const formatted = formatSubtitleLines(text, ctx.constraints.max_chars_per_line, ctx.constraints.max_lines)
      const lines = formatted ? formatted.split('\n') : []
      const output = {
        formatted,
        lineCount: lines.length,
        maxLineLen: lines.reduce((max, line) => Math.max(max, line.length), 0),
      }
      logTool(ctx, 'format_subtitle_lines', { text }, output)
      return output
    },
  })

  const scoreCandidatePlanTool = tool({
    name: 'score_candidate_plan',
    description: 'Score a plan only by hard constraints. Semantic similarity is intentionally excluded from this score.',
    parameters: planSchema,
    strict: true,
    execute: (plan: ChunkPlan) => {
      const validation = validatePlan(plan, ctx.chunk, ctx.constraints)
      const errorCount = validation.issues.filter((issue) => issue.severity === 'error').length
      const warningCount = validation.issues.filter((issue) => issue.severity === 'warning').length
      const output = {
        score: Math.max(0, 100 - errorCount * 20 - warningCount * 2),
        constraint_quality_score: validation.cueValidations.length === 0
          ? 0
          : validation.cueValidations.reduce((sum, item) => sum + item.metrics.constraintQualityScore, 0) / validation.cueValidations.length,
        accepted: errorCount === 0,
        errorCount,
        warningCount,
        issues: validation.issues,
      }
      logTool(ctx, 'score_candidate_plan', plan, output)
      return output
    },
  })

  return [
    generateCandidateSplitsTool,
    validatePlanTool,
    formatSubtitleLinesTool,
    scoreCandidatePlanTool,
  ]
}
