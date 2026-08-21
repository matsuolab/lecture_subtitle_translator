import { useState, useCallback, useEffect, useMemo, useRef, useTransition } from 'react'
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
  importProjectDocument,
  importSrt,
  exportSrt,
  reconcileRestoredPipelineRun,
  type SessionExportData,
  type SrtExportFormat,
} from '@/api/persistence'
import { loadAdminSettings, saveAdminSettings } from '@/api/adminSettings'
import { hasPipelineApi, runPipelineViaApi, testServiceConnection } from '@/api/pipelineClient'
import { abortCurrentPipeline, isPipelineAbortedError } from '@/lib/pipeline/pipelineAbort'
import { describeError } from '@/lib/describeError'
import { buildMacAssetUrl } from '@/lib/video/macAssetUrl'
import type { SubtitleBlock } from '@/types/subtitle'
import type { AdminSettings } from '@/types/adminSettings'
import type { PipelineAuditReport, PipelineLlmErrorRecord, PipelineLlmUsageRecord, PipelineNodeTrace, PipelineProgressEvent, PipelineReviewItem, PipelineRunDebug, PipelineRunResult } from '@/types/pipeline'
import type { TranscriptSegment } from '@/lib/pipeline/types'
import { useSpellChecker, type SpellIssue } from '@/lib/pipeline/spellCheck'
import type { LocalPipelineGlossary } from '@/lib/pipeline/localPipeline'
import { loadLanguageProfileConfig } from '@/lib/pipeline/languageProfileConfig'
import {
  DEFAULT_GLOSSARY_ROLES,
  resolveGlossaryRoles,
  type GlossaryRoles,
} from '@/utils/glossaryApply'
import { useTheme } from '@/context/ThemeContext'
import { useLocale } from '@/context/LocaleContext'
import { useGlossary, type GlossaryEntry, type SelfMadeGlossaryEntry } from '@/context/GlossaryContext'
import { useToast } from '@/context/ToastContext'
import { useWorkLog } from '@/hooks/useWorkLog'
import type { WorkLogBaselineOrigin, WorkLogExport } from '@/lib/worklog/types'
import { calculateRoundedCps, countCpsChars } from '@/lib/subtitleMetrics'
import { buildAiGatewayProfileSnapshot } from '@/lib/aiGateway/apiCompatibilityProfile'
import { materializeProjectDocument, mergeImportedAdminSettings } from '@/lib/projectSession'
import type { SourceSegmentEvidence } from '@/types/sourceEvidence'
import { summarizeCompletedPipelineRun } from '@/lib/pipeline/runCompletion'

type Tab = 'subtitles' | 'dictionary' | 'help' | 'report' | 'settings'
type SaveStatus = 'saved' | 'saving' | 'error'
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
    contextGroupSourceIds: block.contextGroupSourceIds ? [...block.contextGroupSourceIds] : undefined,
    sourceRefs: block.sourceRefs?.map((ref) => ({ ...ref })),
    correctionAttempts: block.correctionAttempts ? block.correctionAttempts.map((attempt) => ({ ...attempt })) : undefined,
    editHistory: block.editHistory ? block.editHistory.map((entry) => ({ ...entry })) : undefined,
  }))
}

