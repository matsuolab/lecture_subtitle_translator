import { readFile } from '@tauri-apps/plugin-fs'
import { invoke, isTauri } from '@tauri-apps/api/core'
import type { AdminSettings } from '@/types/adminSettings'
import { requireAiConnection } from '@/lib/pipeline/aiProvider'
import type { PipelineAuditReport, PipelineNodeTrace } from '@/types/pipeline'
import type { SubtitleBlock } from '@/types/subtitle'
import type { TranscriptSegment } from '@/lib/pipeline/types'
import { runLocalPostPipeline } from '@/lib/pipeline/localPipeline'

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

interface ManagedTranscriptResult {
  transcript_segments?: TranscriptSegment[]
  words?: unknown[]
  metadata?: Record<string, unknown>
}

interface WhisperxWord {
  word?: string
  start?: number
  end?: number
  score?: number
}

interface WhisperxSegment {
  start?: number
  end?: number
  text?: string
  words?: WhisperxWord[]
}

interface LocalWhisperxTranscriptResponse {
  segments?: WhisperxSegment[]
}

const ENV_API_BASE = (import.meta.env.VITE_PIPELINE_API_URL as string | undefined)?.replace(/\/$/, '') ?? ''

export interface PipelineApiRunResult {
  blocks: SubtitleBlock[]
  traces: PipelineNodeTrace[]
  audit: PipelineAuditReport
  debug?: {
    transcriptSegments?: TranscriptSegment[]
    transcriptMetadata?: Record<string, unknown>
    mode: 'managed_service' | 'legacy_pipeline'
  }
}

export interface PipelineRunProgress {
  runId: string
  status: 'queued' | 'running' | 'success' | 'failed' | 'cancelled'
  currentNode: string | null
  completedNodes: string[]
  totalNodes: number
  nodeElapsedSec: number | null
}

export interface PipelineSourceInput {
  path?: string
  file?: File
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

function validateTranslationSettings(settings: AdminSettings): void {
  requireAiConnection(settings)
}

export function hasConfiguredService(settings: AdminSettings): boolean {
  return resolveServiceBase(settings).length > 0
}

export const hasPipelineApi = hasConfiguredService

function resolveServiceBase(settings: AdminSettings): string {
  if (settings.serviceMode === 'legacy_pipeline') {
    const configured = settings.serviceUrl.trim().replace(/\/$/, '')
    if (configured) {
      try {
        const url = new URL(configured)
        if (url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost')) {
          return configured
        }
      } catch {
        // fall through to the default local transcript endpoint
      }
    }
    if (isTauri()) {
      return 'local'
    }
  }

  const configured = settings.serviceUrl.trim().replace(/\/$/, '')
  if (configured) return configured
  return ENV_API_BASE
}

function buildAuthHeaders(settings: AdminSettings): Record<string, string> {
  const token = settings.serviceAuthToken.trim()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

function formatFetchError(stage: string, error: unknown, extra?: string): Error {
  const suffix = extra ? ` (${extra})` : ''
  if (error instanceof Error) {
    return new Error(`${stage} failed${suffix}: ${error.message}`)
  }
  return new Error(`${stage} failed${suffix}`)
}

function compactRecord<T extends Record<string, unknown>>(record: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== '' && value !== undefined && value !== null),
  ) as Partial<T>
}

function toSubtitleBlocks(result: LegacyPipelineResult): SubtitleBlock[] {
  const translated: BackendTranslatedSegment[] = result?.state?.data?.translated_segments ?? []
  const subtitleRows: BackendSubtitleBlock[] = result?.state?.data?.subtitle_blocks ?? []
  if (translated.length === 0) return []

  return translated.map((row, idx) => {
    const sub = subtitleRows[idx]
    const startTime = Number(sub?.start ?? row.start ?? 0)
    const endTime = Number(sub?.end ?? row.end ?? startTime + 2)
    const source = String(row.en ?? row.translated_text ?? '')
    const duration = Math.max(0.1, endTime - startTime)
    return {
      id: Number(row.id ?? idx + 1),
      startTime,
      endTime,
      source,
      target: String(row.ja_corrected ?? row.text ?? ''),
      cps: Math.round((source.length / duration) * 10) / 10,
      charCount: source.length,
      status: row.translation_flagged ? 'flagged' : 'pending',
      glossaryTerms: [],
    } as SubtitleBlock
  })
}

