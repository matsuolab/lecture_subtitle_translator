import type { AgentPlanDraft, ChunkPlan, CuePlan, FixtureChunk } from './schema.js'
import { normalizeSpaces } from './lineFormat.js'

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    try {
      return JSON.parse(trimmed) as Record<string, unknown>
    } catch {
      const start = trimmed.indexOf('{')
      const end = trimmed.lastIndexOf('}')
      if (start >= 0 && end > start) {
        return JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>
      }
    }
  }
  if (value && typeof value === 'object') return value as Record<string, unknown>
  throw new Error('Agent output is not a JSON object.')
}

function numberArray(value: unknown): number[] {
  if (!Array.isArray(value)) return []
  return value.map((item) => Number(item)).filter((item) => Number.isFinite(item))
}

export function parseAgentPlan(output: unknown, chunk: FixtureChunk): ChunkPlan {
  const record = asRecord(output)
  const cuesValue = record.cues
  if (!Array.isArray(cuesValue)) {
    throw new Error('Agent output does not contain cues array.')
  }
  const cues: CuePlan[] = cuesValue.map((raw, index) => {
    const item = asRecord(raw)
    const sourceIds = numberArray(item.source_segment_ids)
    return {
      cue_id: String(item.cue_id || `${chunk.chunk_id}_c${String(index + 1).padStart(3, '0')}`),
      start: Number(item.start),
      end: Number(item.end),
      ja_span: normalizeSpaces(String(item.ja_span || '')),
      en: normalizeSpaces(String(item.en || '')),
      source_segment_ids: sourceIds,
      strategy: String(item.strategy || 'agent_planned'),
      notes: typeof item.notes === 'string' ? item.notes : '',
    }
  })
  const status = record.status === 'manual_review' || record.status === 'needs_repair' || record.status === 'invalid_output'
    ? record.status
    : 'accepted'
  const reviewItems = Array.isArray(record.review_items)
    ? record.review_items.map((item) => String(item))
    : []
  return {
    chunk_id: String(record.chunk_id || chunk.chunk_id),
    status,
    cues,
    review_items: reviewItems,
  }
}

export function agentPlanToDraft(plan: ChunkPlan): AgentPlanDraft {
  return plan
}
