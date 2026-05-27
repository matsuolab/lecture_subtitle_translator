import type { SubtitleBlock } from './subtitle'
import type { TranscriptSegment } from '@/lib/pipeline/types'

export type PipelineStep = 'idle' | 'transcribe' | 'correct' | 'translate' | 'subtitle' | 'done'

export type PipelineStatus = 'idle' | 'queued' | 'running' | 'success' | 'error'

export interface PipelineQualityMetrics {
  totalBlocks: number
  cpsViolationRate: number
  overLengthRate: number
  flaggedCount: number
}

export interface PipelineCostMetrics {
  inputTokens: number
  outputTokens: number
  estimatedUsd: number
  durationMs: number
}

export interface PipelineRunMetrics {
  quality: PipelineQualityMetrics
  cost: PipelineCostMetrics
}

export type PipelineReviewPriority = 'must_review' | 'should_review' | 'auto_pass'

export type PipelineReviewDisposition =
  | 'auto_pass'
  | 'auto_applied'
  | 'proposed'
  | 'manual_review'

export type PipelineReviewCategory =
  | 'timing'
  | 'readability'
  | 'line_length'
  | 'content'
  | 'terminology'
  | 'metadata'

export type PipelineProposalKind =
  | 'replace_text'
  | 'split_block'
  | 'merge_window'
  | 'retime'
  | 'verify_terms'

export interface PipelineReviewProposal {
  kind: PipelineProposalKind
  confidence: number
  rationale: string
}

export type PipelineSemanticCheckOutcome = 'passed' | 'borderline' | 'failed' | 'unavailable'

export interface PipelineCorrectionAttemptSummary {
  strategy: string
  changed: boolean
  beforeChars: number
  afterChars: number
  beforeViolation: string
  afterViolation: string
  beforeTranscriptText?: string
  beforeSubtitleText?: string
  afterTranscriptText?: string
  afterSubtitleText?: string
  rationale?: string
  // セマンティックチェック（log_only / enforce で記録）
  // before_en vs after_en の cosine similarity
  semanticSimilarity?: number
  // 判定（threshold との比較）
  semanticOutcome?: PipelineSemanticCheckOutcome
}

export interface PipelineReviewItem {
  id: string
  nodeId: string
  reason: string
  priority: PipelineReviewPriority
  disposition?: PipelineReviewDisposition
  score: number
  blockId?: number
  category?: PipelineReviewCategory
  title?: string
  action?: string
  details?: string[]
  proposal?: PipelineReviewProposal
  attempts?: PipelineCorrectionAttemptSummary[]
}

export interface PipelineNodeTrace {
  nodeId: string
  status: 'success' | 'failure'
  attempt: number
  durationMs: number
  provider: string
  model: string
  summary?: string
}

export interface PipelineAuditReport {
  mustReviewCount: number
  shouldReviewCount: number
  autoPassCount: number
  reviewItems: PipelineReviewItem[]
  nodeTraces: PipelineNodeTrace[]
}

export interface PipelineProgressEvent {
  at: number
  status: PipelineStatus
  step: PipelineStep
  message: string
  runId?: string
  currentNode?: string | null
  completedNodes?: string[]
  totalNodes?: number
  nodeElapsedSec?: number | null
}

export interface PipelineStageSnapshot {
  stage: string
  at: number
  itemCount: number
  items: Record<string, unknown>[]
}

/**
 * 1 回の LLM API 呼び出しに対応する usage 記録。
 * pipeline 実行中に各 LLM 呼出点が `pushLlmUsage` で 1 件ずつ push する。
 * PipelineRunDebug.llmUsage に集約され、後段で model 別に集計してコスト換算する。
 *
 * - cachedInputTokens は OpenAI prompt caching の cached portion（input の内数）
 * - reasoningTokens は推論モデルの reasoning tokens（output の内数として課金される）
 */
export interface PipelineLlmUsageRecord {
  /** 呼出元ノード識別子（例: 'translateEn', 'generalRepairAgent[attempt=1]'）*/
  nodeId: string
  /** 実際に API に投げられた model ID */
  model: string
  promptTokens: number
  completionTokens: number
  reasoningTokens?: number
  cachedInputTokens?: number
  /** API 呼出にかかった時間 (ms) */
  durationMs?: number
  /** unix epoch ms */
  at?: number
}

export interface PipelineRunDebug {
  sourceMedia?: {
    name: string
    path?: string
    mode?: string
  }
  settingsSnapshot?: Record<string, unknown>
  initialBlocks?: SubtitleBlock[]
  finalBlocks?: SubtitleBlock[]
  stageSnapshots?: PipelineStageSnapshot[]
  progressEvents: PipelineProgressEvent[]
  transcriptSegments?: TranscriptSegment[]
  transcriptMetadata?: Record<string, unknown>
  /**
   * 各 LLM API 呼出の usage 記録。コスト・トークン集計の単一情報源。
   * 既存の per-node trace / agent entry の usage と重複しても問題ない（こちらは集計用、
   * trace 側は per-attempt 詳細用に保持）。
   */
  llmUsage?: PipelineLlmUsageRecord[]
}

export interface PipelineRunResult {
  status: PipelineStatus
  step: PipelineStep
  message: string
  runId?: string
  sourceName?: string
  startedAt?: number
  finishedAt?: number
  metrics?: PipelineRunMetrics
  audit?: PipelineAuditReport
  debug?: PipelineRunDebug
}