function toAuditTraces(rows: BackendNodeTrace[]): PipelineNodeTrace[] {
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

function toTraces(result: LegacyPipelineResult): PipelineNodeTrace[] {
  const rows: BackendNodeTrace[] = result?.audit?.node_traces ?? []
  return toAuditTraces(rows)
}

function toAudit(result: LegacyPipelineResult): PipelineAuditReport {
  const audit: BackendAudit = result?.audit ?? {}
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
    nodeTraces: toTraces(result),
  }
}

function toManagedMetadataTraces(result: ManagedTranscriptResult): PipelineNodeTrace[] {
  const metadata = result.metadata ?? {}
  const rawRows = metadata.node_traces
  if (!Array.isArray(rawRows)) return []
  const rows = rawRows.filter((row): row is BackendNodeTrace => typeof row === 'object' && row !== null)
  return toAuditTraces(rows)
}

function buildManagedTranscriptError(jobId: string, result: ManagedTranscriptResult): Error {
  const metadata = result.metadata ?? {}
  const finalNode = typeof metadata.final_node === 'string' ? metadata.final_node : 'unknown'
  const workflow = typeof metadata.workflow === 'string' ? metadata.workflow : 'unknown'
  const detail = typeof metadata.error === 'string' && metadata.error.trim() ? metadata.error.trim() : 'transcript_segments is empty'
  return new Error(`managed transcript result is empty: ${detail} (job_id=${jobId}, workflow=${workflow}, final_node=${finalNode})`)
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
    let res: Response
    try {
      res = await fetch(`${apiBase}/v1/jobs/${jobId}`, {
        headers: authHeaders,
      })
    } catch (error) {
      throw formatFetchError('managed job polling request', error, `${apiBase}/v1/jobs/${jobId}`)
    }
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

async function uploadSourceToManagedService(
  apiBase: string,
  sourceName: string,
  sourceInput: PipelineSourceInput,
  settings: AdminSettings,
): Promise<string> {
  const authHeaders = buildAuthHeaders(settings)
  let uploadTargetRes: Response
  try {
    uploadTargetRes = await fetch(`${apiBase}/v1/uploads`, {
      method: 'POST',
      headers: {
        ...authHeaders,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        filename: sourceName,
      }),
    })
  } catch (error) {
    throw formatFetchError('managed upload target request', error, `${apiBase}/v1/uploads`)
  }

  if (!uploadTargetRes.ok) {
    throw new Error(`upload target request failed: ${uploadTargetRes.status}`)
  }

  const uploadTarget: ManagedUploadResponse = await uploadTargetRes.json()
  const uploadUrl = uploadTarget.upload_url ?? uploadTarget.url
  const objectKey = uploadTarget.object_key ?? uploadTarget.input_key
  if (!uploadUrl || !objectKey) {
    throw new Error('managed upload target response is missing upload URL or object key')
  }

  let uploadBody: ArrayBuffer
  if (sourceInput.path) {
    const fileBytes = await readFile(sourceInput.path)
    uploadBody = fileBytes.buffer.slice(fileBytes.byteOffset, fileBytes.byteOffset + fileBytes.byteLength)
  } else if (sourceInput.file) {
    uploadBody = await sourceInput.file.arrayBuffer()
  } else {
    throw new Error('managed service mode requires a local source file or file path')
  }

  let uploadRes: Response
  try {
    uploadRes = await fetch(uploadUrl, {
      method: (uploadTarget.upload_method ?? uploadTarget.method ?? 'PUT').toUpperCase(),
      headers: uploadTarget.upload_headers ?? uploadTarget.headers ?? {},
      body: uploadBody,
    })
  } catch (error) {
    const uploadHost = (() => {
      try {
        return new URL(uploadUrl).host
      } catch {
        return uploadUrl
      }
    })()
    throw formatFetchError('managed file upload', error, uploadHost)
  }

  if (!uploadRes.ok) {
    throw new Error(`file upload failed: ${uploadRes.status}`)
  }

  return objectKey
}

