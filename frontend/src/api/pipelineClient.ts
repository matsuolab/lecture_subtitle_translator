import type { AdminSettings } from '@/types/adminSettings'
import type { PipelineAuditReport, PipelineNodeTrace } from '@/types/pipeline'
import type { SubtitleBlock } from '@/types/subtitle'

// バックエンドAPIレスポンスの型定義
interface BackendWordTimestamp {
  word?: string
  char?: string
  start?: number
  end?: number
  score?: number
}

interface BackendTranslatedSegment {
  id?: number
  start?: number
  end?: number
  text?: string
  ja_corrected?: string
  en?: string
  translated_text?: string
  translation_flagged?: boolean
}

interface BackendSubtitleBlock {
  start?: number
  end?: number
}

interface BackendNodeTrace {
  node_id?: string
  status?: string
  attempt?: number
  duration_ms?: number
  provider?: string
  model?: string
  error?: string
}

interface BackendReviewItem {
  id?: string
  node_id?: string
  reason?: string
  priority?: string
  score?: number
  block_id?: number
}

interface BackendAudit {
  must_review_count?: number
  should_review_count?: number
  auto_pass_count?: number
  review_items?: BackendReviewItem[]
  node_traces?: BackendNodeTrace[]
}

interface BackendPipelineResult {
  state?: {
    data?: {
      translated_segments?: BackendTranslatedSegment[]
      subtitle_blocks?: BackendSubtitleBlock[]
    }
  }
  audit?: BackendAudit
}

const ENV_API_BASE = (import.meta.env.VITE_PIPELINE_API_URL as string | undefined)?.replace(/\/$/, '') ?? ''

export function hasPipelineApi(settings: AdminSettings): boolean {
  return resolveApiBase(settings).length > 0
}

export interface PipelineApiRunResult {
  blocks: SubtitleBlock[]
  traces: PipelineNodeTrace[]
  audit: PipelineAuditReport
}

export interface PipelineRunProgress {
  runId: string
  status: 'queued' | 'running' | 'success' | 'failed' | 'cancelled'
  currentNode: string | null
  completedNodes: string[]
  totalNodes: number
  nodeElapsedSec: number | null
}

function resolveApiBase(settings: AdminSettings): string {
  return settings.pipelineApiUrl.trim().replace(/\/$/, '') || ENV_API_BASE
}

function compactRecord<T extends Record<string, unknown>>(record: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== '' && value !== undefined && value !== null),
  ) as Partial<T>
}

function toSubtitleBlocks(result: BackendPipelineResult): SubtitleBlock[] {
  const translated: BackendTranslatedSegment[] = result?.state?.data?.translated_segments ?? []
  const subtitleRows: BackendSubtitleBlock[] = result?.state?.data?.subtitle_blocks ?? []
  if (translated.length === 0) return []

  return translated.map((row, idx) => {
    const sub = subtitleRows[idx]
    const startTime = Number(sub?.start ?? row.start ?? 0)
    const endTime = Number(sub?.end ?? row.end ?? startTime + 2)
    const target = String(row.en ?? row.translated_text ?? '')
    const duration = Math.max(0.1, endTime - startTime)
    return {
      id: Number(row.id ?? idx + 1),
      startTime,
      endTime,
      source: String(row.ja_corrected ?? row.text ?? ''),
      target,
      cps: Math.round((target.length / duration) * 10) / 10,
      charCount: target.length,
      status: row.translation_flagged ? 'flagged' : 'pending',
      glossaryTerms: [],
    } as SubtitleBlock
  })
}

function toTraces(result: BackendPipelineResult): PipelineNodeTrace[] {
  const rows: BackendNodeTrace[] = result?.audit?.node_traces ?? []
  return rows.map((row) => ({
    nodeId: String(row.node_id),
    status: row.status === 'failure' ? 'failure' : 'success',
    attempt: Number(row.attempt ?? 1),
    durationMs: Number(row.duration_ms ?? 0),
    provider: String(row.provider ?? 'unknown'),
    model: String(row.model ?? 'unknown'),
    summary: row.error ? `error: ${row.error}` : undefined,
  }))
}

