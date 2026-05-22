import { useState, useCallback, useEffect, useRef, useTransition } from 'react'
import { convertFileSrc, invoke, isTauri } from '@tauri-apps/api/core'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { readFile, readTextFile } from '@tauri-apps/plugin-fs'
import { Download, Save, FolderOpen, Settings, Film, Pin, PinOff } from 'lucide-react'
import { VideoPlayer } from '@/components/VideoPlayer'
import { SubtitleBlockList } from '@/components/SubtitleBlockList'
import { GlossaryTab } from '@/components/GlossaryTab'
import { HelpTab } from '@/components/HelpTab'
import { ReportTab } from '@/components/ReportTab'
import { SettingsTab } from '@/components/SettingsTab'
import { TimelineBar } from '@/components/TimelineBar'
import { useVideoSync } from '@/hooks/useVideoSync'
import { useHistory } from '@/hooks/useHistory'
import {
  saveToLocalStorage,
  loadFromLocalStorage,
  loadSessionSnapshotFromLocalStorage,
  saveSessionSnapshotToLocalStorage,
  exportProjectJson,
  importProjectJson,
  importSrt,
  exportSrt,
  type SessionExportData,
} from '@/api/persistence'
import { loadAdminSettings, saveAdminSettings, getDefaultAdminSettings } from '@/api/adminSettings'
import { hasPipelineApi, runPipelineViaApi, testServiceConnection } from '@/api/pipelineClient'
import { describeError } from '@/lib/describeError'
import { buildMacAssetUrl } from '@/lib/video/macAssetUrl'
import type { SubtitleBlock } from '@/types/subtitle'
import type { AdminSettings } from '@/types/adminSettings'
import type { PipelineAuditReport, PipelineNodeTrace, PipelineProgressEvent, PipelineReviewItem, PipelineRunDebug, PipelineRunMetrics, PipelineRunResult } from '@/types/pipeline'
import type { TranscriptSegment } from '@/lib/pipeline/types'
import type { LocalPipelineGlossary } from '@/lib/pipeline/localPipeline'
import { useTheme } from '@/context/ThemeContext'
import { useLocale } from '@/context/LocaleContext'
import { useGlossary, type GlossaryEntry, type SelfMadeGlossaryEntry } from '@/context/GlossaryContext'
import { useToast } from '@/context/ToastContext'
import { applyGlossaryToText } from '@/utils/glossaryApply'
import { useWorkLog } from '@/hooks/useWorkLog'
import type { WorkLogBaselineOrigin } from '@/lib/worklog/types'

type Tab = 'subtitles' | 'dictionary' | 'help' | 'report' | 'settings'
type SaveStatus = 'saved' | 'saving'
type VideoSource = { name: string; path?: string; file?: File }
type PendingVideoLoad = { name: string; load: () => void }
const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.mkv', '.webm', '.m4v', '.avi']
type AssetReachable = 'ok' | 'denied' | 'error' | 'skipped'
type VideoFileDiagnostic = {
  exists: boolean
  isFile: boolean
  sizeBytes: number | null
  openOk: boolean
  openError: string | null
}
type VideoLoadDiagnostic = {
  sourceKind: 'file' | 'path'
  name: string
  originalPath?: string
  generatedUrl: string
  convertedUrl?: string
  assetSegments?: string[]
  userAgent: string
  hasEncodedSlash: boolean
  hasNonAsciiPath: boolean
  hasWhitespacePath: boolean
  hasUrlSpecialPath: boolean
  file?: VideoFileDiagnostic | null
  assetReachable: AssetReachable
  assetHeadStatus: number | null
  assetHeadError: string | null
  fallbackUrl?: string
  fallbackRegistered: boolean
  fallbackHeadStatus: number | null
  fallbackHeadContentType: string | null
  fallbackHeadContentLength: string | null
  fallbackHeadAcceptRanges: string | null
  fallbackRangeStatus: number | null
  fallbackRangeContentRange: string | null
  fallbackRangeContentLength: string | null
  fallbackHeadError: string | null
  fallbackAttempted: boolean
}

function cloneBlocks(blocks: SubtitleBlock[]): SubtitleBlock[] {
  return blocks.map((block) => ({
    ...block,
    glossaryTerms: block.glossaryTerms.map((term) => ({ ...term })),
    ignoredTypos: block.ignoredTypos ? [...block.ignoredTypos] : undefined,
    ignoredMissing: block.ignoredMissing ? [...block.ignoredMissing] : undefined,
    correctionAttempts: block.correctionAttempts ? block.correctionAttempts.map((attempt) => ({ ...attempt })) : undefined,
    editHistory: block.editHistory ? block.editHistory.map((entry) => ({ ...entry })) : undefined,
  }))
}

function buildPathFlags(path: string) {
  return {
    hasNonAsciiPath: /[^\x00-\x7F]/.test(path),
    hasWhitespacePath: /\s/.test(path),
    hasUrlSpecialPath: /[#?%]/.test(path),
  }
}

function isVideoPathLike(pathOrName: string): boolean {
  const lower = pathOrName.toLowerCase()
  return VIDEO_EXTENSIONS.some(ext => lower.endsWith(ext))
}

async function probeAssetHead(url: string): Promise<{
  assetReachable: AssetReachable
  assetHeadStatus: number | null
  assetHeadError: string | null
}> {
  if (!url.startsWith('asset://')) {
    return { assetReachable: 'skipped', assetHeadStatus: null, assetHeadError: null }
  }
  try {
    const head = await fetch(url, { method: 'HEAD' })
    return {
      assetReachable: head.ok ? 'ok' : 'denied',
      assetHeadStatus: head.status,
      assetHeadError: null,
    }
  } catch (err) {
    return {
      assetReachable: 'error',
      assetHeadStatus: null,
      assetHeadError: describeError(err),
    }
  }
}

async function probeHttpVideoUrl(url: string): Promise<{
  fallbackHeadStatus: number | null
  fallbackHeadContentType: string | null
  fallbackHeadContentLength: string | null
  fallbackHeadAcceptRanges: string | null
  fallbackRangeStatus: number | null
  fallbackRangeContentRange: string | null
  fallbackRangeContentLength: string | null
  fallbackHeadError: string | null
}> {
  try {
    const base = url.replace(/\/video\/.+$/, '')
    const healthRes = await fetch(`${base}/healthz`)
    console.info('[video][diag] fallback /healthz fetch:', healthRes.status, await healthRes.text())
    const headRes = await fetch(url, { method: 'HEAD' })
    const rangeRes = await fetch(url, { headers: { Range: 'bytes=0-99' } })
    const rangeBody = await rangeRes.arrayBuffer()
    console.info('[video][diag] fallback range fetch:', {
      status: rangeRes.status,
      contentRange: rangeRes.headers.get('content-range'),
      contentLength: rangeRes.headers.get('content-length'),
      bytesRead: rangeBody.byteLength,
    })
    return {
      fallbackHeadStatus: headRes.status,
      fallbackHeadContentType: headRes.headers.get('content-type'),
      fallbackHeadContentLength: headRes.headers.get('content-length'),
      fallbackHeadAcceptRanges: headRes.headers.get('accept-ranges'),
      fallbackRangeStatus: rangeRes.status,
      fallbackRangeContentRange: rangeRes.headers.get('content-range'),
      fallbackRangeContentLength: rangeRes.headers.get('content-length'),
      fallbackHeadError: null,
    }
  } catch (err) {
    return {
      fallbackHeadStatus: null,
      fallbackHeadContentType: null,
      fallbackHeadContentLength: null,
      fallbackHeadAcceptRanges: null,
      fallbackRangeStatus: null,
      fallbackRangeContentRange: null,
      fallbackRangeContentLength: null,
      fallbackHeadError: describeError(err),
    }
  }
}

function uniqueNonEmpty(values: Array<string | undefined>): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    const text = value?.trim()
    if (!text) continue
    const key = text.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(text)
  }
  return result
}

function buildPipelineGlossary(glossary: GlossaryEntry[], selfMadeGlossary: SelfMadeGlossaryEntry[]): LocalPipelineGlossary {
  const confirmedFormal = glossary.filter(entry => entry.confirmed)
  const usableSelfMade = selfMadeGlossary.filter(entry =>
    !entry.disabled
    && (entry.formalEligible || entry.assistiveEligible),
  )

  const correctionTerms = uniqueNonEmpty([
    ...confirmedFormal.flatMap(entry => [entry.ja, entry.abbr]),
    ...usableSelfMade.flatMap(entry => [
      entry.ja,
      entry.abbr,
      entry.formula,
      entry.displayText,
      entry.spokenJa,
    ]),
  ]).slice(0, 160)

  const translationTerms = uniqueNonEmpty([
    ...confirmedFormal.flatMap(entry => [
      entry.ja && entry.en ? `${entry.ja} => ${entry.en}` : undefined,
      entry.abbr,
    ]),
    ...usableSelfMade.flatMap(entry => [
      entry.ja && entry.en ? `${entry.ja} => ${entry.en}` : undefined,
      entry.formula && (entry.spokenEn || entry.spokenJa)
        ? `${entry.formula} => ${entry.spokenEn ?? entry.spokenJa}`
        : undefined,
      entry.displayText && (entry.spokenEn || entry.spokenJa)
        ? `${entry.displayText} => ${entry.spokenEn ?? entry.spokenJa}`
        : undefined,
      entry.abbr,
    ]),
  ]).slice(0, 160)

  return { correctionTerms, translationTerms }
}

type SubtitleEditType = NonNullable<SubtitleBlock['editHistory']>[number]['type']

function withEditHistory(
  block: SubtitleBlock,
  type: SubtitleEditType,
  before?: Record<string, unknown>,
  after?: Record<string, unknown>,
): SubtitleBlock {
  return {
    ...block,
    editHistory: [
      ...(block.editHistory ?? []),
      {
        at: new Date().toISOString(),
        type,
        before,
        after,
      },
    ].slice(-50),
  }
}

function joinTextParts(parts: Array<string | undefined>, separator = ' '): string {
  return parts
    .map(part => (part ?? '').trim())
    .filter(Boolean)
    .join(separator)
}

function withTimeEditHistory(
  block: SubtitleBlock,
  startTime: number,
  endTime: number,
  afterExtra?: Record<string, unknown>,
): SubtitleBlock {
  const dur = Math.max(0.01, endTime - startTime)
  return withEditHistory(
    {
      ...block,
      startTime,
      endTime,
      cps: Math.round(block.charCount / dur * 10) / 10,
    },
    'time_edit',
    { startTime: block.startTime, endTime: block.endTime },
    { startTime, endTime, ...afterExtra },
  )
}

function updateTimesWithNeighborAdjust(
  blocks: SubtitleBlock[],
  id: number,
  startTime: number,
  endTime: number,
): SubtitleBlock[] {
  if (startTime < 0 || startTime >= endTime) return blocks
  const idx = blocks.findIndex(b => b.id === id)
  if (idx === -1) return blocks
  const current = blocks[idx]
  if (current.status === 'approved') return blocks

  const startChanged = Math.abs(current.startTime - startTime) > 0.0005
  const endChanged = Math.abs(current.endTime - endTime) > 0.0005
  const prev = idx > 0 ? blocks[idx - 1] : undefined
  const next = idx < blocks.length - 1 ? blocks[idx + 1] : undefined
  const shouldAdjustPrev = Boolean(startChanged && prev && prev.status !== 'approved' && startTime > prev.startTime)
  const shouldAdjustNext = Boolean(endChanged && next && next.status !== 'approved' && endTime < next.endTime)

  return blocks.map((b, i) => {
    if (i === idx) {
      return withTimeEditHistory(b, startTime, endTime, {
        adjustedPreviousEnd: shouldAdjustPrev ? startTime : undefined,
        adjustedNextStart: shouldAdjustNext ? endTime : undefined,
      })
    }
    if (shouldAdjustPrev && i === idx - 1) {
      return withTimeEditHistory(b, b.startTime, startTime, { adjustedByBlockId: id })
    }
    if (shouldAdjustNext && i === idx + 1) {
      return withTimeEditHistory(b, endTime, b.endTime, { adjustedByBlockId: id })
    }
    return b
  })
}