function normalizeLocalTranscriptResult(payload: LocalWhisperxTranscriptResponse): ManagedTranscriptResult {
  const rawSegments = Array.isArray(payload.segments) ? payload.segments : []
  const transcriptSegments: TranscriptSegment[] = rawSegments.map((segment, index) => ({
    id: index + 1,
    start: Number(segment.start ?? 0),
    end: Number(segment.end ?? segment.start ?? 0),
    text: String(segment.text ?? '').trim(),
    words: Array.isArray(segment.words)
      ? segment.words
          .filter((word) => word && word.start !== undefined && word.end !== undefined)
          .map((word) => ({
            word: String(word.word ?? ''),
            start: Number(word.start ?? 0),
            end: Number(word.end ?? 0),
            score: word.score !== undefined ? Number(word.score) : undefined,
          }))
      : [],
  }))

  const words = transcriptSegments.flatMap((segment) => segment.words ?? [])
  return {
    transcript_segments: transcriptSegments,
    words,
    metadata: {
      workflow: 'local_transcript_v1',
      final_node: 'transcribe',
      node_traces: [
        {
          node_id: 'transcribe',
          status: 'success',
          attempt: 1,
          duration_ms: 0,
          provider: 'local-docker-whisperx',
          model: 'whisperx',
        },
      ],
    },
  }
}

