import { invoke, isTauri } from '@tauri-apps/api/core'
import { tauriFetch, type TauriFetchResponse } from '@/lib/tauriFetch'
import type { AdminSettings } from '@/types/adminSettings'
import { requireAiConnection } from '@/lib/pipeline/aiProvider'
import { resetLlmConcurrency, setLlmConcurrencyLimit } from '@/lib/aiGateway/llmConcurrency'
import { resetLmStudioContextLengthCache } from '@/lib/aiGateway/lmStudioContextLength'
import { getLlmErrorLog, resetLlmErrorLog } from '@/lib/aiGateway/llmErrorLog'
import { resetParamCompat } from '@/lib/aiGateway/paramCompat'
import { setCurrentPipelineAbortController } from '@/lib/pipeline/pipelineAbort'
import { createLlmUsageSink, setCurrentLlmUsageSink } from '@/lib/pipeline/llmUsageSink'
import type { PipelineAuditReport, PipelineLlmErrorRecord, PipelineLlmUsageRecord, PipelineNodeTrace, PipelineStageSnapshot } from '@/types/pipeline'
import type { SubtitleBlock } from '@/types/subtitle'
import type { TranscriptSegment } from '@/lib/pipeline/types'
import {
  getLocalPipelineDebugFailure,
  runLocalPostPipeline,
  type LocalPipelineGlossary,
  type LocalPipelineProgressDetail,
} from '@/lib/pipeline/localPipeline'

interface BackendNodeTrace {
  node_id?: string
  status?: string
  attempt?: number
  duration_ms?: number
  provider?: string
  model?: string
  error?: string
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

function attachPipelineClientDebug(
  error: unknown,
  debug: NonNullable<PipelineApiRunResult['debug']>,
): Error {
  const err = error instanceof Error ? error : new Error(String(error))
  Object.assign(err, { pipelineClientDebug: debug })
  return err
}

/**
 * runPipelineViaApi の finally 直前で、その回の実行で集まった llmErrors / llmUsage を
 * 失敗時に伝播する Error へマージして付与する。
 *
 * 既に attachPipelineClientDebug 等で pipelineClientDebug が付いている場合（localPipeline
 * の失敗経路の大半はこちら）は、その内容を保ったまま llmErrors / llmUsage だけ追記する。
 * 何も付いていない場合（設定不備等、どのノードも実行されずに落ちた早期失敗）は llmErrors /
 * llmUsage だけを持つ最小限のオブジェクトを付与する（この場合は空配列になるだけで実害はない）。
 */
function attachLlmDebugToError(
  error: unknown,
  llmErrors: PipelineLlmErrorRecord[],
  llmUsage: PipelineLlmUsageRecord[],
): Error {
  const err = error instanceof Error ? error : new Error(String(error))
  const existing = (err as unknown as Record<string, unknown>).pipelineClientDebug
  const merged = existing && typeof existing === 'object'
    ? { ...(existing as Record<string, unknown>), llmErrors, llmUsage }
    : { llmErrors, llmUsage }
  Object.assign(err, { pipelineClientDebug: merged })
  return err
}

export interface PipelineApiRunResult {
  blocks: SubtitleBlock[]
  traces: PipelineNodeTrace[]
  audit: PipelineAuditReport
  debug?: {
    transcriptSegments?: TranscriptSegment[]
    transcriptMetadata?: Record<string, unknown>
    traces?: PipelineNodeTrace[]
    stageSnapshots?: PipelineStageSnapshot[]
    mode: 'managed_service' | 'legacy_pipeline'
    /**
     * 各 LLM API 呼出の usage 記録（llmUsageSink.ts 参照）。runPipelineViaApi が実行終了時に
     * sink から回収して埋める。
     */
    llmUsage?: PipelineLlmUsageRecord[]
    /**
     * LLM API 呼出失敗のデバッグ記録（llmErrorLog.ts 参照）。runPipelineViaApi が実行終了時に
     * 回収して埋める。字幕テキストには一切流れないデバッグ専用の記録（PipelineLlmErrorRecord
     * の JSDoc 参照）。
     */
    llmErrors?: PipelineLlmErrorRecord[]
  }
}

export interface PipelineRunProgress {
  runId: string
  status: 'queued' | 'running' | 'success' | 'failed' | 'cancelled'
  currentNode: string | null
  completedNodes: string[]
  totalNodes: number
  nodeElapsedSec: number | null
  /**
   * 現在応答待ちの LLM リクエスト数。ローカルパイプライン経路のみ埋まる
   * （runLocalPostPipeline のハートビートが返す detail 由来）。managed service 経路（リモート
   * API 経由でジョブをポーリングするだけ）はこの値を持たないため、常に optional として扱う。
   */
  inFlightLlmCalls?: number
  /**
   * 直近に LLM 応答が返ってからの経過秒数。1件も返っていない、またはこの経路で計測していない
   * 場合は null。inFlightLlmCalls と同様、ローカルパイプライン経路のみ埋まる。
   */
  secondsSinceLastLlmResponse?: number | null
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

interface ManagedConnectionCheck extends ManagedServiceConfig {
  ok: boolean
  checks: Array<{
    name: string
    ok: boolean
    detail?: string
  }>
}

export interface ServiceConnectionCheck {
  ok: boolean
  message: string
  config?: ManagedServiceConfig
}

function validateTranslationSettings(settings: AdminSettings): void {
  requireAiConnection(settings)
}

export function hasPipelineApi(settings: AdminSettings): boolean {
  return resolveServiceBase(settings).length > 0
}

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
  if (!token) return {}
  return { Authorization: token.toLowerCase().startsWith('bearer ') ? token : `Bearer ${token}` }
}

function getFetchRuntimeContext(): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : 'unknown-origin'
  const userAgent = typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown-user-agent'
  return `origin=${origin}; userAgent=${userAgent}`
}