function mergeWorkLogLineage(
  imported: readonly WorkLogExport[],
  current: WorkLogExport | null,
): WorkLogExport[] {
  const bySessionId = new Map<string, WorkLogExport>()
  for (const log of imported) bySessionId.set(log.header.sessionId, log)
  if (current) bySessionId.set(current.header.sessionId, current)
  return [...bySessionId.values()]
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

// 補正 prompt: disabled でない PDF 抽出候補をすべて投入する。
// formal / assistive のような自動分類で絞ると Adagrad / MLP / Layer Norm のような
// 有用語まで落ちるため、enabled / disabled だけで判定する。
function canUseSelfMadeForCorrection(entry: SelfMadeGlossaryEntry): boolean {
  return !entry.disabled
}

// 翻訳 prompt: 日英ペアが揃っているもののみ (片側だけだと "Ja => En" 形式が作れない)
function canUseSelfMadeForTranslation(entry: SelfMadeGlossaryEntry): boolean {
  if (entry.disabled) return false
  return Boolean(entry.ja && entry.en)
}

function canonicalFormulaText(entry: SelfMadeGlossaryEntry): string | undefined {
  return entry.canonicalFormula?.displayText
    ?? entry.canonicalFormula?.formula
    ?? entry.displayText
    ?? entry.formula
}

function buildPipelineGlossary(
  glossary: GlossaryEntry[],
  selfMadeGlossary: SelfMadeGlossaryEntry[],
  roles: GlossaryRoles = DEFAULT_GLOSSARY_ROLES,
): LocalPipelineGlossary {
  const confirmedFormal = glossary.filter(entry => entry.confirmed)
  const correctionSelfMade = selfMadeGlossary.filter(canUseSelfMadeForCorrection)
  const translationSelfMade = selfMadeGlossary.filter(canUseSelfMadeForTranslation)

  // 補正は書きおこし（原文）に対して行うので、原文側の言語の表記を渡す。
  // 翻訳は「原文表記 => 訳文表記」の対で渡す。どちらも翻訳方向で ja/en が入れ替わる。
  const sourceOf = (entry: { ja: string; en: string }): string => entry[roles.transcript]
  const targetOf = (entry: { ja: string; en: string }): string => entry[roles.subtitle]
  // 話し言葉での読み。原文が日本語なら spokenJa、英語なら spokenEn を補正ヒントに使う。
  const spokenSourceOf = (entry: SelfMadeGlossaryEntry): string | undefined =>
    roles.transcript === 'ja' ? entry.spokenJa : entry.spokenEn
  const spokenTargetOf = (entry: SelfMadeGlossaryEntry): string | undefined =>
    roles.subtitle === 'ja' ? entry.spokenJa : entry.spokenEn

  const correctionTerms = uniqueNonEmpty([
    ...confirmedFormal.flatMap(entry => [sourceOf(entry), entry.abbr]),
    ...correctionSelfMade.flatMap(entry => [
      entry.ja,
      entry.en,
      entry.abbr,
      canonicalFormulaText(entry),
      spokenSourceOf(entry),
    ]),
  ])

  const translationTerms = uniqueNonEmpty([
    ...confirmedFormal.flatMap(entry => [
      entry.ja && entry.en ? `${sourceOf(entry)} => ${targetOf(entry)}` : undefined,
      entry.abbr,
    ]),
    ...translationSelfMade.flatMap(entry => [
      entry.ja && entry.en ? `${sourceOf(entry)} => ${targetOf(entry)}` : undefined,
      canonicalFormulaText(entry) && (spokenTargetOf(entry) || spokenSourceOf(entry))
        ? `${canonicalFormulaText(entry)} => ${spokenTargetOf(entry) ?? spokenSourceOf(entry)}`
        : undefined,
      entry.abbr,
    ]),
  ])

  const enabledSelfMade = selfMadeGlossary.filter(entry => !entry.disabled).length
  const disabledSelfMade = selfMadeGlossary.length - enabledSelfMade
  // 抽出ログから候補数が追えるよう、上限なしで全件投入していることを記録する
  console.info('[glossary] pipeline glossary built', {
    formalConfirmed: confirmedFormal.length,
    selfMadeTotal: selfMadeGlossary.length,
    selfMadeEnabled: enabledSelfMade,
    selfMadeDisabled: disabledSelfMade,
    correctionTerms: correctionTerms.length,
    translationTerms: translationTerms.length,
  })

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
    pdfFormulaMiniModel: settings.pdfFormulaMiniModel,
    pdfExtractionParallel: settings.pdfExtractionParallel,
    glossaryMaxOutputTokens: settings.glossaryMaxOutputTokens,
    apiRequestConcurrency: settings.apiRequestConcurrency,
    compressModel: settings.compressModel,
    expandModel: settings.expandModel,
    contextMergeModel: settings.contextMergeModel,
    generalRepairEnabled: settings.generalRepairEnabled,
    generalRepairModel: settings.generalRepairModel,
    generalRepairMaxEffort: settings.generalRepairMaxEffort,
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
  traces?: PipelineNodeTrace[]
  stageSnapshots?: PipelineRunDebug['stageSnapshots']
  sourceEvidence?: SourceSegmentEvidence[]
  llmErrors?: PipelineLlmErrorRecord[]
  llmUsage?: PipelineLlmUsageRecord[]
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
    traces: Array.isArray(row.traces) ? row.traces as PipelineNodeTrace[] : undefined,
    stageSnapshots: Array.isArray(row.stageSnapshots) ? row.stageSnapshots as PipelineRunDebug['stageSnapshots'] : undefined,
    sourceEvidence: Array.isArray(row.sourceEvidence) ? row.sourceEvidence as SourceSegmentEvidence[] : undefined,
    llmErrors: Array.isArray(row.llmErrors) ? row.llmErrors as PipelineLlmErrorRecord[] : undefined,
    llmUsage: Array.isArray(row.llmUsage) ? row.llmUsage as PipelineLlmUsageRecord[] : undefined,
  }
}

function stringifyUnknownError(err: unknown): string | undefined {
  if (err === null || err === undefined) return undefined
  if (typeof err === 'string') return err
  try {
    const json = JSON.stringify(err)
    return json && json !== '{}' ? json : undefined
  } catch {
    return Object.prototype.toString.call(err)
  }
}

