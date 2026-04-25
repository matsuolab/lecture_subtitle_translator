import { readFile } from '@tauri-apps/plugin-fs'
import type { AdminSettings } from '@/types/adminSettings'
import type { PipelineAuditReport, PipelineNodeTrace } from '@/types/pipeline'
import type { SubtitleBlock } from '@/types/subtitle'

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

interface LegacyPipelineResult {
  state?: {
    data?: {
      translated_segments?: BackendTranslatedSegment[]
      subtitle_blocks?: BackendSubtitleBlock[]
    }
  }
  audit?: BackendAudit
}

interface ManagedUploadResponse {
  upload_url?: string
  url?: string
  upload_method?: string
  method?: string
  upload_headers?: Record<string, string>
  headers?: Record<string, string>
  object_key?: string
  input_key?: string
}

interface ManagedJobStartResponse {
  job_id?: string
  id?: string
}

interface ManagedJobStatusResponse {
  job_id?: string
  id?: string
  status?: string
  current_step?: string
  current_node?: string
  completed_steps?: string[]
  completed_nodes?: string[]
  total_steps?: number
  total_nodes?: number
  step_elapsed_sec?: number
  node_elapsed_sec?: number
  error?: string
}

interface ManagedPipelineResult {
  translated_segments?: BackendTranslatedSegment[]
  subtitle_blocks?: BackendSubtitleBlock[]
  audit?: BackendAudit
}

const ENV_API_BASE = (import.meta.env.VITE_PIPELINE_API_URL as string | undefined)?.replace(/\/$/, '') ?? ''

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

export interface ManagedServiceConfig {
  service: string
  version: string
  upload: {
    strategy: string
    max_size_bytes?: number
  }
  jobs: {
    workflow: string
  }
}

export interface ServiceConnectionCheck {
  ok: boolean
  message: string
  config?: ManagedServiceConfig
}

export function hasConfiguredService(settings: AdminSettings): boolean {
  return resolveServiceBase(settings).length > 0
}

export const hasPipelineApi = hasConfiguredService

function resolveServiceBase(settings: AdminSettings): string {
  return settings.serviceUrl.trim().replace(/\/$/, '') || ENV_API_BASE
}

function buildAuthHeaders(settings: AdminSettings): Record<string, string> {
  const token = settings.serviceAuthToken.trim()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

function compactRecord<T extends Record<string, unknown>>(record: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== '' && value !== undefined && value !== null),
  ) as Partial<T>
}

function toResultEnvelope(result: LegacyPipelineResult | ManagedPipelineResult): LegacyPipelineResult {
  if ('state' in result) {
    return result
  }

  const managedResult = result as ManagedPipelineResult
  return {
    state: {
      data: {
        translated_segments: managedResult.translated_segments ?? [],
        subtitle_blocks: managedResult.subtitle_blocks ?? [],
      },
    },
    audit: managedResult.audit,
  }
}

function toSubtitleBlocks(result: LegacyPipelineResult | ManagedPipelineResult): SubtitleBlock[] {
  const normalized = toResultEnvelope(result)
  const translated: BackendTranslatedSegment[] = normalized?.state?.data?.translated_segments ?? []
  const subtitleRows: BackendSubtitleBlock[] = normalized?.state?.data?.subtitle_blocks ?? []
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

function toTraces(result: LegacyPipelineResult | ManagedPipelineResult): PipelineNodeTrace[] {
  const normalized = toResultEnvelope(result)
  const rows: BackendNodeTrace[] = normalized?.audit?.node_traces ?? []
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

function toAudit(result: LegacyPipelineResult | ManagedPipelineResult): PipelineAuditReport {
  const normalized = toResultEnvelope(result)
  const audit: BackendAudit = normalized?.audit ?? {}
  const reviewItems = (audit.review_items ?? []).map((item: BackendReviewItem) => ({
    id: String(item.id),
    nodeId: String(item.node_id),
    reason: String(item.reason),
    priority: (
      item.priority === 'must_review' || item.priority === 'should_review' || item.priority === 'auto_pass'
        ? item.priority
        : 'should_review'
    ) as 'must_review' | 'should_review' | 'auto_pass',
    score: Number(item.score ?? 0),
    blockId: item.block_id !== undefined ? Number(item.block_id) : undefined,
  }))

  return {
    mustReviewCount: Number(audit.must_review_count ?? 0),
    shouldReviewCount: Number(audit.should_review_count ?? 0),
    autoPassCount: Number(audit.auto_pass_count ?? 0),
    reviewItems,
    nodeTraces: toTraces(normalized),
  }
}

function normalizeProgressStatus(status: string | undefined): PipelineRunProgress['status'] {
  switch (status) {
    case 'queued':
    case 'running':
    case 'success':
    case 'failed':
    case 'cancelled':
      return status
    case 'succeeded':
      return 'success'
    case 'canceled':
      return 'cancelled'
    default:
      return 'running'
  }
}

async function pollLegacyStatus(apiBase: string, runId: string, settings: AdminSettings, onProgress?: (p: PipelineRunProgress) => void): Promise<void> {
  const intervalMs = 2000
  const deadline = Date.now() + 60 * 60 * 1000
  const authHeaders = buildAuthHeaders(settings)

  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, intervalMs))
    const res = await fetch(`${apiBase}/api/pipeline/runs/${runId}`, {
      headers: authHeaders,
    })
    if (!res.ok) throw new Error(`status poll failed: ${res.status}`)
    const data = await res.json()

    onProgress?.({
      runId,
      status: normalizeProgressStatus(data.status),
      currentNode: data.current_node ?? null,
      completedNodes: data.completed_nodes ?? [],
      totalNodes: data.total_nodes ?? 0,
      nodeElapsedSec: data.node_elapsed_sec ?? null,
    })

    if (data.status === 'success' || data.status === 'failed' || data.status === 'cancelled') return
  }

  throw new Error('pipeline polling timed out (1h)')
}