function sanitizeAdminSettings(settings: AdminSettings): Partial<AdminSettings> {
  return {
    serviceMode: settings.serviceMode,
    serviceUrl: settings.serviceUrl,
    translationProvider: settings.translationProvider,
    translationModel: settings.translationModel,
    correctionModel: settings.correctionModel,
    pdfExtractionUseVision: settings.pdfExtractionUseVision,
    pdfExtractionVisionModel: settings.pdfExtractionVisionModel,
    pdfExtractionParallel: settings.pdfExtractionParallel,
    glossaryMaxOutputTokens: settings.glossaryMaxOutputTokens,
    apiRequestConcurrency: settings.apiRequestConcurrency,
    compressModel: settings.compressModel,
    expandModel: settings.expandModel,
    contextMergeModel: settings.contextMergeModel,
    subtitleLanguageLabel: settings.subtitleLanguageLabel,
    transcriptLanguageLabel: settings.transcriptLanguageLabel,
    languageProfileConfigJson: settings.languageProfileConfigJson,
    textNormalizationEnabled: settings.textNormalizationEnabled,
    textNormalizationRulesJson: settings.textNormalizationRulesJson,
    openaiCompatibleBaseUrl: settings.openaiCompatibleBaseUrl,
    enMaxCharsPerLine: settings.enMaxCharsPerLine,
    enMaxCps: settings.enMaxCps,
    pipelineVerboseEnRatio: settings.pipelineVerboseEnRatio,
    serviceAuthToken: settings.serviceAuthToken ? '[configured]' : '',
    hfToken: settings.hfToken ? '[configured]' : '',
    openaiApiKey: settings.openaiApiKey ? '[configured]' : '',
    geminiApiKey: settings.geminiApiKey ? '[configured]' : '',
  }
}

function toUiSafeDebug(debug?: PipelineRunDebug): PipelineRunDebug | undefined {
  if (!debug) return undefined
  return {
    ...debug,
    transcriptSegments: undefined,
  }
}

function toUiSafePipelineRun(result: PipelineRunResult): PipelineRunResult {
  return {
    ...result,
    debug: toUiSafeDebug(result.debug),
  }
}

function getPipelineClientDebug(error: unknown): {
  transcriptSegments?: TranscriptSegment[]
  transcriptMetadata?: Record<string, unknown>
  stageSnapshots?: PipelineRunDebug['stageSnapshots']
} {
  if (!error || typeof error !== 'object') return {}
  const debug = (error as Record<string, unknown>).pipelineClientDebug
  if (!debug || typeof debug !== 'object') return {}
  const row = debug as Record<string, unknown>
  return {
    transcriptSegments: Array.isArray(row.transcriptSegments) ? row.transcriptSegments as TranscriptSegment[] : undefined,
    transcriptMetadata: row.transcriptMetadata && typeof row.transcriptMetadata === 'object'
      ? row.transcriptMetadata as Record<string, unknown>
      : undefined,
    stageSnapshots: Array.isArray(row.stageSnapshots) ? row.stageSnapshots as PipelineRunDebug['stageSnapshots'] : undefined,
  }
}

type EditHistoryEntry = NonNullable<SubtitleBlock['editHistory']>[number]

/**
 * editHistory エントリのワークログ重複記録防止キー。
 * blockId を含めない（結合で blockId が変わっても同一エントリと判定するため）。
 * split は子ブロックごとに同一エントリが複製されるため at 単位でグループ化する。
 */
function workLogDedupeKey(entry: EditHistoryEntry): string {
  if (entry.type === 'split') return `split:${entry.at}`
  return `${entry.at}|${entry.type}|${JSON.stringify(entry.before ?? null)}`
}

function readNum(obj: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = obj?.[key]
  return typeof value === 'number' ? value : undefined
}

function readNestedNum(
  obj: Record<string, unknown> | undefined,
  outerKey: string,
  innerKey: string,
): number | undefined {
  const nested = obj?.[outerKey]
  if (nested && typeof nested === 'object') {
    const value = (nested as Record<string, unknown>)[innerKey]
    return typeof value === 'number' ? value : undefined
  }
  return undefined
}