function buildPipelineErrorInfo(err: unknown): NonNullable<PipelineRunDebug['errorInfo']> {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: describeError(err),
      stack: err.stack,
      raw: stringifyUnknownError(err),
    }
  }
  return {
    message: describeError(err),
    raw: stringifyUnknownError(err),
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
  const restoredSession = useMemo(() => loadSessionSnapshotFromLocalStorage(), [])
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
  // 中断要求済みだが、実行中の LLM リクエストの完了待ちで停止が確定していない状態。
  // 協調的キャンセルなので押した瞬間に止まるわけではない。それを黙って「中断済み」と
  // 表示すると実態と乖離するため、確定するまでは別表示にする。
  const [pipelineAborting, setPipelineAborting] = useState(false)
  // 実行が終端状態に達したら中断中フラグを解除する。次回実行で「中断中...」が残るのを防ぐ。
  useEffect(() => {
    if (pipelineRun.status !== 'running' && pipelineRun.status !== 'queued') {
      setPipelineAborting(false)
    }
  }, [pipelineRun.status])
  const [srtExportFormat, setSrtExportFormat] = useState<SrtExportFormat>(() => {
    try {
      const saved = localStorage.getItem('srtExportFormat')
      if (saved === 'subtitle' || saved === 'transcript' || saved === 'both') return saved
      // 旧スキーマ ('source'/'target' および最古 'en'/'ja') からのマイグレーション
      if (saved === 'source' || saved === 'en') {
        try { localStorage.setItem('srtExportFormat', 'subtitle') } catch { /* ignore */ }
        return 'subtitle'
      }
      if (saved === 'target' || saved === 'ja') {
        try { localStorage.setItem('srtExportFormat', 'transcript') } catch { /* ignore */ }
        return 'transcript'
      }
    } catch {
      // ignore (e.g. SSR / private mode)
    }
    return 'subtitle'
  })
  const [glossaryGenerationLog, setGlossaryGenerationLog] = useState<string[]>([])
  const [glossaryGenerationBusy, setGlossaryGenerationBusy] = useState(false)
  const [adminSettings, setAdminSettings] = useState<AdminSettings>(() => (
    mergeImportedAdminSettings(loadAdminSettings(), restoredSession?.session?.adminSettings)
  ))
  // 用語辞書の ja/en フィールドが、字幕・書きおこしのどちらに対応するか。翻訳方向で入れ替わる。
  const glossaryRoles = useMemo(
    () => resolveGlossaryRoles(loadLanguageProfileConfig(adminSettings)),
    [adminSettings],
  )
  const latestPipelineDebugRef = useRef<PipelineRunDebug | undefined>(
    restoredSession?.session?.pipelineRun?.debug,
  )
  const workLog = useWorkLog()
  const [importedWorkLogs, setImportedWorkLogs] = useState<WorkLogExport[]>([])
  const [projectExtensions, setProjectExtensions] = useState<{
    document?: Record<string, unknown>
    session?: Record<string, unknown>
  }>({})
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


  useEffect(() => {
    saveAdminSettings(adminSettings)
  }, [adminSettings])

  const updateAdminSettings = useCallback((patch: Partial<AdminSettings>) => {
    setAdminSettings(prev => ({ ...prev, ...patch }))
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
      const overLen = block.subtitle.split('\n').some(line => line.length > adminSettings.enMaxCharsPerLine)
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
    const snapshotVideoSource = Object.prototype.hasOwnProperty.call(next, 'videoSource')
      ? next.videoSource
      : videoSource
    const result = saveSessionSnapshotToLocalStorage({
      version: 2,
      savedAt: new Date().toISOString(),
      blocks: cloneBlocks(next.blocks ?? blocks),
      session: {
        videoSource: snapshotVideoSource
          ? {
              name: snapshotVideoSource.name,
              path: snapshotVideoSource.path,
            }
          : null,
        adminSettings: sanitizeAdminSettings(adminSettings),
        pipelineRun: next.pipelineRun ?? toUiSafePipelineRun(pipelineRun),
        pipelineHistory: next.pipelineHistory ?? pipelineHistory,
        activeWorkLogSessionId: getWorkLogSessionId() ?? undefined,
      },
    })
    setSaveStatus(result.ok ? 'saved' : 'error')
    return result
  }, [adminSettings, blocks, getWorkLogSessionId, pipelineHistory, pipelineRun, videoSource])

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
  const beginWorkLogSession = useCallback(async (
    origin: WorkLogBaselineOrigin,
    initialBlocks: SubtitleBlock[],
    opts?: {
      transcriptSegments?: TranscriptSegment[]
      video?: VideoSource | null
      parentSessionId?: string
      settings?: AdminSettings
    },
  ) => {
    seedWorkLogSeen(initialBlocks)
    const video = opts && 'video' in opts ? opts.video : videoSource
    const settings = opts?.settings ?? adminSettings
    return workLog.startSession({
      origin,
      video: video ? { name: video.name, path: video.path } : null,
      settingsSnapshot: sanitizeAdminSettings(settings),
      initialBlocks: cloneBlocks(initialBlocks),
      transcriptSegments: opts?.transcriptSegments,
      parentSessionId: opts?.parentSessionId,
    }, settings.workLogDir)
  }, [adminSettings, videoSource, workLog, seedWorkLogSeen])

  /**
   * 3つのJSON入力経路が共有するProject Session hydration。
   * decodeが完了するまでは現在の画面を一切変更せず、成功時だけ同じhandlerで全状態を置換する。
   */
  const importProjectFile = useCallback(async (file: File): Promise<boolean> => {
    const decoded = await importProjectDocument(file)
    if (decoded.status === 'unsupported_newer') {
      toast.error('projectVersionTooNew', {
        found: decoded.foundVersion,
        supported: decoded.supportedVersion,
      })
      return false
    }
    if (decoded.status === 'invalid') {
      toast.error('projectImportError', { error: decoded.error })
      return false
    }

    const imported = materializeProjectDocument(decoded.document)
    const importedBlocks = cloneBlocks(imported.blocks)
    const importedVideo = imported.videoSource
      ? { name: imported.videoSource.name, path: imported.videoSource.path }
      : null
    const importedSettings = mergeImportedAdminSettings(adminSettings, imported.adminSettings)
    const importedRun = reconcileRestoredPipelineRun(imported.pipelineRun) ?? {
      status: 'idle' as const,
      step: 'idle' as const,
      message: 'レポートタブからパイプラインを開始できます',
    }
    const importedHistory = imported.pipelineHistory ?? []
    const importedLogs = imported.workLogs ?? []
    const parentSessionId = imported.activeWorkLogSessionId
      ?? importedLogs.at(-1)?.header.sessionId

    reset(importedBlocks)
    setAdminSettings(importedSettings)
    saveAdminSettings(importedSettings)
    setPipelineRun(importedRun)
    setPipelineHistory(importedHistory)
    latestPipelineDebugRef.current = importedRun.debug
    setImportedWorkLogs(importedLogs)
    setProjectExtensions({
      document: imported.extensions,
      session: imported.sessionExtensions,
    })
    setVideoDiagnostic(null)
    setVideoUrl((previous) => {
      if (previous?.startsWith('blob:')) URL.revokeObjectURL(previous)
      return null
    })
    if (importedVideo?.path && isTauri()) {
      void loadVideoPath(importedVideo.path)
    } else {
      setVideoSource(importedVideo)
    }

    let activeWorkLogSessionId = parentSessionId
    try {
      activeWorkLogSessionId = await beginWorkLogSession('json_import', importedBlocks, {
        video: importedVideo,
        parentSessionId,
        settings: importedSettings,
      })
    } catch (error) {
      toast.info('workLogWriteWarning', { error: describeError(error) })
    }

    const recoveryResult = saveSessionSnapshotToLocalStorage({
      version: 3,
      savedAt: new Date().toISOString(),
      blocks: importedBlocks,
      session: {
        videoSource: importedVideo,
        adminSettings: sanitizeAdminSettings(importedSettings),
        pipelineRun: importedRun,
        pipelineHistory: importedHistory,
        activeWorkLogSessionId,
      },
    })
    setSaveStatus(recoveryResult.ok ? 'saved' : 'error')
    toast.success('importProjectJson')
    return true
  }, [adminSettings, beginWorkLogSession, loadVideoPath, reset, toast])

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
    let sourceEvidence: SourceSegmentEvidence[] | undefined = undefined
    let llmErrors: PipelineLlmErrorRecord[] | undefined = undefined
    let llmUsage: PipelineLlmUsageRecord[] | undefined = undefined

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

    setActiveTab('subtitles')
    try {
      let generated: SubtitleBlock[] = []
      let audit: PipelineAuditReport | undefined

      if (!hasPipelineApi(adminSettings)) {
        throw new Error('字幕生成の実行先が利用できません。デスクトップアプリで「このPCで実行」を使うか、接続設定でService URLを設定してください。')
      }

      {
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
        const pipelineGlossary = buildPipelineGlossary(glossary, selfMadeGlossary, glossaryRoles)
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
          // inFlightLlmCalls はローカルパイプライン経路（runLocalPostPipeline のハートビート）
          // でのみ埋まる。「時間のかかる段階を正常に処理中」か「フリーズしている」かを見分けるため、
          // API応答待ち件数と最後の応答からの経過秒数をメッセージに追記する。
          const llmActivitySuffix = progress.inFlightLlmCalls !== undefined
            ? ` / API応答待ち ${progress.inFlightLlmCalls}件${
                progress.secondsSinceLastLlmResponse !== undefined && progress.secondsSinceLastLlmResponse !== null
                  ? ` / 最後の応答から ${progress.secondsSinceLastLlmResponse}s`
                  : ''
              }`
            : ''
          const stepKey = mapProgressStep(progress.currentNode)
          const message = (() => {
            if (progress.status === 'queued') {
              return 'ジョブを投入しました。worker の開始を待っています。'
            }
            if (adminSettings.serviceMode === 'managed_service' && node === 'transcribe') {
              return `AWS上で書き起こし実行中です${elapsed}。ローカル実行より時間がかかります。`
            }
            return `${label}${elapsed}${llmActivitySuffix}`
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
            inFlightLlmCalls: progress.inFlightLlmCalls,
            secondsSinceLastLlmResponse: progress.secondsSinceLastLlmResponse,
          })
          const progressState: PipelineRunResult = {
            status: mapProgressStatus(progress.status),
            step: stepKey,
            message,
            runId: progress.runId,
            sourceName,
            startedAt,
            llmActivity: progress.inFlightLlmCalls !== undefined
              ? {
                  inFlightLlmCalls: progress.inFlightLlmCalls,
                  secondsSinceLastLlmResponse: progress.secondsSinceLastLlmResponse ?? null,
                }
              : undefined,
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
        sourceEvidence = apiResult.debug?.sourceEvidence
        llmErrors = apiResult.debug?.llmErrors
        llmUsage = apiResult.debug?.llmUsage
      }

      reset(generated)
      void beginWorkLogSession('transcription', generated, { transcriptSegments, video: source })

      const finishedAt = Date.now()
      const completion = summarizeCompletedPipelineRun({
        blocks: generated,
        startedAt,
        finishedAt,
        maxCps: adminSettings.enMaxCps,
        maxCharsPerLine: adminSettings.enMaxCharsPerLine,
        llmUsage,
        llmErrors,
      })
      const result: PipelineRunResult = {
        status: completion.status,
        step: 'done',
        message: completion.message,
        runId: managedRunId,
        sourceName,
        startedAt,
        finishedAt,
        metrics: completion.metrics,
        audit,
        debug: {
          sourceMedia: {
            name: source.name,
            path: source.path,
            mode: adminSettings.serviceMode,
          },
          settingsSnapshot: sanitizeAdminSettings(adminSettings),
          aiGatewayProfiles: buildAiGatewayProfileSnapshot(adminSettings),
          initialBlocks: initialBlocksSnapshot,
          finalBlocks: cloneBlocks(generated),
          progressEvents,
          stageSnapshots,
          sourceEvidence,
          transcriptSegments,
          transcriptMetadata,
          llmErrors,
          llmUsage,
        },
      }
      progressEvents.push({
        at: finishedAt,
        status: completion.status,
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
      const errorMessage = describeError(err)
      // 中断はユーザーの意思による停止なので失敗として扱わない（status を error にしない）
      const aborted = isPipelineAbortedError(err)
      const failureTraces = pipelineDebug.traces ?? traces
      const pipelineErrorTrace: PipelineNodeTrace = {
        nodeId: pipelineDebug.traces?.length ? 'pipeline_catch' : 'pipeline',
        status: 'failure',
        attempt: 1,
        durationMs: finishedAt - startedAt,
        provider: 'app',
        model: 'n/a',
        summary: errorMessage,
      }
      const nodeTraces = [...failureTraces, pipelineErrorTrace]
      transcriptSegments = transcriptSegments ?? pipelineDebug.transcriptSegments
      transcriptMetadata = transcriptMetadata ?? pipelineDebug.transcriptMetadata
      stageSnapshots = stageSnapshots ?? pipelineDebug.stageSnapshots
      sourceEvidence = sourceEvidence ?? pipelineDebug.sourceEvidence
      llmErrors = llmErrors ?? pipelineDebug.llmErrors
      llmUsage = llmUsage ?? pipelineDebug.llmUsage
      progressEvents.push({
        at: finishedAt,
        status: aborted ? 'cancelled' : 'error',
        step: 'done',
        message: aborted ? 'ユーザー操作により中断されました' : errorMessage,
        runId: managedRunId,
      })
      const result: PipelineRunResult = {
        status: aborted ? 'cancelled' : 'error',
        step: 'done',
        message: aborted
          ? 'パイプラインを中断しました'
          : `パイプライン失敗: ${errorMessage}`,
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
              nodeId: pipelineDebug.traces?.find(trace => trace.status === 'failure')?.nodeId ?? 'pipeline',
              reason: errorMessage,
              priority: 'must_review',
              score: 0,
            },
          ],
          nodeTraces,
        },
        debug: {
          sourceMedia: {
            name: source.name,
            path: source.path,
            mode: adminSettings.serviceMode,
          },
          settingsSnapshot: sanitizeAdminSettings(adminSettings),
          aiGatewayProfiles: buildAiGatewayProfileSnapshot(adminSettings),
          initialBlocks: initialBlocksSnapshot,
          finalBlocks: cloneBlocks(blocks),
          progressEvents,
          stageSnapshots,
          sourceEvidence,
          transcriptSegments,
          transcriptMetadata,
          llmErrors,
          llmUsage,
          errorInfo: buildPipelineErrorInfo(err),
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
  }, [adminSettings, beginWorkLogSession, blocks, buildAuditReport, glossary, persistSessionSnapshot, pipelineHistory, reset, selfMadeGlossary])

  const buildSessionExport = useCallback((): SessionExportData => ({
    version: 2,
    savedAt: new Date().toISOString(),
    blocks: cloneBlocks(blocks),
    extensions: projectExtensions.document,
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
      workLogs: mergeWorkLogLineage(importedWorkLogs, getWorkLogExport()),
      activeWorkLogSessionId: getWorkLogSessionId() ?? undefined,
      extensions: projectExtensions.session,
    },
  }), [adminSettings, blocks, getWorkLogExport, getWorkLogSessionId, importedWorkLogs, pipelineHistory, pipelineRun, projectExtensions, videoSource])

  // ── 字幕スペル校正（docs/adr/0003-subtitle-spellcheck.md） ──────────────
  const glossaryEnTerms = useMemo(
    () => glossary.map(e => e.en).filter((w): w is string => typeof w === 'string' && w.trim().length > 0),
    [glossary],
  )
  const spellChecker = useSpellChecker(adminSettings, glossaryEnTerms)
  const [spellIssuesByBlock, setSpellIssuesByBlock] = useState<Record<number, SpellIssue[]>>({})

  /** 対象ブロックを「一旦フラグをクリア → 再チェックして反映」する。全トリガ共通。 */
  const checkBlocksSpelling = useCallback(async (targets: Array<{ id: number; subtitle: string }>): Promise<number> => {
    // チェック前にまず該当ブロックのフラグを消す（陳腐化した表示を残さない）
    setSpellIssuesByBlock(prev => {
      const next = { ...prev }
      for (const t of targets) delete next[t.id]
      return next
    })
    if (!spellChecker) return 0
    let total = 0
    const updates: Record<number, SpellIssue[]> = {}
    for (const t of targets) {
      const issues = await spellChecker.check(t.subtitle ?? '')
      updates[t.id] = issues
      total += issues.length
    }
    setSpellIssuesByBlock(prev => ({ ...prev, ...updates }))
    return total
  }, [spellChecker])

  const handleExportSrt = useCallback(() => {
    exportSrt(blocks, adminSettings, srtExportFormat)
    toast.success('exportSrt')
    // 出力時に全ブロックを自動スペルチェック（警告のみ・出力はブロックしない）
    void checkBlocksSpelling(blocks.map(b => ({ id: b.id, subtitle: b.subtitle }))).then(total => {
      if (total > 0) toast.error('spellCheckFound', { count: total })
    })
  }, [adminSettings, blocks, srtExportFormat, toast, checkBlocksSpelling])

  const handleSrtFormatChange = useCallback((next: SrtExportFormat) => {
    setSrtExportFormat(next)
    try {
      localStorage.setItem('srtExportFormat', next)
    } catch {
      // ignore persistence failure
    }
  }, [])

  const handleExportProjectJson = useCallback(async () => {
    const flushResult = await workLog.flush()
    if (!flushResult.ok) {
      // Project JSONにはメモリ上のWorkLogを含められるので、外部jsonlの失敗だけで報告手段を塞がない。
      toast.info('workLogWriteWarning', { error: flushResult.error.message })
    }
    try {
      exportProjectJson(buildSessionExport())
      toast.success('saveProjectJson')
    } catch (error) {
      toast.error('projectExportError', { error: describeError(error) })
    }
  }, [buildSessionExport, toast, workLog])

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
        setImportedWorkLogs([])
        setProjectExtensions({})
        void beginWorkLogSession('srt_import', imported)
      } catch {
        alert(t.importSrtError)
      }
    } else if (name.endsWith('.json')) {
      await importProjectFile(file)
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
  }, [reset, beginWorkLogSession, t.importSrtError, importEntries, importProjectFile])

  // Tauri: ネイティブDrag&Dropのフォールバック（WindowsビルドでHTML5 D&Dが効かない対策）
  //
  // ドロップ処理の本体は ref に保持し、毎レンダー最新の closure を書き込む。
  // こうすることで onDragDropEvent の登録/解除を「マウント時に 1 回」だけに固定できる。
  // （依存配列に reset / importEntries 等の useCallback を並べると、字幕編集のたびに
  //   effect が再実行され、登録/解除が繰り返されて Tauri の unregisterListener が
  //   例外を投げ、main.tsx のグローバルハンドラがアプリ全体を潰す原因になっていた。）
  const handleNativeDropRef = useRef<(path: string) => Promise<void>>(async () => {})
  handleNativeDropRef.current = async (path: string) => {
    const name = path.toLowerCase()
    try {
      if (isVideoPathLike(name)) {
        handleVideoPathInput(path)
        return
      }
      if (name.endsWith('.srt') || name.endsWith('.txt')) {
        const imported = await importSrt(await readTextFileAsFile(path))
        reset(imported)
        setImportedWorkLogs([])
        setProjectExtensions({})
        void beginWorkLogSession('srt_import', imported)
        return
      }
      if (name.endsWith('.json')) {
        await importProjectFile(await readTextFileAsFile(path))
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
  }

  useEffect(() => {
    if (!isTauri()) return
    let cancelled = false
    let unlisten: (() => void) | null = null
    getCurrentWebview()
      .onDragDropEvent((event) => {
        if (cancelled) return
        if (event.payload.type !== 'drop') return
        if (Date.now() - lastHtmlDropRef.current < 500) return
        const paths = event.payload.paths
        if (!paths || paths.length === 0) return
        void handleNativeDropRef.current(paths[0])
      })
      .then((fn) => {
        // すでにアンマウント済みなら即解除（解除自体の失敗は無視）
        if (cancelled) {
          try {
            fn()
          } catch (err) {
            console.error('drag-drop unlisten (post-unmount) failed', err)
          }
        } else {
          unlisten = fn
        }
      })
      .catch((err) => {
        console.error('onDragDropEvent register failed', err)
      })
    return () => {
      cancelled = true
      // Tauri の unregisterListener は不整合な状態で同期 throw することがある。
      // ここで握りつぶさないと main.tsx のグローバルハンドラが全画面エラーを出す。
      try {
        unlisten?.()
      } catch (err) {
        console.error('drag-drop unlisten failed', err)
      }
    }
  }, [])

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
      const result = saveToLocalStorage(blocks)
      setSaveStatus(result.ok ? 'saved' : 'error')
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
    await importProjectFile(file)
    e.target.value = ''
  }, [importProjectFile])

  const handleImportSrt = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const imported = await importSrt(file)
      reset(imported)
      setImportedWorkLogs([])
      setProjectExtensions({})
      void beginWorkLogSession('srt_import', imported)
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
    // 承認ボタン押下時は常に当該ブロックを再スペルチェック（編集後の再検証も兼ねる）
    const target = blocks.find(b => b.id === id)
    if (target) void checkBlocksSpelling([{ id: target.id, subtitle: target.subtitle }])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocks, checkBlocksSpelling])

  /** 誤検知語をユーザー個人辞書へ登録（全プロジェクトで恒久除外）。即時にハイライトを消す。 */
  const handleAddToSpellDictionary = useCallback((word: string) => {
    const trimmed = word.trim()
    if (!trimmed) return
    if (!adminSettings.spellUserDictionary.includes(trimmed)) {
      updateAdminSettings({ spellUserDictionary: [...adminSettings.spellUserDictionary, trimmed] })
    }
    // 楽観的に全ブロックから当該語の検出を除去
    setSpellIssuesByBlock(prev => {
      const next: Record<number, SpellIssue[]> = {}
      for (const [id, issues] of Object.entries(prev)) {
        next[Number(id)] = issues.filter(i => i.word !== trimmed)
      }
      return next
    })
    toast.success('spellWordAdded', { word: trimmed })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adminSettings.spellUserDictionary, updateAdminSettings, toast])

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
      subtitle: textBefore,
      cps: calculateRoundedCps(textBefore, dur1),
      charCount: countCpsChars(textBefore),
    }
    const b2: SubtitleBlock = {
      ...block,
      id: newId,
      startTime: splitTime,
      subtitle: textAfter,
      cps: calculateRoundedCps(textAfter, dur2),
      charCount: countCpsChars(textAfter),
      status: 'pending' as const,
      glossaryTerms: [],
    }
    return [b1, b2]
  }, [blocks])

  const handleManualSplit = useCallback((id: number, textBefore: string, textAfter: string) => {
    const idx = blocks.findIndex(b => b.id === id)
    if (idx === -1) return
    const block = blocks[idx]
    const ratio = countCpsChars(textBefore) / Math.max(1, countCpsChars(textBefore) + countCpsChars(textAfter))
    const splitTime = block.startTime + (block.endTime - block.startTime) * ratio
    const [rawB1, rawB2] = makeSplitBlocks(block, splitTime, textBefore, textAfter)
    const before = { id: block.id, subtitle: block.subtitle, startTime: block.startTime, endTime: block.endTime }
    const b1 = withEditHistory(rawB1, 'split', before, { part: 'first', subtitle: rawB1.subtitle, startTime: rawB1.startTime, endTime: rawB1.endTime })
    const b2 = withEditHistory(rawB2, 'split', before, { part: 'second', subtitle: rawB2.subtitle, startTime: rawB2.startTime, endTime: rawB2.endTime })
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
    const [textBefore, textAfter] = splitAtWordBoundary(block.subtitle, Math.round(block.subtitle.length * ratio))
    const [rawB1, rawB2] = makeSplitBlocks(block, splitTime, textBefore, textAfter)
    const before = { id: block.id, subtitle: block.subtitle, startTime: block.startTime, endTime: block.endTime }
    const b1 = withEditHistory(rawB1, 'split', before, { method: 'playhead', part: 'first', subtitle: rawB1.subtitle, startTime: rawB1.startTime, endTime: rawB1.endTime })
    const b2 = withEditHistory(rawB2, 'split', before, { method: 'playhead', part: 'second', subtitle: rawB2.subtitle, startTime: rawB2.startTime, endTime: rawB2.endTime })
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
    const [textBefore, textAfter] = splitAtWordBoundary(block.subtitle, Math.round(block.subtitle.length / 2))
    const [rawB1, rawB2] = makeSplitBlocks(block, splitTime, textBefore, textAfter)
    const before = { id: block.id, subtitle: block.subtitle, startTime: block.startTime, endTime: block.endTime }
    const b1 = withEditHistory(rawB1, 'split', before, { method: 'equal', part: 'first', subtitle: rawB1.subtitle, startTime: rawB1.startTime, endTime: rawB1.endTime })
    const b2 = withEditHistory(rawB2, 'split', before, { method: 'equal', part: 'second', subtitle: rawB2.subtitle, startTime: rawB2.startTime, endTime: rawB2.endTime })
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
    const mergedText = joinTextParts([first.subtitle, second.subtitle], '\n')
    const mergedTranscript = joinTextParts([first.transcript, second.transcript], '\n')
    const duration = second.endTime - first.startTime
    const merged: SubtitleBlock = withEditHistory(
      {
        ...first,
        endTime: second.endTime,
        transcript: mergedTranscript,
        subtitle: mergedText,
        cps: duration > 0 ? calculateRoundedCps(mergedText, duration) : 0,
        charCount: countCpsChars(mergedText),
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
        first: { id: first.id, subtitle: first.subtitle, transcript: first.transcript, startTime: first.startTime, endTime: first.endTime },
        second: { id: second.id, subtitle: second.subtitle, transcript: second.transcript, startTime: second.startTime, endTime: second.endTime },
      },
      {
        id: first.id,
        subtitle: mergedText,
        transcript: mergedTranscript,
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

  const handleUpdateTranscript = useCallback((id: number, text: string) => {
    push(blocks.map(b => b.id !== id ? b : withEditHistory(
      { ...b, transcript: text },
      'transcript_edit',
      { transcript: b.transcript },
      { transcript: text },
    )))
  }, [blocks, push])

  /** 書きおこし分割: transcriptBefore/After で2ブロックに分割。字幕(subtitle)は両方コピー */
  const handleSplitFromTranscript = useCallback((id: number, transcriptBefore: string, transcriptAfter: string) => {
    const idx = blocks.findIndex(b => b.id === id)
    if (idx === -1) return
    const block = blocks[idx]
    const ratio = transcriptBefore.length / Math.max(1, transcriptBefore.length + transcriptAfter.length)
    const splitTime = block.startTime + (block.endTime - block.startTime) * ratio
    const dur1 = Math.max(0.01, splitTime - block.startTime)
    const dur2 = Math.max(0.01, block.endTime - splitTime)
    const newId = Math.max(...blocks.map(b => b.id)) + 1
    const before = { id: block.id, transcript: block.transcript, startTime: block.startTime, endTime: block.endTime }
    const b1: SubtitleBlock = withEditHistory(
      {
        ...block,
        endTime: splitTime,
        transcript: transcriptBefore,
        // subtitle はそのままコピー（言語が違うため比率分割しない）
        cps: calculateRoundedCps(block.subtitle, dur1),
      },
      'split',
      before,
      { part: 'first', transcript: transcriptBefore, startTime: block.startTime, endTime: splitTime },
    )
    const b2: SubtitleBlock = withEditHistory(
      {
        ...block,
        id: newId,
        startTime: splitTime,
        transcript: transcriptAfter,
        // subtitle はそのままコピー
        cps: calculateRoundedCps(block.subtitle, dur2),
        status: 'pending' as const,
        glossaryTerms: [],
      },
      'split',
      before,
      { part: 'second', transcript: transcriptAfter, startTime: splitTime, endTime: block.endTime },
    )
    const next = [...blocks]
    next.splice(idx, 1, b1, b2)
    push(next)
  }, [blocks, push])

  const handleUpdateSubtitle = useCallback((id: number, text: string) => {
    push(blocks.map(b => {
      if (b.id !== id) return b
      const duration = b.endTime - b.startTime
      return withEditHistory(
        { ...b, subtitle: text, cps: calculateRoundedCps(text, Math.max(0.1, duration)), charCount: countCpsChars(text) },
        'subtitle_edit',
        { subtitle: b.subtitle },
        { subtitle: text },
      )
    }))
    // 本文を編集したら、一旦フラグを消してから編集後テキストで再チェック
    void checkBlocksSpelling([{ id, subtitle: text }])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocks, push, checkBlocksSpelling])

  const handleBulkReplace = useCallback((updates: Array<{ id: number; subtitle?: string; transcript?: string }>) => {
    if (updates.length === 0) return
    const byId = new Map(updates.map(u => [u.id, u]))
    const next = blocks.map(b => {
      const u = byId.get(b.id)
      if (!u) return b
      let block = b
      if (u.subtitle !== undefined && u.subtitle !== b.subtitle) {
        const duration = b.endTime - b.startTime
        block = withEditHistory(
          { ...block, subtitle: u.subtitle, cps: calculateRoundedCps(u.subtitle, Math.max(0.1, duration)), charCount: countCpsChars(u.subtitle) },
          'subtitle_edit',
          { subtitle: b.subtitle },
          { subtitle: u.subtitle },
        )
      }
      if (u.transcript !== undefined && u.transcript !== block.transcript) {
        block = withEditHistory(
          { ...block, transcript: u.transcript },
          'transcript_edit',
          { transcript: b.transcript },
          { transcript: u.transcript },
        )
      }
      return block
    })
    push(next)
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

  const currentBlock = blocks.find(b => currentTime >= b.startTime && currentTime < b.endTime)
  const subtitleOverlay = currentBlock
    ? {
        text: draftSource?.id === currentBlock.id ? draftSource.text : currentBlock.subtitle,
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
            {(['subtitles', 'report', 'dictionary', 'help'] as Tab[]).map(tab => (
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
              <span style={{ fontSize: 10, color: saveStatus === 'saving' ? theme.savingColor : saveStatus === 'error' ? '#ef4444' : theme.savedColor, transition: 'color 0.3s', whiteSpace: 'nowrap', padding: '0 4px' }}>
                {saveStatus === 'saving' ? t.saving : saveStatus === 'error' ? t.saveFailed : t.saved}
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
              <select
                value={srtExportFormat}
                onChange={(e) => handleSrtFormatChange(e.target.value as SrtExportFormat)}
                title={t.srtFormatSelectTitle}
                aria-label={t.srtFormatLabel}
                style={{ fontSize: 11, whiteSpace: 'nowrap', color: theme.textSecondary, padding: '3px 6px', borderRadius: 5, border: `1px solid ${theme.panelBorder}`, background: theme.btnBg, cursor: 'pointer' }}>
                <option value="subtitle">{t.srtFormatSource}</option>
                <option value="transcript">{t.srtFormatTarget}</option>
                <option value="both">{t.srtFormatBoth}</option>
              </select>
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
                          : pipelineRun.status === 'warning'
                            ? '#f59e0b'
                          : pipelineRun.status === 'error'
                            ? '#ef4444'
                            : pipelineRun.status === 'cancelled'
                              ? '#8b5cf6'
                              : theme.textMuted,
                  }}
                />
                <span style={{ color: theme.textSecondary, fontWeight: 600 }}>
                  Pipeline: {
                    pipelineAborting && pipelineRun.status === 'running'
                      ? '中断しています（実行中のリクエストの完了待ち）'
                      : pipelineRun.status === 'queued' ? '待機中'
                        : pipelineRun.status === 'running' ? '実行中'
                          : pipelineRun.status === 'success' ? '完了'
                            : pipelineRun.status === 'warning' ? t.reportStatusWarning
                            : pipelineRun.status === 'error' ? '失敗'
                              : pipelineRun.status === 'cancelled' ? '中断'
                                : '待機中'
                  }
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
                {(pipelineRun.status === 'running' || pipelineRun.status === 'queued') && (
                  <button
                    onClick={() => {
                      setPipelineAborting(true)
                      abortCurrentPipeline()
                    }}
                    disabled={pipelineAborting}
                    title={pipelineAborting
                      ? '中断要求済み。実行中のリクエストの完了を待っています'
                      : '実行中の処理を中断します（実行中のリクエストの完了は待ちます）'}
                    style={{
                      marginLeft: 'auto',
                      background: 'transparent',
                      border: `1px solid ${theme.panelBorder}`,
                      cursor: pipelineAborting ? 'default' : 'pointer',
                      padding: '2px 8px',
                      borderRadius: 4,
                      fontSize: 11,
                      color: pipelineAborting ? theme.textMuted : '#ef4444',
                    }}
                  >
                    {pipelineAborting ? '中断中...' : '中断'}
                  </button>
                )}
                <button
                  onClick={() => setPipelineStatusPinned(v => !v)}
                  title={pipelineStatusPinned ? 'ピン解除（完了後に自動非表示）' : 'ピン留め（常時表示）'}
                  style={{
                    marginLeft: (pipelineRun.status === 'running' || pipelineRun.status === 'queued') ? 0 : 'auto',
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

              <div style={{
                marginTop: 4,
                fontSize: 11,
                // 最後の LLM 応答からの経過秒数が API タイムアウト設定に近づいている（70%以上）場合は
                // 「詰まっている疑い」として強調表示する。ハートビート未対応の経路（managed service 等）
                // では llmActivity が undefined のため通常表示のまま。
                color: pipelineRun.llmActivity
                  && pipelineRun.llmActivity.inFlightLlmCalls > 0
                  && pipelineRun.llmActivity.secondsSinceLastLlmResponse !== null
                  && pipelineRun.llmActivity.secondsSinceLastLlmResponse >= adminSettings.llmRequestTimeoutSec * 0.7
                  ? '#ef4444'
                  : theme.textMuted,
                fontWeight: pipelineRun.llmActivity
                  && pipelineRun.llmActivity.inFlightLlmCalls > 0
                  && pipelineRun.llmActivity.secondsSinceLastLlmResponse !== null
                  && pipelineRun.llmActivity.secondsSinceLastLlmResponse >= adminSettings.llmRequestTimeoutSec * 0.7
                  ? 600
                  : undefined,
              }}>
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
                    処理時間: {(pipelineRun.metrics.cost.durationMs / 1000).toFixed(2)}s
                  </span>
                </div>
              )}
              {pipelineHistory.length > 0 && (
                <div style={{ marginTop: 6, fontSize: 10, color: theme.textMuted }}>
                  最近の実行履歴:
                  {pipelineHistory.slice(0, 3).map((run, idx) => (
                    <div key={`${run.startedAt ?? 0}-${idx}`} style={{ marginTop: 2 }}>
                      - {run.sourceName ?? 'unknown'} / {run.status === 'success' ? '完了' : run.status === 'warning' ? t.reportStatusWarning : run.status === 'error' ? '失敗' : run.status}
                      {run.metrics ? ` / ${(run.metrics.cost.durationMs / 1000).toFixed(2)}s` : ''}
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
                onUpdateSubtitle={handleUpdateSubtitle}
                onUpdateTranscript={handleUpdateTranscript}
                onManualSplit={handleManualSplit}
                onSplitFromTranscript={handleSplitFromTranscript}
                onSplitAtPlayhead={handleSplitAtPlayhead}
                onEqualSplit={handleEqualSplit}
                onMerge={handleMerge}
                onAdjustBoundary={handleAdjustBoundary}
                onUpdateTimes={handleUpdateTimes}
                onIgnoreWarning={handleIgnoreWarning}
                onDraftChange={handleDraftChange}
                onBulkReplace={handleBulkReplace}
                maxCps={adminSettings.enMaxCps}
                maxCharsPerLine={adminSettings.enMaxCharsPerLine}
                spellIssuesByBlock={spellIssuesByBlock}
                glossaryRoles={glossaryRoles}
                onAddToSpellDictionary={handleAddToSpellDictionary}
              />
            )}
            {!isResizing && activeTab === 'dictionary' && (
              <GlossaryTab
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
                onSaveProjectJson={handleExportProjectJson}
                maxCharsPerLine={adminSettings.enMaxCharsPerLine}
              />
            )}
            {!isResizing && activeTab === 'settings' && (
              <SettingsTab
                adminSettings={adminSettings}
                serviceCheck={serviceCheck}
                onAdminSettingsChange={updateAdminSettings}
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