function normalizeFetchTarget(target?: string): string {
  if (!target) return ''
  try {
    const url = new URL(target)
    return `${url.protocol}//${url.host}${url.pathname}`
  } catch {
    return target
  }
}

function formatFetchError(stage: string, error: unknown, extra?: string): Error {
  const target = normalizeFetchTarget(extra)
  const suffix = target ? ` (${target})` : ''
  const context = getFetchRuntimeContext()
  const hint = 'HTTPレスポンス前に失敗しました。CORS、DNS/TLS、WebKitのネットワーク制限、またはService URLを確認してください。'
  if (error instanceof Error) {
    return new Error(`${stage} failed${suffix}: ${error.name}: ${error.message} / ${hint} / ${context}`)
  }
  return new Error(`${stage} failed${suffix}: ${String(error || 'unknown error')} / ${hint} / ${context}`)
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

/**
 * runLocalPostPipeline の onStep(step, detail) から PipelineRunProgress を組み立てる。
 * ローカルパイプライン経路の2箇所（runLocalTranscriptPipeline / runManagedPipeline）で
 * 同じ変換ロジックが重複していたため関数として切り出した。単体テストしやすくする狙いもある
 * （detail 無し = ノード開始直後の通知、detail 有り = ハートビート由来の進捗）。
 */
export function buildLocalPipelineProgress(
  base: Pick<PipelineRunProgress, 'runId' | 'completedNodes' | 'totalNodes'>,
  step: string,
  detail: LocalPipelineProgressDetail | undefined,
): PipelineRunProgress {
  return {
    ...base,
    status: 'running',
    currentNode: step,
    nodeElapsedSec: detail?.elapsedSec ?? null,
    inFlightLlmCalls: detail?.inFlightLlmCalls,
    secondsSinceLastLlmResponse: detail?.secondsSinceLastLlmResponse,
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

  const uploadMethod = (uploadTarget.upload_method ?? uploadTarget.method ?? 'PUT').toUpperCase()
  const uploadHeaders = uploadTarget.upload_headers ?? uploadTarget.headers ?? {}
  const uploadHost = (() => {
    try {
      return new URL(uploadUrl).host
    } catch {
      return uploadUrl
    }
  })()

  // Tauri + ローカルパス: Rust経由でアップロード（ブラウザCORSを迂回、メモリも消費しない）
  // S3はtauri://オリジンを拒否するため、JSのfetchではLinux/Macで失敗する
  if (sourceInput.path) {
    let uploadRes: TauriFetchResponse
    try {
      uploadRes = await tauriFetch(uploadUrl, {
        method: uploadMethod,
        headers: uploadHeaders,
        filePath: sourceInput.path,
      })
    } catch (error) {
      throw formatFetchError('managed file upload', error, uploadHost)
    }
    if (!uploadRes.ok) {
      throw new Error(`file upload failed: ${uploadRes.status}`)
    }
    return objectKey
  }

  // Web/dev環境（File オブジェクトのみ）: 通常のfetchでブラウザからPUT
  if (!sourceInput.file) {
    throw new Error('managed service mode requires a local source file or file path')
  }

  let uploadRes: Response
  try {
    uploadRes = await fetch(uploadUrl, {
      method: uploadMethod,
      headers: uploadHeaders,
      body: await sourceInput.file.arrayBuffer(),
    })
  } catch (error) {
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


async function runLocalTranscriptPipeline(
  _apiBase: string,
  _sourceName: string,
  settings: AdminSettings,
  sourceInput?: PipelineSourceInput,
  onProgress?: (p: PipelineRunProgress) => void,
  glossary?: LocalPipelineGlossary,
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
    language: settings.transcribeLanguageCode,
  }).catch((e: unknown) => { throw new Error(`転写失敗: ${String(e)}`) })
  const result = normalizeLocalTranscriptResult(whisperxPayload)
  const managedTraces = toManagedMetadataTraces(result).map((trace) =>
    trace.nodeId === 'transcribe' ? { ...trace, durationMs: Date.now() - t0, model: 'whisperx-local' } : trace,
  )

  const transcriptSegments = result.transcript_segments ?? []
  if (transcriptSegments.length === 0) {
    throw attachPipelineClientDebug(buildManagedTranscriptError('local-transcript', result), {
      transcriptSegments,
      transcriptMetadata: result.metadata,
      traces: managedTraces,
      mode: 'legacy_pipeline',
    })
  }

  onProgress?.({
    runId: 'local-transcript',
    status: 'running',
    currentNode: 'local_postprocess',
    completedNodes: ['transcribe'],
    totalNodes: managedTraces.length + 8,
    nodeElapsedSec: null,
  })

  let localResult
  try {
    localResult = await runLocalPostPipeline(
      transcriptSegments,
      settings,
      (step, detail) =>
        onProgress?.(buildLocalPipelineProgress(
          {
            runId: 'local-transcript',
            completedNodes: managedTraces.map((trace) => trace.nodeId),
            totalNodes: managedTraces.length + 8,
          },
          step,
          detail,
        )),
      glossary,
    )
  } catch (error) {
    const failure = getLocalPipelineDebugFailure(error)
    throw attachPipelineClientDebug(error, {
      transcriptSegments,
      transcriptMetadata: result.metadata,
      traces: [...managedTraces, ...(failure.traces ?? [])],
      stageSnapshots: failure.stageSnapshots,
      mode: 'legacy_pipeline',
    })
  }

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
      stageSnapshots: localResult.stageSnapshots,
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
  glossary?: LocalPipelineGlossary,
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
    const audioPath = await invoke<string>('extract_audio', { videoPath: sourceInput.path }).catch(
      (e: unknown) => { throw new Error(`音声抽出失敗(managed): ${String(e)}`) },
    )
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
    let localResult
    try {
      localResult = await runLocalPostPipeline(
        transcriptSegments,
        settings,
        (step, detail) =>
          onProgress?.(buildLocalPipelineProgress(
            {
              runId: jobId,
              completedNodes: managedTraces.map((trace) => trace.nodeId),
              totalNodes: managedTraces.length + localStepCountEstimate,
            },
            step,
            detail,
          )),
        glossary,
      )
    } catch (error) {
      const failure = getLocalPipelineDebugFailure(error)
      throw attachPipelineClientDebug(error, {
        transcriptSegments,
        transcriptMetadata: result.metadata,
        traces: [...managedTraces, ...(failure.traces ?? [])],
        stageSnapshots: failure.stageSnapshots,
        mode: 'managed_service',
      })
    }
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
        stageSnapshots: localResult.stageSnapshots,
        mode: 'managed_service',
      },
    }
  }

  throw attachPipelineClientDebug(buildManagedTranscriptError(jobId, result), {
    transcriptSegments,
    transcriptMetadata: result.metadata,
    traces: managedTraces,
    mode: 'managed_service',
  })
}