async function pollManagedStatus(apiBase: string, jobId: string, settings: AdminSettings, onProgress?: (p: PipelineRunProgress) => void): Promise<void> {
  const intervalMs = 2000
  const deadline = Date.now() + 60 * 60 * 1000
  const authHeaders = buildAuthHeaders(settings)

  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, intervalMs))
    const res = await fetch(`${apiBase}/v1/jobs/${jobId}`, {
      headers: authHeaders,
    })
    if (!res.ok) throw new Error(`managed job poll failed: ${res.status}`)
    const data: ManagedJobStatusResponse = await res.json()
    const status = normalizeProgressStatus(data.status)

    onProgress?.({
      runId: String(data.job_id ?? data.id ?? jobId),
      status,
      currentNode: data.current_step ?? data.current_node ?? null,
      completedNodes: data.completed_steps ?? data.completed_nodes ?? [],
      totalNodes: Number(data.total_steps ?? data.total_nodes ?? 0),
      nodeElapsedSec: data.step_elapsed_sec ?? data.node_elapsed_sec ?? null,
    })

    if (status === 'success' || status === 'failed' || status === 'cancelled') {
      if (status === 'failed' && data.error) {
        throw new Error(`managed job failed: ${data.error}`)
      }
      return
    }
  }

  throw new Error('managed service polling timed out (1h)')
}

async function uploadSourceToManagedService(apiBase: string, sourceName: string, sourcePath: string, settings: AdminSettings): Promise<string> {
  const authHeaders = buildAuthHeaders(settings)
  const uploadTargetRes = await fetch(`${apiBase}/v1/uploads`, {
    method: 'POST',
    headers: {
      ...authHeaders,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      filename: sourceName,
    }),
  })

  if (!uploadTargetRes.ok) {
    throw new Error(`upload target request failed: ${uploadTargetRes.status}`)
  }

  const uploadTarget: ManagedUploadResponse = await uploadTargetRes.json()
  const uploadUrl = uploadTarget.upload_url ?? uploadTarget.url
  const objectKey = uploadTarget.object_key ?? uploadTarget.input_key
  if (!uploadUrl || !objectKey) {
    throw new Error('managed upload target response is missing upload URL or object key')
  }

  const fileBytes = await readFile(sourcePath)
  const uploadRes = await fetch(uploadUrl, {
    method: (uploadTarget.upload_method ?? uploadTarget.method ?? 'PUT').toUpperCase(),
    headers: uploadTarget.upload_headers ?? uploadTarget.headers ?? {},
    body: new Uint8Array(fileBytes),
  })

  if (!uploadRes.ok) {
    throw new Error(`file upload failed: ${uploadRes.status}`)
  }

  return objectKey
}

async function runLegacyPipeline(
  apiBase: string,
  sourceName: string,
  settings: AdminSettings,
  sourcePath?: string,
  onProgress?: (p: PipelineRunProgress) => void,
): Promise<PipelineApiRunResult> {
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
    headers: {
      ...buildAuthHeaders(settings),
      'Content-Type': 'application/json',
    },
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

  await pollLegacyStatus(apiBase, runId, settings, onProgress)

  const resultRes = await fetch(`${apiBase}/api/pipeline/runs/${runId}/result`, {
    headers: buildAuthHeaders(settings),
  })
  if (!resultRes.ok) {
    throw new Error(`pipeline result failed: ${resultRes.status}`)
  }
  const result: LegacyPipelineResult = await resultRes.json()

  return {
    blocks: toSubtitleBlocks(result),
    traces: toTraces(result),
    audit: toAudit(result),
  }
}