export default function App() {
  const { theme } = useTheme()
  const { strings: t } = useLocale()
  const toast = useToast()
  const { glossary, selfMadeGlossary, importEntries } = useGlossary()
  const restoredSession = loadSessionSnapshotFromLocalStorage()
  const restored = restoredSession?.blocks ?? loadFromLocalStorage()
  const { current: blocks, push, undo, redo, canUndo, canRedo, reset } =
    useHistory<SubtitleBlock[]>(restored ?? [])
  const [activeTab, setActiveTab] = useState<Tab>('subtitles')
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('saved')
  const [restoredMsg, setRestoredMsg] = useState(restored !== null)
  const importRef = useRef<HTMLInputElement>(null)
  const srtImportRef = useRef<HTMLInputElement>(null)
  const videoFileRef = useRef<HTMLInputElement>(null)
  const [videoUrl, setVideoUrl] = useState<string | null>(null)
  // TODO: session復元時にvideoSource.pathがある場合、loadVideoPath(path)で
  //       自動再ロード（新トークンでURL再生成）。現状ユーザー手動再ロードが必要。
  const [videoSource, setVideoSource] = useState<VideoSource | null>(
    restoredSession?.session?.videoSource
      ? {
          name: restoredSession.session.videoSource.name,
          path: restoredSession.session.videoSource.path,
        }
      : null,
  )
  const [videoDiagnostic, setVideoDiagnostic] = useState<VideoLoadDiagnostic | null>(null)
  const [pendingVideoLoad, setPendingVideoLoad] = useState<PendingVideoLoad | null>(null)
  const [isDragOverRight, setIsDragOverRight] = useState(false)
  const lastHtmlDropRef = useRef(0)
  const [pipelineRun, setPipelineRun] = useState<PipelineRunResult>(
    restoredSession?.session?.pipelineRun ?? {
      status: 'idle',
      step: 'idle',
      message: 'レポートタブからパイプラインを開始できます',
    },
  )
  const [pipelineHistory, setPipelineHistory] = useState<PipelineRunResult[]>(
    restoredSession?.session?.pipelineHistory ?? [],
  )
  const [pipelineStatusPinned, setPipelineStatusPinned] = useState(false)
  const [glossaryGenerationLog, setGlossaryGenerationLog] = useState<string[]>([])
  const [glossaryGenerationBusy, setGlossaryGenerationBusy] = useState(false)
  const [adminSettings, setAdminSettings] = useState<AdminSettings>(() => loadAdminSettings())
  const latestPipelineDebugRef = useRef<PipelineRunDebug | undefined>(
    restoredSession?.session?.pipelineRun?.debug,
  )
  const workLog = useWorkLog()
  const {
    recordEvent: recordWorkLogEvent,
    getActiveSessionId: getWorkLogSessionId,
    getExport: getWorkLogExport,
  } = workLog
  // 既にワークログへ記録済みの editHistory エントリのキー集合（重複記録防止）
  const workLogSeenRef = useRef<Set<string>>(new Set())
  const serviceCheckAbortRef = useRef<AbortController | null>(null)
  const [serviceCheck, setServiceCheck] = useState<{ status: 'idle' | 'checking' | 'success' | 'error'; message: string }>({
    status: 'idle',
    message: 'サービス接続は未確認です',
  })

  // 編集中のドラフトテキスト（字幕オーバーレイのリアルタイム更新用）
  // useTransition でオーバーレイ更新を低優先度にしてエディタ入力を軽くする
  const [, startDraftTransition] = useTransition()
  const [draftSource, setDraftSource] = useState<{ id: number; text: string } | null>(null)
  const handleDraftChange = useCallback((id: number, text: string | null) => {
    startDraftTransition(() => {
      setDraftSource(text !== null ? { id, text } : null)
    })
  }, [])

  // ウィンドウリサイズ中は重いコンポーネントの描画を中断する
  // OSのリサイズハンドルはmouseupが取れないためデバウンスで対応
  const [isResizing, setIsResizing] = useState(false)
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const handleResize = () => {
      setIsResizing(true)
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current)
      resizeTimerRef.current = setTimeout(() => setIsResizing(false), 500)
    }
    window.addEventListener('resize', handleResize)
    return () => {
      window.removeEventListener('resize', handleResize)
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current)
    }
  }, [])

  // パネルリサイズ
  const [leftPct, setLeftPct] = useState(45)
  const [timelineH, setTimelineH] = useState(60)
  const mainRef = useRef<HTMLDivElement>(null)
  const timelineHRef = useRef(timelineH)
  useEffect(() => { timelineHRef.current = timelineH }, [timelineH])

  const handleHResizeMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    setIsResizing(true)
    const onMove = (mv: MouseEvent) => {
      const el = mainRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      const pct = ((mv.clientX - rect.left) / rect.width) * 100
      setLeftPct(Math.max(25, Math.min(72, pct)))
    }
    const onUp = () => {
      setIsResizing(false)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [])

  const handleVResizeMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    setIsResizing(true)
    const startY = e.clientY
    const startH = timelineHRef.current
    const onMove = (mv: MouseEvent) => {
      const dy = startY - mv.clientY
      setTimelineH(Math.max(30, Math.min(200, startH + dy)))
    }
    const onUp = () => {
      setIsResizing(false)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [])

  const { videoRef, currentTime, duration, isPlaying, activeBlockId, seekTo, togglePlay, onTimeUpdate, onPlay, onPause, onLoadedMetadata, onError: onVideoError } =
    useVideoSync(blocks, videoUrl)

  const loadVideoFile = useCallback((file: File) => {
    lastHtmlDropRef.current = Date.now()
    setVideoSource({ name: file.name, file })
    const url = URL.createObjectURL(file)
    setVideoDiagnostic({
      sourceKind: 'file',
      name: file.name,
      generatedUrl: url,
      userAgent: navigator.userAgent,
      hasEncodedSlash: /%2F/i.test(url),
      hasNonAsciiPath: /[^\x00-\x7F]/.test(file.name),
      hasWhitespacePath: /\s/.test(file.name),
      hasUrlSpecialPath: /[#?%]/.test(file.name),
      file: {
        exists: true,
        isFile: true,
        sizeBytes: file.size,
        openOk: true,
        openError: null,
      },
      assetReachable: 'skipped',
      assetHeadStatus: null,
      assetHeadError: null,
      fallbackRegistered: false,
      fallbackHeadStatus: null,
      fallbackHeadContentType: null,
      fallbackHeadContentLength: null,
      fallbackHeadAcceptRanges: null,
      fallbackRangeStatus: null,
      fallbackRangeContentRange: null,
      fallbackRangeContentLength: null,
      fallbackHeadError: null,
      fallbackAttempted: false,
    })
    console.info('[video][diag] load file object', {
      name: file.name,
      sizeBytes: file.size,
      url,
      userAgent: navigator.userAgent,
    })
    setVideoUrl(prev => {
      if (prev && prev.startsWith('blob:')) URL.revokeObjectURL(prev)
      return url
    })
  }, [])

  const loadVideoPath = useCallback(async (path: string) => {
    const name = path.split(/[\\/]/).pop() ?? path
    setVideoSource({ name, path })
    // 各OSのWebView動作:
    //   Windows (WebView2/Chromium): convertFileSrc → http://asset.localhost/... で動作
    //   macOS (WKWebView): slash を "%2F" に潰すと asset protocol が実パスを解決できないため、
    //     path segment 単位で encodeURIComponent し、"/Users/..." の区切りを残す。
    //   Linux (WebKitGTK): asset:// / local HTTP とも動画プレビュー未解決のため既存経路を維持。
    const isLinux = /\bLinux\b/.test(navigator.userAgent) && !/Android/.test(navigator.userAgent)
    const isMac = /Mac/.test(navigator.userAgent) && !isLinux
    let url: string
    let assetSegments: string[] | undefined
    let fallbackUrl: string | undefined
    let fallbackRegistered = false
    let fallbackAttempted = false
    let fallbackHeadStatus: number | null = null
    let fallbackHeadContentType: string | null = null
    let fallbackHeadContentLength: string | null = null
    let fallbackHeadAcceptRanges: string | null = null
    let fallbackRangeStatus: number | null = null
    let fallbackRangeContentRange: string | null = null
    let fallbackRangeContentLength: string | null = null
    let fallbackHeadError: string | null = null
    const convertedUrl = convertFileSrc(path)
    const applyFallbackProbe = (probe: Awaited<ReturnType<typeof probeHttpVideoUrl>>) => {
      fallbackHeadStatus = probe.fallbackHeadStatus
      fallbackHeadContentType = probe.fallbackHeadContentType
      fallbackHeadContentLength = probe.fallbackHeadContentLength
      fallbackHeadAcceptRanges = probe.fallbackHeadAcceptRanges
      fallbackRangeStatus = probe.fallbackRangeStatus
      fallbackRangeContentRange = probe.fallbackRangeContentRange
      fallbackRangeContentLength = probe.fallbackRangeContentLength
      fallbackHeadError = probe.fallbackHeadError
    }
    if (isMac) {
      const macAsset = buildMacAssetUrl(path)
      url = macAsset.url
      assetSegments = macAsset.segments
      try {
        fallbackUrl = await invoke<string>('register_video', { path })
        fallbackRegistered = true
        const fallbackProbe = await probeHttpVideoUrl(fallbackUrl)
        applyFallbackProbe(fallbackProbe)
        console.info('[video][diag] mac fallback registered', {
          primaryUrl: url,
          fallbackUrl,
          fallbackHeadStatus,
          fallbackHeadContentType,
          fallbackHeadContentLength,
          fallbackHeadAcceptRanges,
          fallbackRangeStatus,
          fallbackRangeContentRange,
          fallbackRangeContentLength,
          fallbackHeadError,
        })
      } catch (err) {
        fallbackHeadError = describeError(err)
        console.error('[video][diag] mac fallback register_video failed:', fallbackHeadError)
      }
    } else if (!isLinux) {
      url = convertedUrl
    } else {
      try {
        url = await invoke<string>('register_video', { path })
        console.info('[video] using local HTTP server URL:', url)
        const httpProbe = await probeHttpVideoUrl(url)
        applyFallbackProbe(httpProbe)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error('[video] register_video failed:', msg)
        alert(`動画読込失敗: register_video → ${msg}`)
        return
      }
    }

    let fileDiagnostic: VideoFileDiagnostic | null = null
    try {
      fileDiagnostic = await invoke<VideoFileDiagnostic>('inspect_video_file', { path })
    } catch (err) {
      fileDiagnostic = {
        exists: false,
        isFile: false,
        sizeBytes: null,
        openOk: false,
        openError: describeError(err),
      }
    }
    const assetProbe = await probeAssetHead(url)
    const isLargeMacVideo = isMac && (fileDiagnostic?.sizeBytes ?? 0) >= 2 * 1024 * 1024 * 1024
    if (isMac && fallbackUrl && (assetProbe.assetReachable !== 'ok' || isLargeMacVideo)) {
      console.warn('[video][diag] using localhost fallback immediately', {
        reason: isLargeMacVideo ? 'large-video-byte-range' : 'asset-head-failed',
        assetReachable: assetProbe.assetReachable,
        assetHeadStatus: assetProbe.assetHeadStatus,
        assetHeadError: assetProbe.assetHeadError,
        fallbackUrl,
        file: fileDiagnostic,
      })
      url = fallbackUrl
      fallbackAttempted = true
    }

    const pathFlags = buildPathFlags(path)
    const diagnostic: VideoLoadDiagnostic = {
      sourceKind: 'path',
      name,
      originalPath: path,
      generatedUrl: url,
      convertedUrl,
      assetSegments,
      userAgent: navigator.userAgent,
      hasEncodedSlash: /%2F/i.test(url),
      ...pathFlags,
      file: fileDiagnostic,
      ...assetProbe,
      fallbackUrl,
      fallbackRegistered,
      fallbackHeadStatus,
      fallbackHeadContentType,
      fallbackHeadContentLength,
      fallbackHeadAcceptRanges,
      fallbackRangeStatus,
      fallbackRangeContentRange,
      fallbackRangeContentLength,
      fallbackHeadError,
      fallbackAttempted,
    }
    setVideoDiagnostic(diagnostic)
    console.info('[video][diag] load path', diagnostic)
    setVideoUrl(prev => {
      if (prev && prev.startsWith('blob:')) URL.revokeObjectURL(prev)
      return url
    })
  }, [])

  const readTextFileAsFile = useCallback(async (path: string) => {
    const text = await readTextFile(path)
    const name = path.split(/[\\/]/).pop() ?? 'file'
    return new File([text], name, { type: 'text/plain' })
  }, [])

  const readBinaryFileAsFile = useCallback(async (path: string) => {
    const data = await readFile(path)
    const name = path.split(/[\\/]/).pop() ?? 'file'
    return new File([data], name)
  }, [])


  const sleep = useCallback((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)), [])

  useEffect(() => {
    saveAdminSettings(adminSettings)
  }, [adminSettings])

  const updateAdminSettings = useCallback((patch: Partial<AdminSettings>) => {
    setAdminSettings(prev => ({ ...prev, ...patch }))
  }, [])

  const resetAdminSettings = useCallback(() => {
    setAdminSettings(getDefaultAdminSettings())
    setServiceCheck({ status: 'idle', message: 'サービス接続は未確認です' })
  }, [])

  // ref で最新の adminSettings を保持し、handleServiceCheck の closure 経由ではなく
  // クリック時点の最新値を確実に使う（古い値で叩く事故を防ぐ）
  const adminSettingsRef = useRef(adminSettings)
  useEffect(() => {
    adminSettingsRef.current = adminSettings
  }, [adminSettings])

  const handleServiceCheck = useCallback(async () => {
    serviceCheckAbortRef.current?.abort()
    const controller = new AbortController()
    serviceCheckAbortRef.current = controller

    setServiceCheck({ status: 'checking', message: '接続確認中...' })
    // Yield to React so the 'checking' state actually renders before the
    // (potentially fast) fetch resolves and triggers the next setState.
    await new Promise(resolve => setTimeout(resolve, 0))

    const result = await testServiceConnection(adminSettingsRef.current, controller.signal)

    if (controller.signal.aborted) return
    const stamp = new Date().toLocaleTimeString()
    setServiceCheck({
      status: result.ok ? 'success' : 'error',
      message: `${result.message} (${stamp})`,
    })
  }, [])

  useEffect(() => {
    // 設定変更時は前回の結果を idle に戻すのみ。in-flight リクエストを abort すると
    // 入力中の useEffect 連発で、クリック直後のテスト自身が abort される事故を招くため abort はしない。
    setServiceCheck({ status: 'idle', message: 'サービス接続は未確認です' })
  }, [adminSettings.serviceMode, adminSettings.serviceUrl, adminSettings.serviceAuthToken])

  const calcPipelineMetrics = useCallback((generated: SubtitleBlock[], startedAt: number, finishedAt: number): PipelineRunMetrics => {
    const totalBlocks = Math.max(1, generated.length)
    const cpsViolationCount = generated.filter(b => b.cps > adminSettings.enMaxCps).length
    const overLengthCount = generated.filter(b => b.source.split('\n').some(line => line.length > adminSettings.enMaxCharsPerLine)).length
    const flaggedCount = generated.filter(b => b.status === 'flagged').length

    const sourceChars = generated.reduce((sum, b) => sum + b.source.length, 0)
    const targetChars = generated.reduce((sum, b) => sum + b.target.length, 0)
    const inputTokens = Math.max(1, Math.round(sourceChars / 4))
    const outputTokens = Math.max(1, Math.round(targetChars / 4))

    const estimatedUsd =
      (inputTokens / 1_000_000) * 0.30 +
      (outputTokens / 1_000_000) * 2.50

    return {
      quality: {
        totalBlocks,
        cpsViolationRate: cpsViolationCount / totalBlocks,
        overLengthRate: overLengthCount / totalBlocks,
        flaggedCount,
      },
      cost: {
        inputTokens,
        outputTokens,
        estimatedUsd,
        durationMs: Math.max(0, finishedAt - startedAt),
      },
    }
  }, [adminSettings.enMaxCharsPerLine, adminSettings.enMaxCps])

  const buildAuditReport = useCallback((generated: SubtitleBlock[], traces: PipelineNodeTrace[]): PipelineAuditReport => {
    const items: PipelineReviewItem[] = []

    generated.forEach(block => {
      if (block.cps > adminSettings.enMaxCps) {
        items.push({
          id: `cps-${block.id}`,
          nodeId: 'cps_guard',
          reason: `CPS超過 (${block.cps.toFixed(1)} > ${adminSettings.enMaxCps.toFixed(1)})`,
          priority: 'must_review',
          score: Math.min(1, (block.cps - adminSettings.enMaxCps) / 10),
          blockId: block.id,
        })
      }
      const overLen = block.source.split('\n').some(line => line.length > adminSettings.enMaxCharsPerLine)
      if (overLen) {
        items.push({
          id: `len-${block.id}`,
          nodeId: 'subtitle_format',
          reason: `${adminSettings.enMaxCharsPerLine}文字超過行あり`,
          priority: 'should_review',
          score: 0.6,
          blockId: block.id,
        })
      }
    })

    // Stub: 意味近似スコアは実API接続後にバックエンドから取得する
    items.push({
      id: 'semantic-global',
      nodeId: 'semantic_check',
      reason: 'スタブ実行 - 実API接続後に実測値を表示',
      priority: 'auto_pass' as const,
      score: 1.0,
    })

    // Stub: 用語チェックは実API接続後にバックエンドから取得する
    items.push({
      id: 'term-global',
      nodeId: 'terminology_check',
      reason: 'スタブ実行 - 実API接続後に用語漏れを検出',
      priority: 'auto_pass' as const,
      score: 1.0,
    })

    const mustReviewCount = items.filter(i => i.priority === 'must_review').length
    const shouldReviewCount = items.filter(i => i.priority === 'should_review').length
    const autoPassCount = items.filter(i => i.priority === 'auto_pass').length

    return {
      mustReviewCount,
      shouldReviewCount,
      autoPassCount,
      reviewItems: items,
      nodeTraces: traces,
    }
  }, [adminSettings.enMaxCharsPerLine, adminSettings.enMaxCps])

  const persistSessionSnapshot = useCallback((
    next: {
      blocks?: SubtitleBlock[]
      pipelineRun?: PipelineRunResult
      pipelineHistory?: PipelineRunResult[]
      videoSource?: VideoSource | null
    } = {},
  ) => {
    saveSessionSnapshotToLocalStorage({
      version: 2,
      savedAt: new Date().toISOString(),
      blocks: cloneBlocks(next.blocks ?? blocks),
      session: {
        videoSource: (next.videoSource ?? videoSource)
          ? {
              name: (next.videoSource ?? videoSource)!.name,
              path: (next.videoSource ?? videoSource)!.path,
            }
          : null,
        adminSettings: sanitizeAdminSettings(adminSettings),
        pipelineRun: next.pipelineRun ?? toUiSafePipelineRun(pipelineRun),
        pipelineHistory: next.pipelineHistory ?? pipelineHistory,
      },
    })
  }, [adminSettings, blocks, pipelineHistory, pipelineRun, videoSource])

  /** ワークログへ記録済みの editHistory エントリを「既知」として登録（再記録防止） */
  const seedWorkLogSeen = useCallback((source: SubtitleBlock[]) => {
    const seen = new Set<string>()
    for (const block of source) {
      for (const entry of block.editHistory ?? []) {
        seen.add(workLogDedupeKey(entry))
      }
    }
    workLogSeenRef.current = seen
  }, [])

  /** 編集対象（ブロック集合）が確定したのでワークログの新セッションを開始する */
  const beginWorkLogSession = useCallback((
    origin: WorkLogBaselineOrigin,
    initialBlocks: SubtitleBlock[],
    opts?: { transcriptSegments?: TranscriptSegment[]; video?: VideoSource | null },
  ) => {
    seedWorkLogSeen(initialBlocks)
    const video = opts && 'video' in opts ? opts.video : videoSource
    void workLog.startSession({
      origin,
      video: video ? { name: video.name, path: video.path } : null,
      settingsSnapshot: sanitizeAdminSettings(adminSettings),
      initialBlocks: cloneBlocks(initialBlocks),
      transcriptSegments: opts?.transcriptSegments,
    }, adminSettings.workLogDir)
  }, [adminSettings, videoSource, workLog, seedWorkLogSeen])

  const buildPipelineStubBlocks = useCallback((videoName: string): SubtitleBlock[] => {
    const rows: Array<{ start: number; end: number; source: string; target: string }> = [
      {
        start: 0,
        end: 3.2,
        source: '本動画を自動で文字起こしし、英語字幕を生成します。',
        target: `This file (${videoName}) was transcribed and translated automatically.`,
      },
      {
        start: 3.2,
        end: 7.1,
        source: '現在は開発途中のため、ここにはスタブ結果を表示しています。',
        target: 'This is a development-stage pipeline preview result.',
      },
      {
        start: 7.1,
        end: 11.4,
        source: '次のステップで WhisperX と翻訳APIの実処理をこの導線に接続します。',
        target: 'WhisperX and real translation APIs will be connected in this same flow.',
      },
    ]

    return rows.map((row, idx) => {
      const charCount = row.target.length
      const durationSec = Math.max(0.1, row.end - row.start)
      return {
        id: idx + 1,
        startTime: row.start,
        endTime: row.end,
        source: row.source,
        target: row.target,
        cps: Math.round((charCount / durationSec) * 10) / 10,
        charCount,
        status: 'pending',
        glossaryTerms: [],
      }
    })
  }, [])

  const runDropPipeline = useCallback(async (source: VideoSource) => {
    const sourceName = source.name
    const startedAt = Date.now()
    const traces: PipelineNodeTrace[] = []
    const progressEvents: PipelineProgressEvent[] = []
    const initialBlocksSnapshot = cloneBlocks(blocks)
    let managedRunId: string | undefined
    let transcriptSegments: TranscriptSegment[] | undefined = undefined
    let transcriptMetadata: Record<string, unknown> | undefined = undefined
    let stageSnapshots: PipelineRunDebug['stageSnapshots'] | undefined = undefined

    const mapProgressStatus = (status: 'queued' | 'running' | 'success' | 'failed' | 'cancelled'): PipelineRunResult['status'] => {
      if (status === 'queued') return 'queued'
      if (status === 'running') return 'running'
      if (status === 'success') return 'success'
      return 'error'
    }

    const mapProgressStep = (node: string | null): PipelineRunResult['step'] => {
      switch (node) {
        case 'transcribe':
        case 'correct':
        case 'translate':
        case 'subtitle':
          return node
        case 'extract_audio':
        case 'local_postprocess':
          return 'transcribe'
        default:
          return 'idle'
      }
    }

    const runStep = async (
      nodeId: string,
      step: PipelineRunResult['step'],
      message: string,
      waitMs: number,
      summary: string,
      provider = 'stub',
      model = 'stub-v1',
    ) => {
      progressEvents.push({
        at: Date.now(),
        status: 'running',
        step,
        message,
        runId: managedRunId,
        currentNode: nodeId,
      })
      const runningState: PipelineRunResult = { status: 'running', step, message, sourceName, startedAt, runId: managedRunId }
      setPipelineRun(runningState)
      persistSessionSnapshot({
        pipelineRun: runningState,
        videoSource: source,
      })
      const t0 = Date.now()
      await sleep(waitMs)
      const t1 = Date.now()
      traces.push({
        nodeId,
        status: 'success',
        attempt: 1,
        durationMs: Math.max(1, t1 - t0),
        provider,
        model,
        summary,
      })
    }

    setActiveTab('subtitles')
    try {
      let generated: SubtitleBlock[] = []
      let audit: PipelineAuditReport | undefined

      if (hasPipelineApi(adminSettings)) {
        const startingState: PipelineRunResult = {
          status: 'running',
          step: 'transcribe',
          message: 'パイプライン開始中...',
          sourceName,
          startedAt,
        }
        setPipelineRun(startingState)
        progressEvents.push({
          at: Date.now(),
          status: 'running',
          step: 'transcribe',
          message: 'パイプライン開始中...',
          currentNode: 'transcribe',
        })
        persistSessionSnapshot({
          pipelineRun: startingState,
          videoSource: source,
        })
        const pipelineGlossary = buildPipelineGlossary(glossary, selfMadeGlossary)
        const apiResult = await runPipelineViaApi(sourceName, adminSettings, source, (progress) => {
          managedRunId = progress.runId
          const nodeLabel: Record<string, string> = {
            queued: 'ジョブ投入待ち',
            extract_audio: '音声抽出',
            transcribe: '書き起こし（WhisperX）',
            local_postprocess: 'ローカル後段処理',
            correct: '日本語補正',
            translate: '英語翻訳',
            subtitle: '字幕ブロック化',
            semantic_check: '意味チェック',
            terminology_check: '用語チェック',
            cps_guard: 'CPS検証',
          }
          const node = progress.currentNode ?? ''
          const label = nodeLabel[node] ?? node
          const elapsed = progress.nodeElapsedSec !== null ? ` (${progress.nodeElapsedSec}s)` : ''
          const stepKey = mapProgressStep(progress.currentNode)
          const message = (() => {
            if (progress.status === 'queued') {
              return 'ジョブを投入しました。worker の開始を待っています。'
            }
            if (adminSettings.serviceMode === 'managed_service' && node === 'transcribe') {
              return `AWS上で書き起こし実行中です${elapsed}。ローカル実行より時間がかかります。`
            }
            return `${label}${elapsed}`
          })()
          progressEvents.push({
            at: Date.now(),
            status: mapProgressStatus(progress.status),
            step: stepKey,
            message,
            runId: progress.runId,
            currentNode: progress.currentNode,
            completedNodes: progress.completedNodes,
            totalNodes: progress.totalNodes,
            nodeElapsedSec: progress.nodeElapsedSec,
          })
          const progressState: PipelineRunResult = {
            status: mapProgressStatus(progress.status),
            step: stepKey,
            message,
            runId: progress.runId,
            sourceName,
            startedAt,
          }
          setPipelineRun(progressState)
          persistSessionSnapshot({
            pipelineRun: progressState,
            videoSource: source,
          })
        }, pipelineGlossary)
        generated = apiResult.blocks
        audit = apiResult.audit
        transcriptSegments = apiResult.debug?.transcriptSegments
        transcriptMetadata = apiResult.debug?.transcriptMetadata
        stageSnapshots = apiResult.debug?.stageSnapshots
      } else {
        await runStep('transcribe', 'transcribe', '文字起こしを実行中...', 350, 'WhisperXでセグメント生成')
        await runStep('correct', 'correct', '日本語テキストを補正中...', 300, 'LLMで補正と正規化')
        await runStep('translate', 'translate', '英訳を生成中...', 350, 'LLMで字幕翻訳')
        await runStep('subtitle_format', 'subtitle', '字幕ブロックを生成中...', 260, '字幕ブロック整形とCPS計算')

        traces.push(
          {
            nodeId: 'semantic_check',
            status: 'success',
            attempt: 1,
            durationMs: 22,
            provider: 'embedding',
            model: 'text-embedding-3-small',
            summary: '意味近似スコアを算出',
          },
          {
            nodeId: 'terminology_check',
            status: 'success',
            attempt: 1,
            durationMs: 9,
            provider: 'rule-based',
            model: 'glossary-v1',
            summary: '用語漏れ検出',
          },
          {
            nodeId: 'cps_guard',
            status: 'success',
            attempt: 1,
            durationMs: 5,
            provider: 'rule-based',
            model: 'cps-v1',
            summary: 'CPSと42文字制約チェック',
          },
        )

        generated = buildPipelineStubBlocks(sourceName)
        audit = buildAuditReport(generated, traces)
      }

      reset(generated)
      beginWorkLogSession('transcription', generated, { transcriptSegments, video: source })

      const finishedAt = Date.now()
      const metrics = calcPipelineMetrics(generated, startedAt, finishedAt)
      const result: PipelineRunResult = {
        status: 'success',
        step: 'done',
        message: `パイプライン完了（${generated.length}ブロック）`,
        runId: managedRunId,
        sourceName,
        startedAt,
        finishedAt,
        metrics,
        audit,
        debug: {
          sourceMedia: {
            name: source.name,
            path: source.path,
            mode: adminSettings.serviceMode,
          },
          settingsSnapshot: sanitizeAdminSettings(adminSettings),
          initialBlocks: initialBlocksSnapshot,
          finalBlocks: cloneBlocks(generated),
          progressEvents,
          stageSnapshots,
          transcriptSegments,
          transcriptMetadata,
        },
      }
      progressEvents.push({
        at: finishedAt,
        status: 'success',
        step: 'done',
        message: result.message,
        runId: managedRunId,
      })
      latestPipelineDebugRef.current = result.debug
      const uiSafeResult = toUiSafePipelineRun(result)
      const nextHistory = [uiSafeResult, ...pipelineHistory].slice(0, 20)
      setPipelineRun(uiSafeResult)
      setPipelineHistory(nextHistory)
      persistSessionSnapshot({
        blocks: generated,
        pipelineRun: uiSafeResult,
        pipelineHistory: nextHistory,
        videoSource: source,
      })
    } catch (err) {
      const finishedAt = Date.now()
      const pipelineDebug = getPipelineClientDebug(err)
      transcriptSegments = transcriptSegments ?? pipelineDebug.transcriptSegments
      transcriptMetadata = transcriptMetadata ?? pipelineDebug.transcriptMetadata
      stageSnapshots = stageSnapshots ?? pipelineDebug.stageSnapshots
      progressEvents.push({
        at: finishedAt,
        status: 'error',
        step: 'done',
        message: describeError(err),
        runId: managedRunId,
      })
      const result: PipelineRunResult = {
        status: 'error',
        step: 'done',
        message: `パイプライン失敗: ${describeError(err)}`,
        runId: managedRunId,
        sourceName,
        startedAt,
        finishedAt,
        audit: {
          mustReviewCount: 1,
          shouldReviewCount: 0,
          autoPassCount: 0,
          reviewItems: [
            {
              id: 'pipeline-error',
              nodeId: 'pipeline',
              reason: describeError(err),
              priority: 'must_review',
              score: 0,
            },
          ],
          nodeTraces: traces,
        },
        debug: {
          sourceMedia: {
            name: source.name,
            path: source.path,
            mode: adminSettings.serviceMode,
          },
          settingsSnapshot: sanitizeAdminSettings(adminSettings),
          initialBlocks: initialBlocksSnapshot,
          finalBlocks: cloneBlocks(blocks),
          progressEvents,
          stageSnapshots,
          transcriptSegments,
          transcriptMetadata,
        },
      }
      latestPipelineDebugRef.current = result.debug
      const uiSafeResult = toUiSafePipelineRun(result)
      const nextHistory = [uiSafeResult, ...pipelineHistory].slice(0, 20)
      setPipelineRun(uiSafeResult)
      setPipelineHistory(nextHistory)
      persistSessionSnapshot({
        pipelineRun: uiSafeResult,
        pipelineHistory: nextHistory,
        videoSource: source,
      })
    }
  }, [adminSettings, beginWorkLogSession, blocks, buildAuditReport, buildPipelineStubBlocks, calcPipelineMetrics, glossary, persistSessionSnapshot, pipelineHistory, reset, selfMadeGlossary, sleep])

  const buildSessionExport = useCallback((): SessionExportData => ({
    version: 2,
    savedAt: new Date().toISOString(),
    blocks: cloneBlocks(blocks),
    session: {
      videoSource: videoSource
        ? {
            name: videoSource.name,
            path: videoSource.path,
          }
        : null,
      adminSettings: sanitizeAdminSettings(adminSettings),
      pipelineRun: latestPipelineDebugRef.current
        ? {
            ...pipelineRun,
            debug: latestPipelineDebugRef.current,
          }
        : pipelineRun,
      pipelineHistory,
      workLog: getWorkLogExport() ?? undefined,
    },
  }), [adminSettings, blocks, pipelineHistory, pipelineRun, videoSource, getWorkLogExport])

  const handleExportSrt = useCallback(() => {
    exportSrt(blocks, adminSettings)
    toast.success('exportSrt')
  }, [adminSettings, blocks, toast])

  const handleExportProjectJson = useCallback(() => {
    exportProjectJson(buildSessionExport())
    toast.success('saveProjectJson')
  }, [buildSessionExport, toast])

  const confirmAndLoadVideo = useCallback((name: string, doLoad: () => void) => {
    if (blocks.length > 0) {
      setPendingVideoLoad({ name, load: doLoad })
      return
    }
    doLoad()
  }, [blocks.length])

  const handleVideoInput = useCallback((file: File) => {
    confirmAndLoadVideo(file.name, () => loadVideoFile(file))
  }, [confirmAndLoadVideo, loadVideoFile])

  const handleVideoPathInput = useCallback((path: string) => {
    const name = path.split(/[\\/]/).pop() ?? path
    confirmAndLoadVideo(name, () => loadVideoPath(path))
  }, [confirmAndLoadVideo, loadVideoPath])

  const handleVideoPlaybackError = useCallback(() => {
    onVideoError()
    if (!videoDiagnostic?.fallbackUrl || videoDiagnostic.fallbackAttempted || videoUrl === videoDiagnostic.fallbackUrl) {
      return
    }
    const fallbackUrl = videoDiagnostic.fallbackUrl
    console.warn('[video][diag] asset video error; switching to localhost fallback', {
      failedUrl: videoUrl,
      fallbackUrl,
      assetReachable: videoDiagnostic.assetReachable,
      assetHeadStatus: videoDiagnostic.assetHeadStatus,
      fallbackHeadStatus: videoDiagnostic.fallbackHeadStatus,
      fallbackHeadContentType: videoDiagnostic.fallbackHeadContentType,
      file: videoDiagnostic.file,
    })
    setVideoDiagnostic({
      ...videoDiagnostic,
      generatedUrl: fallbackUrl,
      hasEncodedSlash: /%2F/i.test(fallbackUrl),
      fallbackAttempted: true,
    })
    setVideoUrl(prev => {
      if (prev && prev.startsWith('blob:')) URL.revokeObjectURL(prev)
      return fallbackUrl
    })
  }, [onVideoError, videoDiagnostic, videoUrl])

  const handleRunPipelineFromReport = useCallback(() => {
    if (!videoSource) return
    void runDropPipeline(videoSource)
  }, [videoSource, runDropPipeline])

  const handleRightDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    if (e.dataTransfer.types.includes('Files')) setIsDragOverRight(true)
  }, [])

  const handleRightDragLeave = useCallback((e: React.DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node)) return
    setIsDragOverRight(false)
  }, [])

  const handleRightDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOverRight(false)
    const file = e.dataTransfer.files[0]
    if (!file) return
    const name = file.name.toLowerCase()
    // 動画ファイルはTauriネイティブD&Dハンドラに委ねる（ファイルパス取得のため）
    if (isVideoPathLike(name)) return
    lastHtmlDropRef.current = Date.now()
    if (name.endsWith('.srt') || name.endsWith('.txt')) {
      try {
        const imported = await importSrt(file)
        reset(imported)
        beginWorkLogSession('srt_import', imported)
      } catch {
        alert(t.importSrtError)
      }
    } else if (name.endsWith('.json')) {
      try {
        const imported = await importProjectJson(file)
        reset(imported)
        beginWorkLogSession('json_import', imported)
      } catch {
        alert(t.importError)
      }
    } else if (name.endsWith('.xlsx') || name.endsWith('.xls') || name.endsWith('.csv')) {
      // 用語辞書タブへ自動切り替えしてインポート
      setActiveTab('dictionary')
      try {
        let entries
        if (name.endsWith('.csv')) {
          const { parseGlossaryCsv } = await import('@/lib/glossary/csvParser')
          entries = parseGlossaryCsv(await file.text())
        } else {
          const { convertMatsuoLabXlsx } = await import('@/lib/glossary/xlsxConverter')
          entries = await convertMatsuoLabXlsx(file)
        }
        importEntries(entries)
      } catch (err) {
        alert(`用語辞書の読み込みに失敗しました: ${describeError(err)}`)
      }
    } else {
      alert(`非対応のファイル形式です: ${file.name}\n対応形式: .srt, .txt, .json, .csv, .xlsx`)
    }
  }, [reset, beginWorkLogSession, t.importSrtError, t.importError, importEntries])

  // Tauri: ネイティブDrag&Dropのフォールバック（WindowsビルドでHTML5 D&Dが効かない対策）
  useEffect(() => {
    if (!isTauri()) return
    let cancelled = false
    let unlisten: (() => void) | null = null
    getCurrentWebview().onDragDropEvent(async (event) => {
      if (cancelled) return
      if (event.payload.type !== 'drop') return
      if (Date.now() - lastHtmlDropRef.current < 500) return
      const paths = event.payload.paths
      if (!paths || paths.length === 0) return
      const path = paths[0]
      const name = path.toLowerCase()
      try {
        if (isVideoPathLike(name)) {
          handleVideoPathInput(path)
          return
        }
        if (name.endsWith('.srt') || name.endsWith('.txt')) {
          const imported = await importSrt(await readTextFileAsFile(path))
          reset(imported)
          beginWorkLogSession('srt_import', imported)
          return
        }
        if (name.endsWith('.json')) {
          const imported = await importProjectJson(await readTextFileAsFile(path))
          reset(imported)
          beginWorkLogSession('json_import', imported)
          return
        }
        if (name.endsWith('.xlsx') || name.endsWith('.xls') || name.endsWith('.csv')) {
          setActiveTab('dictionary')
          let entries
          if (name.endsWith('.csv')) {
            const { parseGlossaryCsv } = await import('@/lib/glossary/csvParser')
            const file = await readTextFileAsFile(path)
            entries = parseGlossaryCsv(await file.text())
          } else {
            const { convertMatsuoLabXlsx } = await import('@/lib/glossary/xlsxConverter')
            entries = await convertMatsuoLabXlsx(await readBinaryFileAsFile(path))
          }
          importEntries(entries)
          return
        }
        alert(`非対応のファイル形式です: ${path}
対応形式: .srt, .txt, .json, .csv, .xlsx, ${VIDEO_EXTENSIONS.join(', ')}`)
      } catch (err) {
        alert(`読み込みに失敗しました: ${describeError(err)}`)
      }
    }).then(fn => {
      if (cancelled) fn()  // すでにアンマウント済みなら即解除
      else unlisten = fn
    })
    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [reset, beginWorkLogSession, importEntries, handleVideoPathInput, readTextFileAsFile, readBinaryFileAsFile])

  const handleLoadVideo = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    handleVideoInput(file)
    e.target.value = ''
  }, [handleVideoInput])

  // Tauri環境ではdialog APIでパスを取得（HTMLのFileオブジェクトだとpathが取れず
  // S3アップロードでブラウザfetchに落ちてLinuxのtauri://オリジン拒否で失敗する）
  const handleOpenVideoFile = useCallback(async () => {
    if (!isTauri()) {
      videoFileRef.current?.click()
      return
    }
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const selected = await open({
        multiple: false,
        directory: false,
        filters: [{ name: 'Video', extensions: ['mp4', 'mov', 'mkv', 'webm', 'm4v', 'avi'] }],
      })
      if (typeof selected === 'string' && selected) {
        handleVideoPathInput(selected)
      }
    } catch (err) {
      console.error('failed to open video dialog', err)
      videoFileRef.current?.click()
    }
  }, [handleVideoPathInput])

  // I/O ショートカット用: currentTime は毎フレーム変わるため ref で保持
  const currentTimeRef = useRef(currentTime)
  useEffect(() => { currentTimeRef.current = currentTime }, [currentTime])

  // 変更のたびに debounce 自動保存（1秒後）
  useEffect(() => {
    setSaveStatus('saving')
    const timerId = setTimeout(() => {
      saveToLocalStorage(blocks)
      setSaveStatus('saved')
    }, 1000)
    return () => clearTimeout(timerId)
  }, [blocks])

  // 起動時: 進行中ワークログセッションがあれば継続再開する
  useEffect(() => {
    seedWorkLogSeen(blocks)
    void workLog.resumeFromPersisted(adminSettings.workLogDir)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // blocks の editHistory 差分をワークログへ追記（手動編集・ブロック系譜）
  useEffect(() => {
    if (!getWorkLogSessionId()) return
    const seen = workLogSeenRef.current
    const splitGroups = new Map<string, { parentId: number; children: number[] }>()
    for (const block of blocks) {
      for (const entry of block.editHistory ?? []) {
        if (entry.type === 'split') {
          // 同じ at の split は子ブロックごとに複製される → at 単位でまとめる
          const parentId = readNum(entry.before, 'id') ?? block.id
          const group = splitGroups.get(entry.at) ?? { parentId, children: [] }
          if (!group.children.includes(block.id)) group.children.push(block.id)
          splitGroups.set(entry.at, group)
          continue
        }
        const key = workLogDedupeKey(entry)
        if (seen.has(key)) continue
        seen.add(key)
        if (entry.type === 'merge') {
          const parents = [
            readNestedNum(entry.before, 'first', 'id'),
            readNestedNum(entry.before, 'second', 'id'),
          ].filter((n): n is number => n !== undefined)
          recordWorkLogEvent({
            category: 'lineage',
            type: 'merge',
            at: entry.at,
            blockId: block.id,
            parentBlockIds: parents,
            childBlockId: block.id,
            before: entry.before,
            after: entry.after,
          })
        } else {
          recordWorkLogEvent({
            category: 'manual_edit',
            type: entry.type,
            at: entry.at,
            blockId: block.id,
            before: entry.before,
            after: entry.after,
          })
        }
      }
    }
    for (const [at, group] of splitGroups) {
      const key = `split:${at}`
      if (seen.has(key)) continue
      seen.add(key)
      recordWorkLogEvent({
        category: 'lineage',
        type: 'split',
        at,
        parentBlockId: group.parentId,
        childBlockIds: group.children,
      })
    }
  }, [blocks, recordWorkLogEvent, getWorkLogSessionId])

  // 復元メッセージを3秒後に消す
  useEffect(() => {
    if (!restoredMsg) return
    const t = setTimeout(() => setRestoredMsg(false), 3000)
    return () => clearTimeout(t)
  }, [restoredMsg])

  const handleImportJson = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const imported = await importProjectJson(file)
      reset(imported)
      beginWorkLogSession('json_import', imported)
    } catch {
      alert(t.importError)
    }
    e.target.value = ''
  }, [reset, beginWorkLogSession, t.importError])

  const handleImportSrt = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const imported = await importSrt(file)
      reset(imported)
      beginWorkLogSession('srt_import', imported)
    } catch {
      alert(t.importSrtError)
    }
    e.target.value = ''
  }, [reset, beginWorkLogSession, t.importSrtError])

  const handleBlockSelect = useCallback((id: number) => {
    const block = blocks.find(b => b.id === id)
    if (block) seekTo(block.startTime)
  }, [blocks, seekTo])

  const handleApprove = useCallback((id: number) => {
    push(blocks.map(b => {
      if (b.id !== id) return b
      const nextStatus = b.status === 'approved' ? 'pending' as const : 'approved' as const
      return withEditHistory(
        { ...b, status: nextStatus },
        'approve',
        { status: b.status },
        { status: nextStatus },
      )
    }))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocks])

  const handleFlag = useCallback((id: number) => {
    push(blocks.map(b => {
      if (b.id !== id) return b
      const nextStatus = b.status === 'flagged' ? 'pending' as const : 'flagged' as const
      return withEditHistory(
        { ...b, status: nextStatus },
        'flag',
        { status: b.status },
        { status: nextStatus },
      )
    }))
  }, [blocks, push])

  const handleReSplit = useCallback((id: number) => {
    alert(t.reSplitAlert(id))
  }, [t])

  const handleReTranslate = useCallback((id: number) => {
    alert(t.reTranslateAlert(id))
  }, [t])

  /** テキストを単語境界（最近接スペース）で2分割するユーティリティ */
  const splitAtWordBoundary = useCallback((text: string, targetIdx: number): [string, string] => {
    let bestIdx = targetIdx
    let bestDist = Infinity
    for (let i = 0; i < text.length; i++) {
      if (text[i] === ' ') {
        const d = Math.abs(i - targetIdx)
        if (d < bestDist) { bestDist = d; bestIdx = i }
      }
    }
    const before = text.slice(0, bestIdx).trim()
    const after  = text.slice(bestIdx + 1).trim()
    if (!before || !after) {
      return [text.slice(0, targetIdx).trim(), text.slice(targetIdx).trim()]
    }
    return [before, after]
  }, [])

  const makeSplitBlocks = useCallback((
    block: SubtitleBlock,
    splitTime: number,
    textBefore: string,
    textAfter: string,
  ): [SubtitleBlock, SubtitleBlock] => {
    const dur1 = Math.max(0.01, splitTime - block.startTime)
    const dur2 = Math.max(0.01, block.endTime - splitTime)
    const newId = Math.max(...blocks.map(b => b.id)) + 1
    const b1: SubtitleBlock = {
      ...block,
      endTime: splitTime,
      source: textBefore,
      cps: Math.round(textBefore.length / dur1 * 10) / 10,
      charCount: textBefore.length,
    }
    const b2: SubtitleBlock = {
      ...block,
      id: newId,
      startTime: splitTime,
      source: textAfter,
      cps: Math.round(textAfter.length / dur2 * 10) / 10,
      charCount: textAfter.length,
      status: 'pending' as const,
      glossaryTerms: [],
    }
    return [b1, b2]
  }, [blocks])

  const handleManualSplit = useCallback((id: number, textBefore: string, textAfter: string) => {
    const idx = blocks.findIndex(b => b.id === id)
    if (idx === -1) return
    const block = blocks[idx]
    const ratio = textBefore.length / Math.max(1, textBefore.length + textAfter.length)
    const splitTime = block.startTime + (block.endTime - block.startTime) * ratio
    const [rawB1, rawB2] = makeSplitBlocks(block, splitTime, textBefore, textAfter)
    const before = { id: block.id, source: block.source, startTime: block.startTime, endTime: block.endTime }
    const b1 = withEditHistory(rawB1, 'split', before, { part: 'first', source: rawB1.source, startTime: rawB1.startTime, endTime: rawB1.endTime })
    const b2 = withEditHistory(rawB2, 'split', before, { part: 'second', source: rawB2.source, startTime: rawB2.startTime, endTime: rawB2.endTime })
    const next = [...blocks]
    next.splice(idx, 1, b1, b2)
    push(next)
  }, [blocks, push, makeSplitBlocks])

  /** 再生位置で分割: 時間は currentTime、テキストは時間比率に最近接の単語境界 */
  const handleSplitAtPlayhead = useCallback((id: number) => {
    const idx = blocks.findIndex(b => b.id === id)
    if (idx === -1) return
    const block = blocks[idx]
    const splitTime = currentTimeRef.current
    if (splitTime <= block.startTime || splitTime >= block.endTime) return
    const ratio = (splitTime - block.startTime) / (block.endTime - block.startTime)
    const [textBefore, textAfter] = splitAtWordBoundary(block.source, Math.round(block.source.length * ratio))
    const [rawB1, rawB2] = makeSplitBlocks(block, splitTime, textBefore, textAfter)
    const before = { id: block.id, source: block.source, startTime: block.startTime, endTime: block.endTime }
    const b1 = withEditHistory(rawB1, 'split', before, { method: 'playhead', part: 'first', source: rawB1.source, startTime: rawB1.startTime, endTime: rawB1.endTime })
    const b2 = withEditHistory(rawB2, 'split', before, { method: 'playhead', part: 'second', source: rawB2.source, startTime: rawB2.startTime, endTime: rawB2.endTime })
    const next = [...blocks]
    next.splice(idx, 1, b1, b2)
    push(next)
  }, [blocks, push, splitAtWordBoundary, makeSplitBlocks])

  /** 均等割り: 時間を2等分、テキストは中点に最近接の単語境界 */
  const handleEqualSplit = useCallback((id: number) => {
    const idx = blocks.findIndex(b => b.id === id)
    if (idx === -1) return
    const block = blocks[idx]
    const splitTime = (block.startTime + block.endTime) / 2
    const [textBefore, textAfter] = splitAtWordBoundary(block.source, Math.round(block.source.length / 2))
    const [rawB1, rawB2] = makeSplitBlocks(block, splitTime, textBefore, textAfter)
    const before = { id: block.id, source: block.source, startTime: block.startTime, endTime: block.endTime }
    const b1 = withEditHistory(rawB1, 'split', before, { method: 'equal', part: 'first', source: rawB1.source, startTime: rawB1.startTime, endTime: rawB1.endTime })
    const b2 = withEditHistory(rawB2, 'split', before, { method: 'equal', part: 'second', source: rawB2.source, startTime: rawB2.startTime, endTime: rawB2.endTime })
    const next = [...blocks]
    next.splice(idx, 1, b1, b2)
    push(next)
  }, [blocks, push, splitAtWordBoundary, makeSplitBlocks])

  const handleMerge = useCallback((dragId: number, dropId: number) => {
    const dragIdx = blocks.findIndex(b => b.id === dragId)
    const dropIdx = blocks.findIndex(b => b.id === dropId)
    if (dragIdx === -1 || dropIdx === -1) return
    if (Math.abs(dragIdx - dropIdx) !== 1) return

    const firstIdx = Math.min(dragIdx, dropIdx)
    const secondIdx = Math.max(dragIdx, dropIdx)
    const first = blocks[firstIdx]
    const second = blocks[secondIdx]
    const mergedText = joinTextParts([first.source, second.source])
    const mergedTarget = joinTextParts([first.target, second.target])
    const duration = second.endTime - first.startTime
    const merged: SubtitleBlock = withEditHistory(
      {
        ...first,
        endTime: second.endTime,
        target: mergedTarget,
        source: mergedText,
        cps: duration > 0 ? Math.round(mergedText.length / duration * 10) / 10 : 0,
        charCount: mergedText.length,
        status: 'pending',
        glossaryTerms: [...first.glossaryTerms, ...second.glossaryTerms],
        correctionAttempts: [
          ...(first.correctionAttempts ?? []),
          ...(second.correctionAttempts ?? []),
        ].slice(-10),
        editHistory: [
          ...(first.editHistory ?? []),
          ...(second.editHistory ?? []),
        ].slice(-49),
      },
      'merge',
      {
        method: dragIdx < dropIdx ? 'manual_merge_next' : 'manual_merge_previous',
        first: { id: first.id, source: first.source, target: first.target, startTime: first.startTime, endTime: first.endTime },
        second: { id: second.id, source: second.source, target: second.target, startTime: second.startTime, endTime: second.endTime },
      },
      {
        id: first.id,
        source: mergedText,
        target: mergedTarget,
        startTime: first.startTime,
        endTime: second.endTime,
      },
    )
    const next = blocks.filter((_, i) => i !== secondIdx)
    next[firstIdx] = merged
    push(next)
  }, [blocks, push])

  // キーボードショートカット（handleMerge 定義後）
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // 入力フィールド内ではスキップ
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return

      // I: イン点マーク — アクティブブロックの開始時刻を再生位置にセット
      if (e.key === 'i' && !e.ctrlKey && !e.metaKey) {
        if (activeBlockId === null) return
        const block = blocks.find(b => b.id === activeBlockId)
        if (!block || block.status === 'approved') return
        const newStart = currentTimeRef.current
        if (newStart >= block.endTime) return
        push(updateTimesWithNeighborAdjust(blocks, activeBlockId, newStart, block.endTime))
        return
      }

      // O: アウト点マーク — アクティブブロックの終了時刻を再生位置にセット
      if (e.key === 'o' && !e.ctrlKey && !e.metaKey) {
        if (activeBlockId === null) return
        const block = blocks.find(b => b.id === activeBlockId)
        if (!block || block.status === 'approved') return
        const newEnd = currentTimeRef.current
        if (newEnd <= block.startTime) return
        push(updateTimesWithNeighborAdjust(blocks, activeBlockId, block.startTime, newEnd))
        return
      }

      if (!(e.ctrlKey || e.metaKey)) return
      if (e.key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return }
      if (e.key === 'z' && e.shiftKey)  { e.preventDefault(); redo(); return }
      if (e.key === 'y')                 { e.preventDefault(); redo(); return }
      if (e.key === 'm' || e.key === 'M') {
        e.preventDefault()
        if (activeBlockId === null) return
        const idx = blocks.findIndex(b => b.id === activeBlockId)
        if (idx === -1) return
        const current = blocks[idx]
        if (current.status === 'approved') return
        if (!e.shiftKey) {
          const next = blocks[idx + 1]
          if (next && next.status !== 'approved') handleMerge(current.id, next.id)
        } else {
          const prev = blocks[idx - 1]
          if (prev && prev.status !== 'approved') handleMerge(prev.id, current.id)
        }
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [undo, redo, activeBlockId, blocks, handleMerge, push])

  const handleUpdateTimes = useCallback((id: number, startTime: number, endTime: number) => {
    push(updateTimesWithNeighborAdjust(blocks, id, startTime, endTime))
  }, [blocks, push])

  const handleAdjustBoundary = useCallback((id1: number, id2: number, newTime: number) => {
    push(blocks.map(b => {
      if (b.id === id1) {
        const dur = Math.max(0.01, newTime - b.startTime)
        return withEditHistory(
          { ...b, endTime: newTime, cps: Math.round(b.charCount / dur * 10) / 10 },
          'time_edit',
          { startTime: b.startTime, endTime: b.endTime },
          { startTime: b.startTime, endTime: newTime },
        )
      }
      if (b.id === id2) {
        const dur = Math.max(0.01, b.endTime - newTime)
        return withEditHistory(
          { ...b, startTime: newTime, cps: Math.round(b.charCount / dur * 10) / 10 },
          'time_edit',
          { startTime: b.startTime, endTime: b.endTime },
          { startTime: newTime, endTime: b.endTime },
        )
      }
      return b
    }))
  }, [blocks, push])

  const handleUpdateTarget = useCallback((id: number, text: string) => {
    push(blocks.map(b => b.id !== id ? b : withEditHistory(
      { ...b, target: text },
      'target_edit',
      { target: b.target },
      { target: text },
    )))
  }, [blocks, push])

  /** ターゲット分割: targetBefore/After で2ブロックに分割。sourceは両方コピー */
  const handleSplitFromTarget = useCallback((id: number, targetBefore: string, targetAfter: string) => {
    const idx = blocks.findIndex(b => b.id === id)
    if (idx === -1) return
    const block = blocks[idx]
    const ratio = targetBefore.length / Math.max(1, targetBefore.length + targetAfter.length)
    const splitTime = block.startTime + (block.endTime - block.startTime) * ratio
    const dur1 = Math.max(0.01, splitTime - block.startTime)
    const dur2 = Math.max(0.01, block.endTime - splitTime)
    const newId = Math.max(...blocks.map(b => b.id)) + 1
    const before = { id: block.id, target: block.target, startTime: block.startTime, endTime: block.endTime }
    const b1: SubtitleBlock = withEditHistory(
      {
        ...block,
        endTime: splitTime,
        target: targetBefore,
        // source はそのままコピー（言語が違うため比率分割しない）
        cps: Math.round(block.source.length / dur1 * 10) / 10,
      },
      'split',
      before,
      { part: 'first', target: targetBefore, startTime: block.startTime, endTime: splitTime },
    )
    const b2: SubtitleBlock = withEditHistory(
      {
        ...block,
        id: newId,
        startTime: splitTime,
        target: targetAfter,
        // source はそのままコピー
        cps: Math.round(block.source.length / dur2 * 10) / 10,
        status: 'pending' as const,
        glossaryTerms: [],
      },
      'split',
      before,
      { part: 'second', target: targetAfter, startTime: splitTime, endTime: block.endTime },
    )
    const next = [...blocks]
    next.splice(idx, 1, b1, b2)
    push(next)
  }, [blocks, push])

  const handleUpdateSource = useCallback((id: number, text: string) => {
    push(blocks.map(b => {
      if (b.id !== id) return b
      const duration = b.endTime - b.startTime
      return withEditHistory(
        { ...b, source: text, cps: Math.round(text.length / Math.max(0.1, duration) * 10) / 10, charCount: text.length },
        'source_edit',
        { source: b.source },
        { source: text },
      )
    }))
  }, [blocks, push])

  const handleIgnoreWarning = useCallback((id: number, type: 'typo' | 'missing', key: string) => {
    push(blocks.map(b => {
      if (b.id !== id) return b
      if (type === 'typo') {
        const cur = b.ignoredTypos ?? []
        const next = cur.includes(key) ? cur.filter(k => k !== key) : [...cur, key]
        return withEditHistory(
          { ...b, ignoredTypos: next },
          'ignore_warning',
          { type, ignoredTypos: cur },
          { type, ignoredTypos: next },
        )
      } else {
        const cur = b.ignoredMissing ?? []
        const next = cur.includes(key) ? cur.filter(k => k !== key) : [...cur, key]
        return withEditHistory(
          { ...b, ignoredMissing: next },
          'ignore_warning',
          { type, ignoredMissing: cur },
          { type, ignoredMissing: next },
        )
      }
    }))
  }, [blocks, push])

  const handleApplyGlossary = useCallback(() => {
    const confirmed = glossary.filter(g => g.confirmed)
    let totalReplacements = 0
    let blocksUpdated = 0
    const updated = blocks.map(block => {
      if (block.status === 'approved') return block
      const result = applyGlossaryToText(block.source, confirmed)
      if (!result.changed) return block
      const duration = block.endTime - block.startTime
      totalReplacements += result.replacements.length
      blocksUpdated++
      return {
        ...block,
        source: result.text,
        cps: Math.round(result.text.length / Math.max(0.1, duration) * 10) / 10,
        charCount: result.text.length,
      }
    })
    if (blocksUpdated > 0) push(updated)
    return { blocksUpdated, replacements: totalReplacements }
  }, [blocks, glossary, push])

  const currentBlock = blocks.find(b => currentTime >= b.startTime && currentTime < b.endTime)
  const subtitleOverlay = currentBlock
    ? {
        text: draftSource?.id === currentBlock.id ? draftSource.text : currentBlock.source,
        progress: ((currentTime - currentBlock.startTime) / Math.max(0.01, currentBlock.endTime - currentBlock.startTime)) * 100,
      }
    : null

  const approvedCount = blocks.filter(b => b.status === 'approved').length

  return (
    <div className="h-screen overflow-hidden" style={{
      background: theme.appBg,
      color: theme.textPrimary,
      fontFamily: '"Inter", "Noto Sans JP", sans-serif',
    }}>
      {/* 復元通知 */}
      {restoredMsg && (
        <div style={{
          position: 'fixed', top: 10, left: '50%', transform: 'translateX(-50%)',
          background: theme.restoreBg, border: `1px solid ${theme.restoreBorder}`, borderRadius: 8,
          padding: '6px 16px', fontSize: 12, color: theme.restoreText, zIndex: 9999,
          pointerEvents: 'none',
        }}>
          {t.restored}
        </div>
      )}
      {pendingVideoLoad && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="video-load-choice-title"
          onClick={() => setPendingVideoLoad(null)}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 10000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 16,
            background: theme.id === 'poc' ? 'rgba(2,6,16,0.82)' : 'rgba(20,24,32,0.45)',
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              width: 'min(480px, 100%)',
              borderRadius: 8,
              border: `1px solid ${theme.panelBorder}`,
              background: theme.id === 'poc' ? '#121a2b' : '#ffffff',
              boxShadow: '0 16px 40px rgba(0,0,0,0.35)',
              padding: 16,
              display: 'grid',
              gap: 12,
            }}
          >
            <div id="video-load-choice-title" style={{ fontSize: 15, fontWeight: 700, color: theme.textPrimary }}>
              {t.videoLoadChoiceTitle}
            </div>
            <div style={{ fontSize: 12, lineHeight: 1.7, color: theme.textSecondary }}>
              {t.videoLoadChoiceDesc(pendingVideoLoad.name, blocks.length)}
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
              <button
                type="button"
                onClick={() => setPendingVideoLoad(null)}
                style={{
                  border: `1px solid ${theme.btnBorder}`,
                  background: theme.btnBg,
                  color: theme.btnText,
                  borderRadius: 6,
                  padding: '7px 10px',
                  fontSize: 12,
                  cursor: 'pointer',
                }}
              >
                {t.videoLoadCancel}
              </button>
              <button
                type="button"
                onClick={() => {
                  const pending = pendingVideoLoad
                  setPendingVideoLoad(null)
                  pending.load()
                }}
                style={{
                  border: `1px solid ${theme.btnBorder}`,
                  background: theme.btnBg,
                  color: theme.btnText,
                  borderRadius: 6,
                  padding: '7px 10px',
                  fontSize: 12,
                  cursor: 'pointer',
                }}
              >
                {t.videoLoadKeep}
              </button>
              <button
                type="button"
                onClick={() => {
                  const pending = pendingVideoLoad
                  setPendingVideoLoad(null)
                  reset([])
                  pending.load()
                }}
                style={{
                  border: `1px solid ${theme.accent}`,
                  background: theme.accent,
                  color: '#fff',
                  borderRadius: 6,
                  padding: '7px 10px',
                  fontSize: 12,
                  fontWeight: 700,
                  cursor: 'pointer',
                }}
              >
                {t.videoLoadReset}
              </button>
            </div>
          </div>
        </div>
      )}
      <main
        ref={mainRef}
        className="flex h-full p-[10px]"
        style={{ gap: 0 }}
      >

        {/* 左：動画パネル */}
        <section className="flex flex-col overflow-hidden rounded-[10px] shadow-[0_6px_20px_rgba(0,0,0,0.28)]"
          style={{ background: theme.panelBg, border: `1px solid ${theme.panelBorder}`, position: 'relative', zIndex: 1, width: `${leftPct}%`, flexShrink: 0 }}>
          <div className="px-[14px] py-[10px] text-[14px] font-semibold shrink-0 tracking-[0.2px] flex items-center"
            style={{ borderBottom: `1px solid ${theme.panelBorder}`, background: theme.headerBg, color: theme.textPrimary }}>
            {t.videoPlayer}
            <input ref={videoFileRef} type="file" accept="video/*" onChange={handleLoadVideo} style={{ display: 'none' }} />
            <button
              className="flex items-center gap-1 ml-auto"
              onClick={handleOpenVideoFile}
              style={{
                fontSize: 11, color: theme.textSecondary, padding: '3px 8px',
                borderRadius: 5, border: `1px solid ${theme.panelBorder}`,
                background: theme.btnBg, cursor: 'pointer', fontWeight: 400,
              }}
            >
              <Film size={11} />
              動画を読み込む
            </button>
          </div>
          <VideoPlayer
            videoRef={videoRef}
            videoUrl={videoUrl}
            currentTime={currentTime}
            isPlaying={isPlaying}
            totalDuration={duration}
            onLoadVideo={handleVideoInput}
            preferNativeVideoDrop={isTauri()}
            videoDiagnostic={videoDiagnostic}
            onTogglePlay={togglePlay}
            onSeek={seekTo}
            subtitleOverlay={subtitleOverlay}
            blocks={blocks}
            onTimeUpdate={onTimeUpdate}
            onPlay={onPlay}
            onPause={onPause}
            onLoadedMetadata={onLoadedMetadata}
            onError={handleVideoPlaybackError}
          />
          {/* 縦リサイズハンドル (動画 ↕ タイムライン) */}
          <div
            style={{
              height: 6,
              flexShrink: 0,
              cursor: 'row-resize',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: theme.panelBorder,
            }}
            onMouseDown={handleVResizeMouseDown}
          >
            <div style={{ width: 32, height: 2, borderRadius: 1, background: theme.textDisabled, opacity: 0.5 }} />
          </div>
          <TimelineBar
            blocks={blocks}
            currentTime={currentTime}
            totalDuration={duration}
            activeBlockId={activeBlockId}
            onSeek={seekTo}
            onBlockSelect={handleBlockSelect}
            onAdjustBoundary={handleAdjustBoundary}
            trackHeight={timelineH}
            maxCps={adminSettings.enMaxCps}
          />
        </section>

        {/* 横リサイズハンドル */}
        <div
          style={{
            width: 10,
            flexShrink: 0,
            cursor: 'col-resize',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 10,
          }}
          onMouseDown={handleHResizeMouseDown}
        >
          <div style={{ width: 2, height: 40, borderRadius: 1, background: theme.panelBorder, opacity: 0.7 }} />
        </div>

        {/* 右：タブパネル */}
        <section className="flex flex-col overflow-hidden rounded-[10px] shadow-[0_6px_20px_rgba(0,0,0,0.28)]"
          style={{ background: theme.panelBg, border: `1px solid ${theme.panelBorder}`, position: 'relative', zIndex: 2, flex: 1, minWidth: 0 }}
          onDragOver={handleRightDragOver}
          onDragLeave={handleRightDragLeave}
          onDrop={handleRightDrop}
        >
          {/* SRT/JSONドロップオーバーレイ */}
          {isDragOverRight && (
            <div style={{
              position: 'absolute', inset: 0, zIndex: 100,
              background: 'rgba(99,102,241,0.13)',
              border: '2px dashed rgba(99,102,241,0.7)',
              borderRadius: 10,
              display: 'flex', flexDirection: 'column',
              alignItems: 'center', justifyContent: 'center',
              gap: 8, pointerEvents: 'none',
            }}>
              <span style={{ fontSize: 32 }}>📄</span>
              <span style={{ color: 'rgba(99,102,241,0.9)', fontSize: 13, fontWeight: 600 }}>
                SRT / JSON をドロップして読み込む
              </span>
            </div>
          )}

          {/* タブ行 */}
          <div className="flex items-center shrink-0" style={{ borderBottom: `1px solid ${theme.panelBorder}`, background: theme.headerBg }}>
            {(['subtitles', 'dictionary', 'help', 'report'] as Tab[]).map(tab => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                style={{
                  padding: '10px 12px',
                  fontSize: 12,
                  fontWeight: 600,
                  whiteSpace: 'nowrap',
                  flexShrink: 0,
                  color: activeTab === tab ? theme.accent : theme.textSecondary,
                  background: 'none',
                  border: 'none',
                  borderBottomWidth: 2,
                  borderBottomStyle: 'solid',
                  borderBottomColor: activeTab === tab ? theme.accent : 'transparent',
                  cursor: 'pointer',
                  marginBottom: -1,
                }}
              >
                {tab === 'subtitles'
                  ? t.tabSubtitles
                  : tab === 'dictionary'
                    ? t.tabDictionary
                    : tab === 'help'
                      ? t.tabHelp
                      : t.tabReport}
              </button>
            ))}

            <div className="ml-auto flex items-center gap-1 pr-1 shrink-0">
              <button onClick={undo} disabled={!canUndo} title="元に戻す (Ctrl+Z)"
                style={{ fontSize: 13, padding: '2px 6px', borderRadius: 5, border: `1px solid ${theme.panelBorder}`, background: theme.btnBg, color: canUndo ? theme.textSecondary : theme.textDisabled, cursor: canUndo ? 'pointer' : 'not-allowed', lineHeight: 1 }}>↩</button>
              <button onClick={redo} disabled={!canRedo} title="やり直し (Ctrl+Shift+Z)"
                style={{ fontSize: 13, padding: '2px 6px', borderRadius: 5, border: `1px solid ${theme.panelBorder}`, background: theme.btnBg, color: canRedo ? theme.textSecondary : theme.textDisabled, cursor: canRedo ? 'pointer' : 'not-allowed', lineHeight: 1 }}>↪</button>
              <span style={{ fontSize: 10, color: saveStatus === 'saving' ? theme.savingColor : theme.savedColor, transition: 'color 0.3s', whiteSpace: 'nowrap', padding: '0 4px' }}>
                {saveStatus === 'saving' ? t.saving : t.saved}
              </span>
              <button onClick={() => setActiveTab('settings')} title="設定"
                style={{ padding: '8px 10px', background: 'none', border: 'none', borderBottom: `2px solid ${activeTab === 'settings' ? theme.accent : 'transparent'}`, color: activeTab === 'settings' ? theme.accent : theme.textSecondary, cursor: 'pointer', marginBottom: -1, display: 'flex', alignItems: 'center' }}>
                <Settings size={15} />
              </button>
            </div>
          </div>

          {/* タブ別アクションバー */}
          <div className="flex items-center shrink-0" style={{ borderBottom: `1px solid ${theme.panelBorder}`, background: theme.headerBg, padding: '4px 8px', gap: 6, minHeight: 32 }}>
            {/* 隠しファイル入力 */}
            <input ref={importRef} type="file" accept=".json" onChange={handleImportJson} style={{ display: 'none' }} />
            <input ref={srtImportRef} type="file" accept=".srt,.txt" onChange={handleImportSrt} style={{ display: 'none' }} />

            {activeTab === 'subtitles' && (<>
              <button onClick={() => srtImportRef.current?.click()} title={t.loadSrtTitle}
                style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, whiteSpace: 'nowrap', color: theme.textSecondary, padding: '3px 8px', borderRadius: 5, border: `1px solid ${theme.panelBorder}`, background: theme.btnBg, cursor: 'pointer' }}>
                <FolderOpen size={11} />SRT読込
              </button>
              <button onClick={handleExportSrt} title={t.exportSrtTitle}
                style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, whiteSpace: 'nowrap', color: theme.textSecondary, padding: '3px 8px', borderRadius: 5, border: `1px solid ${theme.panelBorder}`, background: theme.btnBg, cursor: 'pointer' }}>
                <Download size={11} />SRT出力
              </button>
              <div style={{ width: 1, background: theme.panelBorder, alignSelf: 'stretch', margin: '2px 2px' }} />
              <button onClick={() => importRef.current?.click()} title={t.loadProjectTitle}
                style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, whiteSpace: 'nowrap', color: theme.textSecondary, padding: '3px 8px', borderRadius: 5, border: `1px solid ${theme.panelBorder}`, background: theme.btnBg, cursor: 'pointer' }}>
                <FolderOpen size={11} />JSON読込
              </button>
              <button onClick={handleExportProjectJson} title={t.saveProjectTitle}
                style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, whiteSpace: 'nowrap', color: theme.textSecondary, padding: '3px 8px', borderRadius: 5, border: `1px solid ${theme.panelBorder}`, background: theme.btnBg, cursor: 'pointer' }}>
                <Save size={11} />JSON保存
              </button>
              {blocks.length > 0 && (
                <span style={{ marginLeft: 6, fontSize: 11, color: theme.textMuted, whiteSpace: 'nowrap' }}>
                  <span style={{ color: approvedCount === blocks.length ? '#22c55e' : theme.textSecondary, fontWeight: 600 }}>
                    {approvedCount}
                  </span>
                  <span style={{ color: theme.textMuted }}>/{blocks.length}件承認</span>
                </span>
              )}
            </>)}
          </div>


          {activeTab === 'subtitles' && (pipelineRun.status !== 'idle' || pipelineStatusPinned) && (
            <div
              className="shrink-0"
              style={{
                borderBottom: `1px solid ${theme.panelBorder}`,
                background: theme.cardBg,
                padding: '8px 10px',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11 }}>
                <span
                  style={{
                    display: 'inline-block',
                    width: 8,
                    height: 8,
                    borderRadius: 999,
                    background:
                      pipelineRun.status === 'running'
                        ? '#f59e0b'
                        : pipelineRun.status === 'success'
                          ? '#22c55e'
                          : pipelineRun.status === 'error'
                            ? '#ef4444'
                            : theme.textMuted,
                  }}
                />
                <span style={{ color: theme.textSecondary, fontWeight: 600 }}>
                  Pipeline: {pipelineRun.status === 'queued' ? '待機中' : pipelineRun.status === 'running' ? '実行中' : pipelineRun.status === 'success' ? '完了' : pipelineRun.status === 'error' ? '失敗' : '待機中'}
                </span>
                {pipelineRun.sourceName && (
                  <span style={{ color: theme.textMuted }}>
                    {pipelineRun.sourceName}
                  </span>
                )}
                {pipelineRun.step !== 'idle' && pipelineRun.step !== 'done' && (
                  <span style={{ color: theme.textMuted }}>
                    step: {pipelineRun.step}
                  </span>
                )}
                {pipelineRun.runId && (
                  <span style={{ color: theme.textMuted, fontFamily: 'ui-monospace, SFMono-Regular, monospace' }}>
                    job_id: {pipelineRun.runId}
                  </span>
                )}
                <button
                  onClick={() => setPipelineStatusPinned(v => !v)}
                  title={pipelineStatusPinned ? 'ピン解除（完了後に自動非表示）' : 'ピン留め（常時表示）'}
                  style={{
                    marginLeft: 'auto',
                    background: 'transparent',
                    border: 'none',
                    cursor: 'pointer',
                    padding: '2px 4px',
                    borderRadius: 4,
                    color: pipelineStatusPinned ? theme.textPrimary : theme.textMuted,
                    display: 'flex',
                    alignItems: 'center',
                  }}
                >
                  {pipelineStatusPinned ? <Pin size={12} /> : <PinOff size={12} />}
                </button>
              </div>

              <div style={{ marginTop: 4, fontSize: 11, color: theme.textMuted }}>
                {pipelineRun.message}
              </div>
              {pipelineRun.metrics && (
                <div style={{
                  marginTop: 6,
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: 10,
                  fontSize: 10,
                  color: theme.textSecondary,
                }}>
                  <span>
                    CPS違反率: {(pipelineRun.metrics.quality.cpsViolationRate * 100).toFixed(1)}%
                  </span>
                  <span>
                    {adminSettings.enMaxCharsPerLine}文字超過率: {(pipelineRun.metrics.quality.overLengthRate * 100).toFixed(1)}%
                  </span>
                  <span>
                    要確認: {pipelineRun.metrics.quality.flaggedCount}件
                  </span>
                  <span>
                    Tokens(in/out): {pipelineRun.metrics.cost.inputTokens} / {pipelineRun.metrics.cost.outputTokens}
                  </span>
                  <span>
                    推定コスト: ${pipelineRun.metrics.cost.estimatedUsd.toFixed(6)}
                  </span>
                  <span>
                    処理時間: {(pipelineRun.metrics.cost.durationMs / 1000).toFixed(2)}s
                  </span>
                </div>
              )}
              {pipelineHistory.length > 0 && (
                <div style={{ marginTop: 6, fontSize: 10, color: theme.textMuted }}>
                  最近の実行履歴:
                  {pipelineHistory.slice(0, 3).map((run, idx) => (
                    <div key={`${run.startedAt ?? 0}-${idx}`} style={{ marginTop: 2 }}>
                      - {run.sourceName ?? 'unknown'} / {run.status === 'success' ? '完了' : run.status === 'error' ? '失敗' : run.status}
                      {run.metrics ? ` / $${run.metrics.cost.estimatedUsd.toFixed(6)} / ${(run.metrics.cost.durationMs / 1000).toFixed(2)}s` : ''}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* タブコンテンツ */}
          <div className="flex-1 overflow-hidden min-h-0" style={{ position: 'relative' }}>
            {isResizing && (
              <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <span style={{ fontSize: 12, color: theme.textMuted }}>...</span>
              </div>
            )}
            {!isResizing && activeTab === 'subtitles' && (
              <SubtitleBlockList
                blocks={blocks}
                activeBlockId={activeBlockId}
                currentTime={currentTime}
                onBlockSelect={handleBlockSelect}
                onApprove={handleApprove}
                onFlag={handleFlag}
                onReSplit={handleReSplit}
                onReTranslate={handleReTranslate}
                onUpdateSource={handleUpdateSource}
                onUpdateTarget={handleUpdateTarget}
                onManualSplit={handleManualSplit}
                onSplitFromTarget={handleSplitFromTarget}
                onSplitAtPlayhead={handleSplitAtPlayhead}
                onEqualSplit={handleEqualSplit}
                onMerge={handleMerge}
                onAdjustBoundary={handleAdjustBoundary}
                onUpdateTimes={handleUpdateTimes}
                onIgnoreWarning={handleIgnoreWarning}
                onDraftChange={handleDraftChange}
                maxCps={adminSettings.enMaxCps}
                maxCharsPerLine={adminSettings.enMaxCharsPerLine}
              />
            )}
            {!isResizing && activeTab === 'dictionary' && (
              <GlossaryTab
                onApplyAll={handleApplyGlossary}
                adminSettings={adminSettings}
                onAdminSettingsChange={updateAdminSettings}
                generationLog={glossaryGenerationLog}
                setGenerationLog={setGlossaryGenerationLog}
                isGenerating={glossaryGenerationBusy}
                setIsGenerating={setGlossaryGenerationBusy}
              />
            )}
            {!isResizing && activeTab === 'help' && <HelpTab />}
            {!isResizing && activeTab === 'report' && (
              <ReportTab
                runs={pipelineHistory}
                pipelineRun={pipelineRun}
                videoSourceName={videoSource?.name ?? null}
                onRunPipeline={handleRunPipelineFromReport}
                maxCharsPerLine={adminSettings.enMaxCharsPerLine}
              />
            )}
            {!isResizing && activeTab === 'settings' && (
              <SettingsTab
                adminSettings={adminSettings}
                serviceCheck={serviceCheck}
                onAdminSettingsChange={updateAdminSettings}
                onAdminSettingsReset={resetAdminSettings}
                onServiceCheck={handleServiceCheck}
              />
            )}
            {!isResizing && activeTab !== 'dictionary' && glossaryGenerationBusy && (
              <div style={{
                position: 'absolute',
                right: 16,
                bottom: 16,
                width: 'min(520px, calc(100% - 32px))',
                maxHeight: 220,
                display: 'flex',
                flexDirection: 'column',
                borderRadius: 8,
                border: `1px solid ${theme.panelBorder}`,
                background: theme.cardBg,
                boxShadow: '0 14px 40px rgba(0,0,0,0.28)',
                overflow: 'hidden',
                zIndex: 20,
              }}>
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '8px 10px',
                  borderBottom: `1px solid ${theme.panelBorder}`,
                  color: theme.textSecondary,
                  fontSize: 11,
                  fontWeight: 700,
                }}>
                  <span>辞書作成ログ</span>
                  {glossaryGenerationBusy && <span style={{ color: theme.textMuted, fontWeight: 500 }}>処理中...</span>}
                  <button
                    type="button"
                    onClick={() => setActiveTab('dictionary')}
                    style={{
                      marginLeft: 'auto',
                      border: `1px solid ${theme.btnBorder}`,
                      background: theme.btnBg,
                      color: theme.btnText,
                      borderRadius: 6,
                      padding: '2px 8px',
                      fontSize: 11,
                      cursor: 'pointer',
                    }}
                  >
                    開く
                  </button>
                </div>
                <div style={{
                  padding: '8px 10px',
                  overflowY: 'auto',
                  fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
                  fontSize: 10,
                  lineHeight: 1.5,
                  color: theme.textSecondary,
                  whiteSpace: 'pre-wrap',
                }}>
                  {glossaryGenerationLog.length > 0 ? glossaryGenerationLog.slice(0, 30).join('\n') : 'ログ待機中'}
                </div>
              </div>
            )}
          </div>
        </section>

      </main>
    </div>
  )
}