export async function runPipelineViaApi(
  sourceName: string,
  settings: AdminSettings,
  sourceInput?: PipelineSourceInput,
  onProgress?: (p: PipelineRunProgress) => void,
  glossary?: LocalPipelineGlossary,
): Promise<PipelineApiRunResult> {
  const apiBase = resolveServiceBase(settings)
  if (!apiBase) {
    throw new Error('service URL is not configured')
  }

  // 中断シグナルの生存期間はこの関数の実行中だけ。finally での解放を絶対に落とさないこと
  // （解放漏れは「次回実行が開始直後に中断される」＝アプリが実行不能になる事故に直結する）。
  const abortController = new AbortController()
  setCurrentPipelineAbortController(abortController)
  // gateway 層の全体同時実行数セマフォの上限をここで設定する。ノード単体の並列制御
  // （mapWithConcurrency）だけでは、再帰的な追加 LLM 呼出（半割リトライ等）がノードの並列枠の
  // 外側で増殖してしまうため（llmConcurrency.ts のコメント参照）。abortController と同じく、
  // finally での解放（resetLlmConcurrency）を絶対に落とさないこと
  // （解放漏れは待機中の Promise が残留し、次回実行のスロット確保が正しく動かなくなる事故に直結する）。
  setLlmConcurrencyLimit(settings.apiRequestConcurrency)
  // 前回実行のキャッシュが残らないよう、実行開始時にも必ずクリアする
  // （lmStudioContextLength.ts のコメント参照。モデル単位でキャッシュするため、前回実行と
  // 今回実行で同じモデルでもロード条件が変わりうる＝キャッシュを持ち越してはいけない）。
  resetLmStudioContextLengthCache()
  // 前回実行のデバッグ記録・学習結果を持ち越さない（llmErrorLog.ts / paramCompat.ts の
  // JSDoc「運用ルール」参照）。
  resetLlmErrorLog()
  resetParamCompat()
  // llmUsage sink の配線。setCurrentLlmUsageSink() を呼ぶ箇所がこれまで存在せず、各 LLM 呼出の
  // safePush(getCurrentLlmUsageSink(), ...) が常に no-op になっていた（PipelineRunDebug.llmUsage
  // が常に0件だったバグの原因。llmUsageSink.ts の JSDoc「運用ルール」参照）。
  const llmUsageSink = createLlmUsageSink()
  setCurrentLlmUsageSink(llmUsageSink)
  try {
    const result = settings.serviceMode === 'managed_service'
      ? await runManagedPipeline(apiBase, sourceName, settings, sourceInput, onProgress, glossary)
      : await runLocalTranscriptPipeline(apiBase, sourceName, settings, sourceInput, onProgress, glossary)
    // 実行終了時に debug 用の器（llmErrorLog / llmUsageSink）から回収し、既存の
    // stageSnapshots 等と同じ debug オブジェクトに載せる（App.tsx がここから
    // pipelineRun.debug 経由でエクスポートまで運ぶ）。
    return {
      ...result,
      debug: result.debug
        ? { ...result.debug, llmErrors: getLlmErrorLog(), llmUsage: llmUsageSink.records() }
        : { mode: settings.serviceMode === 'managed_service' ? 'managed_service' : 'legacy_pipeline', llmErrors: getLlmErrorLog(), llmUsage: llmUsageSink.records() },
    }
  } catch (error) {
    // 失敗経路でも診断可能性を落とさない: 既に attachPipelineClientDebug 等で pipelineClientDebug
    // が付いている場合はその内容を保ったまま llmErrors / llmUsage を追記する
    // （attachLlmDebugToError の JSDoc参照）。
    throw attachLlmDebugToError(error, getLlmErrorLog(), llmUsageSink.records())
  } finally {
    setCurrentPipelineAbortController(null)
    resetLlmConcurrency()
    resetLmStudioContextLengthCache()
    setCurrentLlmUsageSink(undefined)
  }
}