export async function runLegacyPipeline(
  apiBase: string,
  sourceName: string,
  settings: AdminSettings,
  sourcePath?: string,
  onProgress?: (p: PipelineRunProgress) => void,
): Promise<PipelineApiRunResult> {
  validateTranslationSettings(settings)
  const runtimeSettings = compactRecord({
    translation_provider: settings.translationProvider,
    openai_api_key: settings.openaiApiKey.trim(),
    gemini_api_key: settings.geminiApiKey.trim(),
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
    debug: {
      mode: 'legacy_pipeline',
    },
  }
}

async function runLocalTranscriptPipeline(
  _apiBase: string,
  _sourceName: string,
  settings: AdminSettings,
  sourceInput?: PipelineSourceInput,
  onProgress?: (p: PipelineRunProgress) => void,
): Promise<PipelineApiRunResult> {
  if (!isTauri()) {
    throw new Error('ローカルWhisperX転写はTauriデスクトップアプリでのみ利用可能です')
  }
  if (!sourceInput?.path) {
    throw new Error('local transcript mode requires a local file path')
  }
  validateTranslationSettings(settings)

  onProgress?.({
    runId: 'local-transcript',
    status: 'running',
    currentNode: 'extract_audio',
    completedNodes: [],
    totalNodes: 0,
    nodeElapsedSec: null,
  })
  const audioPath = await invoke<string>('extract_audio', { videoPath: sourceInput.path }).catch(
    (e: unknown) => { throw new Error(`音声抽出失敗: ${String(e)}`) },
  )

  onProgress?.({
    runId: 'local-transcript',
    status: 'running',
    currentNode: 'transcribe',
    completedNodes: ['extract_audio'],
    totalNodes: 1,
    nodeElapsedSec: null,
  })

  const t0 = Date.now()
  const whisperxPayload = await invoke<LocalWhisperxTranscriptResponse>('transcribe_local', {
    audioPath,
    language: 'ja',
  }).catch((e: unknown) => { throw new Error(`転写失敗: ${String(e)}`) })
  const result = normalizeLocalTranscriptResult(whisperxPayload)
  const managedTraces = toManagedMetadataTraces(result).map((trace) =>
    trace.nodeId === 'transcribe' ? { ...trace, durationMs: Date.now() - t0, model: 'whisperx-local' } : trace,
  )

  const transcriptSegments = result.transcript_segments ?? []
  if (transcriptSegments.length === 0) {
    throw buildManagedTranscriptError('local-transcript', result)
  }

  onProgress?.({
    runId: 'local-transcript',
    status: 'running',
    currentNode: 'local_postprocess',
    completedNodes: ['transcribe'],
    totalNodes: managedTraces.length + 8,
    nodeElapsedSec: null,
  })

  const localResult = await runLocalPostPipeline(
    transcriptSegments,
    settings,
    (step) =>
      onProgress?.({
        runId: 'local-transcript',
        status: 'running',
        currentNode: step,
        completedNodes: managedTraces.map((trace) => trace.nodeId),
        totalNodes: managedTraces.length + 8,
        nodeElapsedSec: null,
      }),
  )

  const traces = [...managedTraces, ...localResult.traces]
  return {
    blocks: localResult.blocks,
    traces,
    audit: {
      ...localResult.audit,
      nodeTraces: traces,
    },
    debug: {
      transcriptSegments,
      transcriptMetadata: result.metadata,
      mode: 'legacy_pipeline',
    },
  }
}

async function runManagedPipeline(
  apiBase: string,
  sourceName: string,
  settings: AdminSettings,
  sourceInput?: PipelineSourceInput,
  onProgress?: (p: PipelineRunProgress) => void,
): Promise<PipelineApiRunResult> {
  if (!sourceInput?.path && !sourceInput?.file) {
    throw new Error('managed service mode requires a local source file or file path')
  }
  validateTranslationSettings(settings)

  // Tauri 環境かつローカルパスがある場合: 動画から音声のみ抽出してアップロード
  let uploadInput: PipelineSourceInput = sourceInput!
  if (isTauri() && sourceInput?.path) {
    onProgress?.({
      runId: '',
      status: 'running',
      currentNode: 'extract_audio',
      completedNodes: [],
      totalNodes: 0,
      nodeElapsedSec: null,
    })
    const audioPath = await invoke<string>('extract_audio', { videoPath: sourceInput.path })
    uploadInput = { path: audioPath }
  }

  const inputKey = await uploadSourceToManagedService(apiBase, sourceName, uploadInput, settings)

  let startRes: Response
  try {
    startRes = await fetch(`${apiBase}/v1/jobs`, {
      method: 'POST',
      headers: {
        ...buildAuthHeaders(settings),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        source_name: sourceName,
        input_key: inputKey,
        execution_mode: 'production',
      }),
    })
  } catch (error) {
    throw formatFetchError('managed job start request', error, `${apiBase}/v1/jobs`)
  }
  if (!startRes.ok) {
    throw new Error(`managed job start failed: ${startRes.status}`)
  }
  const started: ManagedJobStartResponse = await startRes.json()
  const jobId = String(started.job_id ?? started.id ?? '')
  if (!jobId) {
    throw new Error('managed job start response is missing job id')
  }

  onProgress?.({
    runId: jobId,
    status: 'queued',
    currentNode: 'queued',
    completedNodes: [],
    totalNodes: 0,
    nodeElapsedSec: null,
  })

  await pollManagedStatus(apiBase, jobId, settings, onProgress)

  let resultRes: Response
  try {
    resultRes = await fetch(`${apiBase}/v1/jobs/${jobId}/result`, {
      headers: buildAuthHeaders(settings),
    })
  } catch (error) {
    throw formatFetchError('managed job result request', error, `${apiBase}/v1/jobs/${jobId}/result`)
  }
  if (!resultRes.ok) {
    throw new Error(`managed job result failed: ${resultRes.status}`)
  }
  const result: ManagedTranscriptResult = await resultRes.json()
  const managedTraces = toManagedMetadataTraces(result)

  const transcriptSegments = result.transcript_segments ?? []
  if (transcriptSegments.length > 0) {
    const localStepCountEstimate = 8
    onProgress?.({
      runId: jobId,
      status: 'running',
      currentNode: 'local_postprocess',
      completedNodes: [],
      totalNodes: managedTraces.length + localStepCountEstimate,
      nodeElapsedSec: null,
    })
    const localResult = await runLocalPostPipeline(
      transcriptSegments,
      settings,
      (step) =>
        onProgress?.({
          runId: jobId,
          status: 'running',
          currentNode: step,
          completedNodes: managedTraces.map((trace) => trace.nodeId),
          totalNodes: managedTraces.length + localStepCountEstimate,
          nodeElapsedSec: null,
        }),
    )
    const traces = [...managedTraces, ...localResult.traces]
    return {
      blocks: localResult.blocks,
      traces,
      audit: {
        ...localResult.audit,
        nodeTraces: traces,
      },
      debug: {
        transcriptSegments,
        transcriptMetadata: result.metadata,
        mode: 'managed_service',
      },
    }
  }

  throw buildManagedTranscriptError(jobId, result)
}

export async function runPipelineViaService(
  sourceName: string,
  settings: AdminSettings,
  sourceInput?: PipelineSourceInput,
  onProgress?: (p: PipelineRunProgress) => void,
): Promise<PipelineApiRunResult> {
  const apiBase = resolveServiceBase(settings)
  if (!apiBase) {
    throw new Error('service URL is not configured')
  }

  if (settings.serviceMode === 'managed_service') {
    return runManagedPipeline(apiBase, sourceName, settings, sourceInput, onProgress)
  }
  return runLocalTranscriptPipeline(apiBase, sourceName, settings, sourceInput, onProgress)
}

export const runPipelineViaApi = runPipelineViaService

const CONNECTION_TEST_TIMEOUT_MS = 10_000