async function runManagedPipeline(
  apiBase: string,
  sourceName: string,
  settings: AdminSettings,
  sourcePath?: string,
  onProgress?: (p: PipelineRunProgress) => void,
): Promise<PipelineApiRunResult> {
  if (!sourcePath) {
    throw new Error('managed service mode requires a local source file path')
  }

  const inputKey = await uploadSourceToManagedService(apiBase, sourceName, sourcePath, settings)
  const runtimeSettings = compactRecord({
    translation_provider: settings.translationProvider,
    openai_api_key: settings.openaiApiKey.trim(),
    gemini_api_key: settings.geminiApiKey.trim(),
    deepl_api_key: settings.deeplApiKey.trim(),
    openai_compatible_base_url: settings.openaiCompatibleBaseUrl.trim(),
    hf_token: settings.hfToken.trim(),
  })

  const startRes = await fetch(`${apiBase}/v1/jobs`, {
    method: 'POST',
    headers: {
      ...buildAuthHeaders(settings),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      source_name: sourceName,
      input_key: inputKey,
      workflow: 'drop_first_with_quality_v1',
      runtime_settings: runtimeSettings,
      execution_mode: 'production',
    }),
  })
  if (!startRes.ok) {
    throw new Error(`managed job start failed: ${startRes.status}`)
  }
  const started: ManagedJobStartResponse = await startRes.json()
  const jobId = String(started.job_id ?? started.id ?? '')
  if (!jobId) {
    throw new Error('managed job start response is missing job id')
  }

  await pollManagedStatus(apiBase, jobId, settings, onProgress)

  const resultRes = await fetch(`${apiBase}/v1/jobs/${jobId}/result`, {
    headers: buildAuthHeaders(settings),
  })
  if (!resultRes.ok) {
    throw new Error(`managed job result failed: ${resultRes.status}`)
  }
  const result: ManagedPipelineResult = await resultRes.json()

  return {
    blocks: toSubtitleBlocks(result),
    traces: toTraces(result),
    audit: toAudit(result),
  }
}

export async function runPipelineViaService(
  sourceName: string,
  settings: AdminSettings,
  sourcePath?: string,
  onProgress?: (p: PipelineRunProgress) => void,
): Promise<PipelineApiRunResult> {
  const apiBase = resolveServiceBase(settings)
  if (!apiBase) {
    throw new Error('service URL is not configured')
  }

  if (settings.serviceMode === 'managed_service') {
    return runManagedPipeline(apiBase, sourceName, settings, sourcePath, onProgress)
  }

  return runLegacyPipeline(apiBase, sourceName, settings, sourcePath, onProgress)
}

export const runPipelineViaApi = runPipelineViaService

export async function fetchManagedServiceConfig(settings: AdminSettings): Promise<ManagedServiceConfig> {
  const apiBase = resolveServiceBase(settings)
  if (!apiBase) {
    throw new Error('service URL is not configured')
  }

  const response = await fetch(`${apiBase}/v1/service-config`, {
    headers: buildAuthHeaders(settings),
  })
  if (!response.ok) {
    throw new Error(`service config request failed: ${response.status}`)
  }

  const json = await response.json() as ManagedServiceConfig
  return {
    service: String(json.service ?? 'unknown'),
    version: String(json.version ?? 'unknown'),
    upload: {
      strategy: String(json.upload?.strategy ?? 'unknown'),
      max_size_bytes: json.upload?.max_size_bytes,
    },
    jobs: {
      workflow: String(json.jobs?.workflow ?? 'unknown'),
    },
  }
}

export async function testServiceConnection(settings: AdminSettings): Promise<ServiceConnectionCheck> {
  try {
    if (settings.serviceMode === 'managed_service') {
      const config = await fetchManagedServiceConfig(settings)
      return {
        ok: true,
        message: `Connected: ${config.service} ${config.version}`,
        config,
      }
    }

    const apiBase = resolveServiceBase(settings)
    if (!apiBase) {
      throw new Error('service URL is not configured')
    }

    const response = await fetch(`${apiBase}/health`, {
      headers: buildAuthHeaders(settings),
    })
    if (!response.ok) {
      throw new Error(`health check failed: ${response.status}`)
    }

    return {
      ok: true,
      message: 'Connected: legacy pipeline health OK',
    }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'service connection failed',
    }
  }
}