function validateManagedServiceConnectionInputs(settings: AdminSettings): string {
  const apiBase = resolveServiceBase(settings)
  if (!apiBase) {
    throw new Error('Service URL を入力してください')
  }
  let parsed: URL
  try {
    parsed = new URL(apiBase)
  } catch {
    throw new Error('Service URL が正しい URL 形式ではありません')
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Service URL は http:// または https:// で始めてください')
  }
  if (!settings.serviceAuthToken.trim()) {
    throw new Error('Service Auth Token を入力してください')
  }
  return apiBase
}

async function fetchManagedConnectionCheck(settings: AdminSettings, signal?: AbortSignal): Promise<ManagedConnectionCheck> {
  const apiBase = validateManagedServiceConnectionInputs(settings)
  let response: Response
  try {
    response = await fetch(`${apiBase}/v1/connection-check`, {
      headers: buildAuthHeaders(settings),
      signal,
    })
  } catch (error) {
    throw formatFetchError('managed connection check request', error, `${apiBase}/v1/connection-check`)
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error(`認証に失敗しました: HTTP ${response.status}`)
  }
  if (!response.ok) {
    throw new Error(`connection check request failed: ${response.status}`)
  }

  const json = await response.json() as ManagedConnectionCheck
  const checks = Array.isArray(json.checks) ? json.checks : []
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
    ok: Boolean(json.ok),
    checks: checks.map((check) => ({
      name: String(check.name ?? 'unknown'),
      ok: Boolean(check.ok),
      detail: check.detail === undefined ? undefined : String(check.detail),
    })),
  }
}

