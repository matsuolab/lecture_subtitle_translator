import type {
  TranscriptSegment,
  CorrectedSegment,
  JapaneseSentenceBlock,
  EnglishBlock,
  PipelineSubtitleBlock,
  CpsViolation,
  SplitHint,
} from '@/lib/pipeline/types'

export type PipelineStep = 'idle' | 'transcribe' | 'correct' | 'translate' | 'subtitle' | 'done'

export type PipelineStatus = 'idle' | 'running' | 'success' | 'error'

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

// ---------------------------------------------------------------------------
// パイプライン完全実行ログ（トレーサビリティ用）
// ---------------------------------------------------------------------------

/** CPSループの1回の試行記録 */
export interface CpsAttemptLog {
  readonly attempt: number
  readonly splitHints: readonly SplitHint[]
  readonly splitJaOutput: readonly JapaneseSentenceBlock[]
  readonly translateEnOutput: readonly EnglishBlock[]
  readonly expandEnOutput: readonly EnglishBlock[]            // expandEn 後の状態
  readonly expandEnStats: ExpandEnStats                       // expandEn 統計
  readonly compressEnOutput: readonly EnglishBlock[]          // compressEn 後の状態
  readonly compressEnStats: CompressEnStats                   // compressEn 統計
  readonly splitEnOutput: readonly PipelineSubtitleBlock[]
  readonly violations: readonly CpsViolation[]
  readonly result: 'pass' | 'retry' | 'max_attempts_reached'
  readonly durationMs: number
}

/** expandEn ノードの統計 */
export interface ExpandEnStats {
  readonly total: number           // 全ブロック数
  readonly overCompressed: number  // over_compressed として検知
  readonly expanded: number        // EN/JA 比が目標に到達
  readonly flagged: number         // 3回後も EN/JA < 0.30
}

/** compressEn ノードの統計 */
export interface CompressEnStats {
  readonly total: number          // 全ブロック数
  readonly violating: number      // 行長超過（処理対象）
  readonly skippedLowCps: number  // CPS低すぎでスキップ
  readonly compressed: number     // 実際に圧縮成功
  readonly flagged: number        // translationFlagged になった数
}

/** splitLongBlock ノードの統計 */
export interface SplitLongBlockStats {
  readonly total: number          // 入力ブロック数
  readonly longSegments: number   // 対象 long_segment ブロック数
  readonly splitBlocks: number    // 「、」があり実際に分割したブロック数
  readonly skipped: number        // 「、」がなく分割不可だったブロック数
  readonly newBlocks: number      // 分割によって生成された新ブロック数
}

/**
 * 一回のパイプライン実行の完全ログ。
 * schemaVersion により将来の後方互換マイグレーションが可能。
 */
export interface PipelineRunLog {
  readonly schemaVersion: '1.0'
  readonly runId: string
  readonly startedAt: number
  readonly finishedAt: number
  readonly sourceFile: string
  readonly transcribeOutput: readonly TranscriptSegment[]
  readonly correctJaOutput: readonly CorrectedSegment[]
  readonly cpsAttempts: readonly CpsAttemptLog[]
  readonly splitLongBlockStats: SplitLongBlockStats    // Phase 2 後・finalQA 前に実行
  readonly finalBlocks: readonly PipelineSubtitleBlock[]
  readonly nodeTraces: readonly PipelineNodeTrace[]
}

export interface PipelineRunResult {
  status: PipelineStatus
  step: PipelineStep
  message: string
  sourceName?: string
  startedAt?: number
  finishedAt?: number
  metrics?: PipelineRunMetrics
  audit?: PipelineAuditReport
  /** 完全実行ログ（トレーサビリティ用）。成功時のみセット。 */
  log?: PipelineRunLog
}
