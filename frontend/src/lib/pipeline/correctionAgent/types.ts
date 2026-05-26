import type { AdminSettings } from '@/types/adminSettings'
import type { EnBlock, PipelineThresholds, ViolationCode } from '../blockTypes'

// ---------------------------------------------------------------------------
// Strategy
// ---------------------------------------------------------------------------

export type CorrectionStrategy =
  | 'compress_micro'
  | 'compress_rephrase'
  | 'compress_trim'
  | 'compress_core'
  | 'split_block'
  | 'borrow_gap'
  | 'offload_neighbor'

// 'accept' は通常の feasible strategy に含めない。
// コードがエスケープ条件を判定する際のみ使用する。

// ---------------------------------------------------------------------------
// CompressionTier
// ---------------------------------------------------------------------------

export type CompressionTier = 'none' | 'tiny' | 'small' | 'medium' | 'large' | 'extreme'

// ---------------------------------------------------------------------------
// DecisionMetrics
// ---------------------------------------------------------------------------

export interface DecisionMetrics {
  durationMs: number
  durationSec: number
  currentChars: number
  physicalMaxChars: number
  deficitChars: number
  overRatio: number
  requiredDurationMs: number
  missingDurationMs: number
  borrowableBeforeMs: number
  borrowableAfterMs: number
  totalBorrowableMs: number
  keepRatioNeeded: number
  reductionRatioNeeded: number
  splitViable: boolean
  borrowViable: boolean
  tier: CompressionTier
  tried: Set<CorrectionStrategy>
  failed: Set<CorrectionStrategy>
}

// ---------------------------------------------------------------------------
// CorrectionAttempt
// ---------------------------------------------------------------------------

export type SemanticCheckOutcome = 'passed' | 'borderline' | 'failed' | 'unavailable'

export interface CorrectionAttempt {
  strategy: CorrectionStrategy
  changed: boolean
  beforeChars: number
  afterChars: number
  beforeViolation: ViolationCode
  afterViolation: ViolationCode
  beforeTranscriptText?: string
  beforeSubtitleText?: string
  afterTranscriptText?: string
  afterSubtitleText?: string
  rationale?: string
  semanticSimilarity?: number
  semanticOutcome?: SemanticCheckOutcome
}

// ---------------------------------------------------------------------------
// TimelinePatch
// ---------------------------------------------------------------------------

export interface TimelinePatch {
  replaceBlocks: EnBlock[]
  updatedNeighborBlocks?: EnBlock[]
  consumedGaps?: {
    beforeMs?: number
    afterMs?: number
  }
  dirtyBlockIds: string[]
  warning?: string  // ツールが期待外の動作をした際の診断情報（LLM 実レスポンス等）
  changed: boolean
}

// ---------------------------------------------------------------------------
// AgentThresholds
// ---------------------------------------------------------------------------

export interface AgentThresholds {
  maxCorrectionRounds: number
  minMeaningfulChars: number
  minInterSubtitleGapMs: number
  minUsefulBorrowMs: number
  maxLeadMs: number
  maxLagMs: number
  minReductionDeltaChars: number
  minReductionDeltaRatio: number
  subtitleMinDurationSec: number
  maxSplitDepth: number
  enableOffloadNeighbor: boolean
  useAgentDecision: boolean
}

export const DEFAULT_AGENT_THRESHOLDS: AgentThresholds = {
  // ハイブリッド設計（hybrid_pipeline_design.md タスク10）で 7→4 に削減。
  // 4 ラウンドで救えない block は後続の coverage_repair_agent / general_repair_agent に
  // ハンドオフする方が経済的（reasoning 入りエージェントの方が安く解く可能性が高い）。
  maxCorrectionRounds: 4,
  minMeaningfulChars: 20,
  minInterSubtitleGapMs: 80,
  minUsefulBorrowMs: 250,
  maxLeadMs: 300,
  maxLagMs: 700,
  minReductionDeltaChars: 4,
  minReductionDeltaRatio: 0.03,
  subtitleMinDurationSec: 0.833,
  maxSplitDepth: 1,
  enableOffloadNeighbor: false,
  useAgentDecision: false,
}

export function buildAgentThresholds(
  overrides?: Partial<AgentThresholds>,
): AgentThresholds {
  return { ...DEFAULT_AGENT_THRESHOLDS, ...overrides }
}

// ---------------------------------------------------------------------------
// DecisionContext
// ---------------------------------------------------------------------------

export interface DecisionContext {
  block: EnBlock
  blockIndex: number
  prevBlock?: EnBlock
  nextBlock?: EnBlock
  gapBeforeMs: number
  gapAfterMs: number
  physicalMaxChars: number
  neighborSlack: {
    prev?: number
    next?: number
  }
  attemptHistory: CorrectionAttempt[]
  thresholds: PipelineThresholds & AgentThresholds
  settings: AdminSettings
  glossary?: Record<string, string>
  protectedTerms?: string[]
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export interface Tool {
  name: CorrectionStrategy
  description: string
  canApply(ctx: DecisionContext): boolean
  execute(
    block: EnBlock,
    ctx: DecisionContext,
    settings: AdminSettings,
    thresholds: PipelineThresholds & AgentThresholds,
  ): Promise<TimelinePatch>
}

// ---------------------------------------------------------------------------
// DecisionNode
// ---------------------------------------------------------------------------

export interface DecisionNode {
  decide(ctx: DecisionContext, feasible: CorrectionStrategy[]): Promise<CorrectionStrategy>
}
