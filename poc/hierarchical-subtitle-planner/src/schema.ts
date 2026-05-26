export interface WordTimestamp {
  word: string
  start: number
  end: number
  score?: number
}

export interface FixtureSegment {
  id: number
  start: number
  end: number
  ja_text: string
  raw_ja_text?: string
  correction_distance?: number
  correction_flagged?: boolean
  words: WordTimestamp[]
}

export interface Constraints {
  max_cps: number
  max_chars_per_line: number
  max_segment_chars: number
  max_lines: number
  min_duration: number
  max_duration: number
  min_gap: number
}

export interface FixtureChunk {
  chunk_id: string
  start: number
  end: number
  duration: number
  context_before: string
  context_after: string
  heuristic_tags?: string[]
  metrics?: Record<string, number>
  segments: FixtureSegment[]
}

export interface FixtureFile {
  source: string
  constraints: Constraints
  chunks: FixtureChunk[]
}

export interface CuePlan {
  cue_id: string
  start: number
  end: number
  ja_span: string
  en: string
  source_segment_ids: number[]
  strategy: string
  notes?: string
}

export interface CandidateCue {
  cue_id: string
  start: number
  end: number
  ja_span: string
  source_segment_ids: number[]
  source_token_count: number
  ja_chars: number
  micro_cue_risk: boolean
  max_en_chars_by_cps: number
  target_en_chars: number
  min_good_en_chars: number
  target_en_words: number
  duration: number
  align_conf?: 'exact' | 'proportional' | 'no_words'
  align_notes?: string[]
}

export interface CandidateSplit {
  candidate_id: string
  strategy: string
  cues: CandidateCue[]
  metrics: {
    cue_count: number
    min_duration: number
    max_duration: number
    avg_duration: number
    uncovered_seconds: number
    avg_utilization_target: number
    micro_cue_count: number
    micro_cue_rate: number
    score: number
    hard_reject: boolean
    score_reasons: string[]
  }
}

export type ChunkStatus = 'accepted' | 'needs_repair' | 'manual_review' | 'invalid_output'

export interface ChunkPlan {
  chunk_id: string
  status: ChunkStatus
  cues: CuePlan[]
  review_items: string[]
}

export interface ValidationIssue {
  code: string
  message: string
  cue_id?: string
  severity: 'error' | 'warning'
  metrics?: Record<string, number | string>
}

export interface CueValidation {
  cue_id: string
  ok: boolean
  issues: ValidationIssue[]
  metrics: {
    duration: number
    enChars: number
    cps: number
    lineCount: number
    maxLineLen: number
    capacityChars: number
    targetChars: number
    minGoodChars: number
    targetWords: number
    utilization: number
    utilizationScore: number
    durationComfortScore: number
    lineFillScore: number
    constraintQualityScore: number
  }
}

export interface ChunkResult {
  chunk_id: string
  status: ChunkStatus
  plan: ChunkPlan
  cue_validations: CueValidation[]
  issues: ValidationIssue[]
  repair_iterations: number
  model_calls: number
  token_usage: TokenUsage
  cost_estimate: CostEstimate
  quality_flags: QualityFlag[]
  one_word_repairs: OneWordRepairCheck[]
  cue_candidate_stats?: CueCandidateStats
  merge_rewrite_stats?: MergeRewriteStats
}

export interface CueCandidateStats {
  generated: number
  valid: number
  selected: number
  best_score: number
  strategies: Record<string, number>
  alignment?: {
    total_cues: number
    exact: number
    proportional: number
    no_words: number
  }
}

export interface StyleExample {
  id: string
  ja: string
  en: string
  duration: number
  en_chars: number
  cps: number
  capacity_chars: number
  utilization: number
  line_count: number
  max_line_len: number
}

export interface MergeCandidate {
  candidate_id: string
  cue_ids: string[]
  start: number
  end: number
  duration: number
  gap_seconds: number
  ja_span: string
  current_en: string
  source_segment_ids: number[]
  current_chars: number
  capacity_chars: number
  target_chars: number
  min_good_chars: number
  target_words: number
  reason: string
}

export interface MergeRewriteStats {
  candidates: number
  attempted: boolean
  accepted: boolean
  before_cues: number
  after_cues: number
  before_avg_capacity_utilization: number
  after_avg_capacity_utilization: number
  before_avg_constraint_quality_score: number
  after_avg_constraint_quality_score: number
  rejection_reason?: string
}

export interface AgentCueDraft {
  cue_id?: string
  start: number
  end: number
  ja_span: string
  en?: string
  source_segment_ids?: number[]
  strategy?: string
  notes?: string
}

export interface AgentPlanDraft {
  status?: ChunkStatus
  cues: AgentCueDraft[]
  review_items?: string[]
}

export interface TokenUsage {
  input_tokens: number
  cached_input_tokens: number
  billable_input_tokens: number
  output_tokens: number
  total_tokens: number
}

export interface CostEstimate {
  model: string
  input_usd_per_1m: number | null
  cached_input_usd_per_1m: number | null
  output_usd_per_1m: number | null
  estimated_usd: number | null
  pricing_source: string
  notes: string[]
}

export interface QualityFlag {
  cue_id: string
  severity: 'info' | 'warning' | 'error'
  message: string
}

export interface OneWordRepairCheck {
  cue_id: string
  before: string
  after: string
  before_word_count: number
  after_word_count: number
  delta: number
  passed: boolean
  target_cue: boolean
}