async function readBodySnippet(response: Response): Promise<string> {
  try {
    const text = await response.text()
    const trimmed = text.trim()
    if (!trimmed) return ''
    return trimmed.length > 300 ? `${trimmed.slice(0, 300)}…` : trimmed
  } catch {
    return ''
  }
}

function describeFetchFailure(stage: string, url: string, error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'AbortError') {
      return `${stage}: aborted (${url})`
    }
    // ブラウザの fetch は CORS / DNS / connection refused を区別せず "Failed to fetch" を返す
    return `${stage}: ${error.message} (${url}) — DNS/CORS/接続拒否のいずれか。ブラウザ DevTools の Network タブを確認してください`
  }
  return `${stage}: ${String(error)} (${url})`
}

export async function testServiceConnection(settings: AdminSettings, signal?: AbortSignal): Promise<ServiceConnectionCheck> {
  const timeout = AbortSignal.timeout(CONNECTION_TEST_TIMEOUT_MS)
  const combined = signal
    ? AbortSignal.any([signal, timeout])
    : timeout

  try {
    const apiBase = resolveServiceBase(settings)
    if (!apiBase) {
      throw new Error('Service URL が未設定です')
    }

    if (settings.serviceMode === 'managed_service') {
      // ─── Stage 1: URL 到達確認 (認証不要の /health) ───────────────
      const healthUrl = `${apiBase}/health`
      let healthRes: Response
      try {
        healthRes = await fetch(healthUrl, {
          signal: combined,
          cache: 'no-store',
        })
      } catch (networkError) {
        throw new Error(`[URL到達不可] ${describeFetchFailure('GET /health', healthUrl, networkError)}`)
      }
      if (!healthRes.ok) {
        const body = await readBodySnippet(healthRes)
        throw new Error(
          `[URL到達不可] GET ${healthUrl} → HTTP ${healthRes.status}${body ? ` / body: ${body}` : ''}`,
        )
      }

      // ─── Stage 2: 認証確認 (要認証の /v1/service-config) ──────────
      const configUrl = `${apiBase}/v1/service-config`
      const hasToken = settings.serviceAuthToken.trim().length > 0
      let configRes: Response
      try {
        configRes = await fetch(configUrl, {
          headers: buildAuthHeaders(settings),
          signal: combined,
          cache: 'no-store',
        })
      } catch (networkError) {
        throw new Error(`[認証確認失敗] ${describeFetchFailure('GET /v1/service-config', configUrl, networkError)}`)
      }

      if (configRes.status === 401 || configRes.status === 403) {
        const body = await readBodySnippet(configRes)
        const tokenHint = hasToken
          ? 'Service Auth Token の値が一致していません'
          : 'Service Auth Token が空です。サーバーが認証を要求しています'
        throw new Error(
          `[Token無効] ${tokenHint} (GET ${configUrl} → HTTP ${configRes.status}${body ? ` / body: ${body}` : ''})`,
        )
      }

      if (!configRes.ok) {
        const body = await readBodySnippet(configRes)
        throw new Error(
          `[サーバーエラー] GET ${configUrl} → HTTP ${configRes.status}${body ? ` / body: ${body}` : ''}`,
        )
      }

      // 認証無しでも 200 が返るサーバーは古い実装（認証チェック未実装）
      // ここではユーザーが入力した Token が "実際に検証されたか" を一応注意喚起
      const config = await configRes.json() as ManagedServiceConfig
      const normalized: ManagedServiceConfig = {
        service: String(config.service ?? 'unknown'),
        version: String(config.version ?? 'unknown'),
        upload: {
          strategy: String(config.upload?.strategy ?? 'unknown'),
          max_size_bytes: config.upload?.max_size_bytes,
        },
        jobs: {
          workflow: String(config.jobs?.workflow ?? 'unknown'),
        },
      }
      return {
        ok: true,
        message: `OK: URL到達 + 認証通過 (${normalized.service} ${normalized.version})`,
        config: normalized,
      }
    }

    if (!isTauri()) {
      throw new Error('ローカルWhisperX転写はTauriデスクトップアプリでのみ利用可能です')
    }
    const message = await invoke<string>('check_local_whisperx')
    return { ok: true, message }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      const isTimeout = !signal?.aborted
      return {
        ok: false,
        message: isTimeout ? `接続タイムアウト (${CONNECTION_TEST_TIMEOUT_MS / 1000}秒)` : 'キャンセルされました',
      }
    }
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error || 'service connection failed'),
    }
  }
}
