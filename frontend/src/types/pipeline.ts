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

export interface PipelineReviewItem {
  id: string
  nodeId: string
  reason: string
  priority: PipelineReviewPriority
  score: number
  blockId?: number
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

export interface PipelineRunDebug {
  sourceMedia?: {
    name: string
    path?: string
    mode?: string
  }
  settingsSnapshot?: Record<string, unknown>
  initialBlocks?: SubtitleBlock[]
  finalBlocks?: SubtitleBlock[]
  progressEvents: PipelineProgressEvent[]
  transcriptSegments?: TranscriptSegment[]
  transcriptMetadata?: Record<string, unknown>
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