function toAudit(result: BackendPipelineResult): PipelineAuditReport {
  const audit: BackendAudit = result?.audit ?? {}
  const reviewItems = (audit.review_items ?? []).map((item: BackendReviewItem) => ({
    id: String(item.id),
    nodeId: String(item.node_id),
    reason: String(item.reason),
    priority: item.priority === 'must_review' || item.priority === 'should_review' || item.priority === 'auto_pass'
      ? item.priority
      : 'should_review',
    score: Number(item.score ?? 0),
    blockId: item.block_id !== undefined ? Number(item.block_id) : undefined,
  }))

  return {
    mustReviewCount: Number(audit.must_review_count ?? 0),
    shouldReviewCount: Number(audit.should_review_count ?? 0),
    autoPassCount: Number(audit.auto_pass_count ?? 0),
    reviewItems,
    nodeTraces: toTraces(result),
  }
}

async function pollStatus(apiBase: string, runId: string, onProgress?: (p: PipelineRunProgress) => void): Promise<void> {
  const INTERVAL_MS = 2000
  const MAX_WAIT_MS = 60 * 60 * 1000  // 1時間

  const deadline = Date.now() + MAX_WAIT_MS
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, INTERVAL_MS))
    const res = await fetch(`${apiBase}/api/pipeline/runs/${runId}`)
    if (!res.ok) throw new Error(`status poll failed: ${res.status}`)
    const data = await res.json()

    if (onProgress) {
      onProgress({
        runId,
        status: data.status,
        currentNode: data.current_node ?? null,
        completedNodes: data.completed_nodes ?? [],
        totalNodes: data.total_nodes ?? 0,
        nodeElapsedSec: data.node_elapsed_sec ?? null,
      })
    }

    if (data.status === 'success' || data.status === 'failed' || data.status === 'cancelled') return
  }
  throw new Error('pipeline polling timed out (1h)')
}

export async function runPipelineViaApi(
  sourceName: string,
  settings: AdminSettings,
  sourcePath?: string,
  onProgress?: (p: PipelineRunProgress) => void,
): Promise<PipelineApiRunResult> {
  const apiBase = resolveApiBase(settings)
  if (!apiBase) {
    throw new Error('pipeline API URL is not configured')
  }

  const runtimeSettings = compactRecord({
    translation_provider: settings.translationProvider,
    openai_api_key: settings.openaiApiKey.trim(),
    gemini_api_key: settings.geminiApiKey.trim(),
    deepl_api_key: settings.deeplApiKey.trim(),
    openai_compatible_base_url: settings.openaiCompatibleBaseUrl.trim(),
    hf_token: settings.hfToken.trim(),
  })

  const startRes = await fetch(`${apiBase}/api/pipeline/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workflow: 'drop_first_with_quality_v1',
      source_name: sourceName,
      initial_data: {
        source_name: sourceName,
        source_media_path: sourcePath,
        max_cps: 99,
        glossary_terms: [],
        semantic_score_override: 0.9,
        runtime_settings: runtimeSettings,
        execution_mode: 'production',
        allow_transcribe_fallback: false,
      },
    }),
  })
  if (!startRes.ok) {
    throw new Error(`pipeline start failed: ${startRes.status}`)
  }
  const started = await startRes.json()
  const runId = String(started.run_id)

  await pollStatus(apiBase, runId, onProgress)

  const resultRes = await fetch(`${apiBase}/api/pipeline/runs/${runId}/result`)
  if (!resultRes.ok) {
    throw new Error(`pipeline result failed: ${resultRes.status}`)
  }
  const result: BackendPipelineResult = await resultRes.json()

  return {
    blocks: toSubtitleBlocks(result),
    traces: toTraces(result),
    audit: toAudit(result),
  }
}

