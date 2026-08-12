import type { SubtitleBlock } from './subtitle'
import type { TranscriptSegment } from '@/lib/pipeline/types'
import type { AiGatewayProfileSnapshot } from '@/lib/aiGateway/apiCompatibilityProfile'
import type { SourceSegmentEvidence } from './sourceEvidence'

export type PipelineStep = 'idle' | 'transcribe' | 'correct' | 'translate' | 'subtitle' | 'done'

/**
 * 'cancelled' は次の2通りで付く:
 *   - ユーザーが中断ボタンを押して協調的キャンセルが完了した
 *   - 実行中のまま保存されたセッションを復元した（新しい画面プロセスでは実行継続がありえないため）
 * いずれも異常ではないので 'error' とは区別する。
 */
export type PipelineStatus = 'idle' | 'queued' | 'running' | 'success' | 'warning' | 'error' | 'cancelled'

export interface PipelineQualityMetrics {
  totalBlocks: number
  cpsViolationRate: number
  overLengthRate: number
  flaggedCount: number
}

export interface PipelineCostMetrics {
  inputTokens: number
  outputTokens: number
  reasoningTokens?: number
  cachedInputTokens?: number
  /** 価格表を持たないモデルでは推測せずnullにする。 */
  estimatedUsd: number | null
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

export interface PipelineSplitTimingDecision {
  basis: 'asr_constrained' | 'english_weighted_fallback'
  fallbackReason?: 'no_words' | 'asr_not_exact' | 'constraints_infeasible'
  matchRates?: number[]
  boundaryDeltasSec?: number[]
  spokenRanges?: Array<{ start: number; end: number }>
  displayRanges: Array<{ start: number; end: number }>
}

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
  /** split_blockの時刻根拠。本文の採否とは独立した監査情報。 */
  splitTiming?: PipelineSplitTimingDecision
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
  /** 現在応答待ちの LLM リクエスト数。ローカルパイプライン経路のみ埋まる（それ以外は undefined） */
  inFlightLlmCalls?: number
  /** 直近に LLM 応答が返ってからの経過秒数。1件も返っていない、または計測対象外の場合は null */
  secondsSinceLastLlmResponse?: number | null
}

export interface PipelineStageSnapshot {
  stage: string
  at: number
  itemCount: number
  items: Record<string, unknown>[]
}

export interface PipelineErrorInfo {
  message: string
  name?: string
  stack?: string
  raw?: string
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

/**
 * 1 回の LLM API 呼出失敗に対応するデバッグ記録。
 *
 * `detail` にはプロバイダの生のエラー応答本文（HTTP エラーボディそのもの、最大1000文字）を
 * 入れてよい。**この記録はデバッグ専用領域であり、字幕テキスト・`[UNTRANSLATED: ...]` マーカー・
 * translationFailureReason には決して流れない**（buildLlmFailureCode() が組み立てる短い
 * 分類コードのみが字幕側に出る、という既存の情報漏洩対策はこの記録の追加によって一切変わらない。
 * src/lib/aiGateway/llmErrorLog.ts の JSDoc、および errors.ts の buildLlmFailureCode 参照）。
 *
 * 本番事故の教訓: 以前は「字幕へ生応答本文を埋め込まない」対策を入れた際、デバッグ用途の
 * 詳細情報まで一緒に消えてしまい、http_400 の中身がエクスポートのどこにも残らなくなった。
 * このレコードはその診断可能性を、情報漏洩対策とは別の（UIに出さない）経路で復活させる。
 */
export interface PipelineLlmErrorRecord {
  /** unix epoch ms */
  at: number
  /** 呼出元ノード識別子（例: 'translateEn[batch]'）*/
  nodeName: string
  /** 実際に API に投げられた model ID */
  model: string
  httpStatus?: number
  /** src/lib/aiGateway/chatText.ts の LlmErrorCode、または 'param_compat_retry' 等の内部イベント名 */
  errorCode?: string
  /** プロバイダの生応答本文・例外メッセージ等（最大1000文字。llmErrorLog.ts で切り詰め済み）*/
  detail: string
}

export interface PipelineRunDebug {
  sourceMedia?: {
    name: string
    path?: string
    mode?: string
  }
  settingsSnapshot?: Record<string, unknown>
  aiGatewayProfiles?: AiGatewayProfileSnapshot
  initialBlocks?: SubtitleBlock[]
  finalBlocks?: SubtitleBlock[]
  stageSnapshots?: PipelineStageSnapshot[]
  progressEvents: PipelineProgressEvent[]
  transcriptSegments?: TranscriptSegment[]
  sourceEvidence?: SourceSegmentEvidence[]
  transcriptMetadata?: Record<string, unknown>
  errorInfo?: PipelineErrorInfo
  /**
   * 各 LLM API 呼出の usage 記録。コスト・トークン集計の単一情報源。
   * 既存の per-node trace / agent entry の usage と重複しても問題ない（こちらは集計用、
   * trace 側は per-attempt 詳細用に保持）。
   */
  llmUsage?: PipelineLlmUsageRecord[]
  /**
   * LLM API 呼出失敗のデバッグ記録（最大100件の有界バッファ。llmErrorLog.ts 参照）。
   * http_400 等、字幕側には短コード化されて出ない失敗の生の原因をここから追える。
   */
  llmErrors?: PipelineLlmErrorRecord[]
}

/**
 * 実行中ノードの LLM API 呼出アクティビティ。ローカルパイプライン経路の runNode ハートビート
 * (localPipeline.ts) 由来で、「時間のかかる段階を正常に処理中」なのか「フリーズしている」のかを
 * UI 側で判断するために使う。managed service 経路（リモートAPI）はこの値を埋めない。
 */
export interface PipelineRunLlmActivity {
  /** 現在応答待ちの LLM リクエスト数 */
  inFlightLlmCalls: number
  /** 直近に LLM 応答が返ってからの経過秒数。1件も返っていなければ null */
  secondsSinceLastLlmResponse: number | null
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
  llmActivity?: PipelineRunLlmActivity
}