function validateManagedConnectionCheckPayload(config: ManagedConnectionCheck): void {
  if (config.service === 'unknown' || config.version === 'unknown') {
    throw new Error('接続先が字幕パイプラインサービスとして識別できません')
  }
  if (!['local-put', 's3-presigned-put'].includes(config.upload.strategy)) {
    throw new Error(`未対応の upload strategy です: ${config.upload.strategy}`)
  }
  if (!config.jobs.workflow || config.jobs.workflow === 'unknown') {
    throw new Error('サービスの workflow 設定を確認できません')
  }
  if (config.checks.length === 0) {
    throw new Error('サービス利用可否のチェック結果が返っていません')
  }
}

export async function testServiceConnection(settings: AdminSettings, signal?: AbortSignal): Promise<ServiceConnectionCheck> {
  try {
    const apiBase = resolveServiceBase(settings)
    if (!apiBase) {
      throw new Error('Service URL が未設定です')
    }

    if (settings.serviceMode === 'managed_service') {
      const config = await fetchManagedConnectionCheck(settings, signal)
      validateManagedConnectionCheckPayload(config)
      if (!config.ok) {
        const failed = config.checks
          .filter((check) => !check.ok)
          .map((check) => `${check.name}${check.detail ? `: ${check.detail}` : ''}`)
          .join(', ')
        throw new Error(failed ? `サービス利用不可: ${failed}` : 'サービス利用不可')
      }
      return {
        ok: true,
        message: `OK: ${config.service} ${config.version} / auth + ${config.checks.length} checks`,
        config,
      }
    }

    if (!isTauri()) {
      throw new Error('ローカルWhisperX転写はTauriデスクトップアプリでのみ利用可能です')
    }
    const message = await invoke<string>('check_local_whisperx', { language: settings.transcribeLanguageCode })
    return { ok: true, message }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error || 'service connection failed'),
    }
  }
}
