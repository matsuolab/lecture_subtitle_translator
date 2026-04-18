import { useState, useCallback, useEffect, useRef, useTransition } from 'react'
import { convertFileSrc, isTauri } from '@tauri-apps/api/core'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { readFile, readTextFile } from '@tauri-apps/plugin-fs'
import { open as openDialog, confirm as confirmDialog } from '@tauri-apps/plugin-dialog'
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
  exportProjectJson,
  importProjectJson,
  importSrt,
  exportSrt,
  saveVideoSource,
  loadVideoSource,
  type VideoSourceState,
} from '@/api/persistence'
import { loadAdminSettings, saveAdminSettings, getDefaultAdminSettings, hydrateFromKeychain, saveSecrets } from '@/api/adminSettings'
import { hasPipelineApi, runPipelineViaApi } from '@/api/pipelineClient'
import { buildPipelineConfig } from '@/lib/pipeline/config'
import { runPipeline } from '@/lib/pipeline/runner'
import { createOpenAIEmbedProvider } from '@/lib/pipeline/providers/openaiEmbedProvider'
import { createTauriFFmpegProvider } from '@/lib/pipeline/providers/ffmpegProvider'
import { createDockerWhisperXProvider, createHTTPWhisperXProvider } from '@/lib/pipeline/providers/whisperxProvider'
import { extractAudioNode } from '@/lib/pipeline/nodes/extractAudio'
import { transcribeNode } from '@/lib/pipeline/nodes/transcribe'
import type { PipelineSubtitleBlock, TranscriptSegment } from '@/lib/pipeline/types'
import type { SubtitleBlock } from '@/types/subtitle'
import type { AdminSettings } from '@/types/adminSettings'
import type { PipelineAuditReport, PipelineNodeTrace, PipelineReviewItem, PipelineRunMetrics, PipelineRunResult, PipelineRunLog } from '@/types/pipeline'
import { savePipelineLog, loadPipelineLogs } from '@/api/pipelineLogs'
import { useTheme } from '@/context/ThemeContext'
import { useLocale } from '@/context/LocaleContext'
import { useGlossary } from '@/context/GlossaryContext'
import { applyGlossaryToText } from '@/utils/glossaryApply'

type Tab = 'subtitles' | 'dictionary' | 'help' | 'report' | 'settings'
type SaveStatus = 'saved' | 'saving'

export default function App() {
  const { theme } = useTheme()
  const { strings: t } = useLocale()
  const { glossary, importEntries } = useGlossary()
  const restored = loadFromLocalStorage()
  const { current: blocks, push, undo, redo, canUndo, canRedo, reset } =
    useHistory<SubtitleBlock[]>(restored ?? [])
  const [activeTab, setActiveTab] = useState<Tab>('subtitles')
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('saved')
  const [restoredMsg, setRestoredMsg] = useState(restored !== null)
  const importRef = useRef<HTMLInputElement>(null)
  const srtImportRef = useRef<HTMLInputElement>(null)
  const videoFileRef = useRef<HTMLInputElement>(null)
  const [videoUrl, setVideoUrl] = useState<string | null>(() => {
    // 起動時: 前回保存した path があれば convertFileSrc で復元（Tauri 環境のみ）
    if (typeof window !== 'undefined' && isTauri()) {
      const saved = loadVideoSource()
      if (saved?.path) {
        try { return convertFileSrc(saved.path) } catch { /* ignore */ }
      }
    }
    return null
  })
  const videoErrorRetried = useRef(false)
  const [videoSource, setVideoSource] = useState<VideoSourceState | null>(() => {
    if (typeof window !== 'undefined') return loadVideoSource()
    return null
  })
  const [isDragOverRight, setIsDragOverRight] = useState(false)
  const lastHtmlDropRef = useRef(0)
  const [pipelineRun, setPipelineRun] = useState<PipelineRunResult>({
    status: 'idle',
    step: 'idle',
    message: 'レポートタブからパイプラインを開始できます',
  })
  const [pipelineHistory, setPipelineHistory] = useState<PipelineRunResult[]>([])
  const [pipelineStatusPinned, setPipelineStatusPinned] = useState(false)
  const [adminSettings, setAdminSettings] = useState<AdminSettings>(() => loadAdminSettings())
  // keychain からのセンシティブ値読み込みが完了したかどうか。
  // false の間は save useEffect を抑制し、未ロード状態で空文字を keychain に書かないようにする。
  const [secretsLoaded, setSecretsLoaded] = useState(false)

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

  const { videoRef, currentTime, duration, isPlaying, activeBlockId, seekTo, togglePlay, onTimeUpdate, onPlay, onPause, onLoadedMetadata, onError: onVideoErrorRaw } =
    useVideoSync(blocks, videoUrl)

  // 動画エラー時: path がある場合は convertFileSrc で1回だけ自動復元を試みる
  const onVideoError = useCallback(() => {
    onVideoErrorRaw()
    if (!videoErrorRetried.current && videoSource?.path) {
      videoErrorRetried.current = true
      try {
        setVideoUrl(convertFileSrc(videoSource.path))
      } catch { /* ignore */ }
    }
  }, [onVideoErrorRaw, videoSource?.path])

  const loadVideoFile = useCallback((file: File) => {
    lastHtmlDropRef.current = Date.now()
    const fileId = `${file.name}-${file.size}-${file.lastModified}`
    setVideoSource({ name: file.name, fileId })
    videoErrorRetried.current = false
    setVideoUrl(prev => {
      if (prev && prev.startsWith('blob:')) URL.revokeObjectURL(prev)
      return URL.createObjectURL(file)
    })
  }, [])

  const loadVideoPath = useCallback((path: string) => {
    const name = path.split(/[\\/]/).pop() ?? path
    setVideoSource({ name, path, fileId: path })
    videoErrorRetried.current = false
    setVideoUrl(prev => {
      if (prev && prev.startsWith('blob:')) URL.revokeObjectURL(prev)
      return convertFileSrc(path)
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

  // 起動時に keychain からセンシティブ値を読み込んで adminSettings に反映する。
  // 旧バージョンからの移行: localStorage に残っていたキーは
  // 最初の saveAdminSettings() 呼び出しで localStorage から除去される。
  useEffect(() => {
    hydrateFromKeychain()
      .then(patch => {
        if (Object.keys(patch).length > 0) {
          setAdminSettings(prev => ({ ...prev, ...patch }))
        }
      })
      .catch(() => {})
      .finally(() => setSecretsLoaded(true))
  }, [])

  useEffect(() => {
    if (!secretsLoaded) return
    saveAdminSettings(adminSettings)
    saveSecrets(adminSettings).catch(() => {})
  }, [adminSettings, secretsLoaded])

  // videoSource を localStorage に永続化（動画消失対策）
  useEffect(() => {
    saveVideoSource(videoSource)
  }, [videoSource])

  const updateAdminSettings = useCallback((patch: Partial<AdminSettings>) => {
    setAdminSettings(prev => ({ ...prev, ...patch }))
  }, [])

  const resetAdminSettings = useCallback(() => {
    setAdminSettings(getDefaultAdminSettings())
  }, [])

  const calcPipelineMetrics = useCallback((generated: SubtitleBlock[], startedAt: number, finishedAt: number): PipelineRunMetrics => {
    const totalBlocks = Math.max(1, generated.length)
    // splitEn と同じ基準（maxCps=17, maxChars=42 for English）で一致させる
    const cpsViolationCount = generated.filter(b => b.status === 'flagged').length
    const overLengthCount = generated.filter(b => b.source.length > 42).length
    const flaggedCount = cpsViolationCount

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
  }, [])

  const buildAuditReport = useCallback((generated: SubtitleBlock[], traces: PipelineNodeTrace[]): PipelineAuditReport => {
    const items: PipelineReviewItem[] = []

    generated.forEach(block => {
      if (block.cps > 15) {
        items.push({
          id: `cps-${block.id}`,
          nodeId: 'cps_guard',
          reason: `CPS超過 (${block.cps.toFixed(1)} > 15.0)`,
          priority: 'must_review',
          score: Math.min(1, (block.cps - 15) / 10),
          blockId: block.id,
        })
      }
      const overLen = block.target.split('\n').some(line => line.length > 42)
      if (overLen) {
        items.push({
          id: `len-${block.id}`,
          nodeId: 'subtitle_format',
          reason: '42文字超過行あり',
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
  }, [])

  const appendPipelineHistory = useCallback((result: PipelineRunResult) => {
    setPipelineHistory(prev => [result, ...prev].slice(0, 20))
  }, [])

  // 起動時: ディスクのパイプラインログを履歴として復元する
  useEffect(() => {
    loadPipelineLogs().then(logs => {
      if (logs.length === 0) return
      const results: PipelineRunResult[] = [...logs].reverse().map(log => ({
        status: 'success' as const,
        step: 'done' as const,
        message: `パイプライン完了（${log.finalBlocks.length}ブロック）`,
        sourceName: log.sourceFile,
        startedAt: log.startedAt,
        finishedAt: log.finishedAt,
        log,
      }))
      setPipelineHistory(results)
    })
  }, [])

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

  const pipelineBlocksToSubtitleBlocks = useCallback(
    (pipelineBlocks: readonly PipelineSubtitleBlock[]): SubtitleBlock[] =>
      pipelineBlocks.map(b => {
        const charCount = b.text.length
        const durationSec = Math.max(0.1, b.end - b.start)
        return {
          id: b.id,
          startTime: b.start,
          endTime: b.end,
          source: b.text,    // 英語字幕テキスト（SRT出力・動画オーバーレイ・CPS計算に使用）
          target: b.jaText,  // 日本語原文（参照用）
          cps: Math.round((charCount / durationSec) * 10) / 10,
          charCount,
          status: b.flagged ? 'flagged' : 'pending',
          glossaryTerms: [],
        }
      }),
    [],
  )

  const runDropPipeline = useCallback(async (sourceName: string, sourcePath?: string) => {
    const startedAt = Date.now()
    const traces: PipelineNodeTrace[] = []

    const runStep = async (
      nodeId: string,
      step: PipelineRunResult['step'],
      message: string,
      waitMs: number,
      summary: string,
      provider = 'stub',
      model = 'stub-v1',
    ) => {
      setPipelineRun({ status: 'running', step, message, sourceName, startedAt })
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

    // エラーをユーザー向けメッセージに変換
    const toUserMessage = (err: unknown, step: string): string => {
      const raw = (
        err instanceof Error ? err.message :
        typeof err === 'string' ? err :
        err && typeof err === 'object' && 'message' in err ? String((err as Record<string, unknown>).message) :
        (() => { try { return JSON.stringify(err) } catch { return String(err) } })()
      ).toLowerCase()

      if (!adminSettings.openaiApiKey.trim()) {
        return '⚙️ OpenAI API Key が未設定です。設定タブ → OpenAI API Key を入力してください。'
      }
      if (raw.includes('no such image') || raw.includes('unable to find image')) {
        return '🐳 WhisperX イメージが見つかりません。次のコマンドを実行してください:\ndocker pull ghcr.io/jim60105/whisperx:large-v3-ja'
      }
      if (raw.includes('docker') || raw.includes('command not found') || raw.includes('exit 127')) {
        return '🐳 Docker が起動していないか、docker コマンドが見つかりません。Docker Desktop を起動してください。'
      }
      if (raw.includes('unauthorized') || raw.includes('invalid api key') || raw.includes('incorrect api key')) {
        return '🔑 OpenAI API Key が無効です。設定タブから正しい Key を入力してください。'
      }
      if (raw.includes('rate limit') || raw.includes('429') || raw.includes('quota')) {
        return '⏱ OpenAI API のレート制限またはクォータ超過です。しばらく待ってから再試行してください。'
      }
      if (raw.includes('ffmpeg')) {
        return `🎬 音声抽出（ffmpeg）に失敗しました。動画ファイルが対応形式か確認してください。\n詳細: ${raw}`
      }

      const rawFull = err instanceof Error ? err.message :
        typeof err === 'string' ? err :
        (() => { try { return JSON.stringify(err) } catch { return String(err) } })()
      return `[${step}] ${rawFull}`
    }

    let currentStep = 'init'

    setActiveTab('subtitles')
    try {
      let generated: SubtitleBlock[] = []
      let audit: PipelineAuditReport | undefined
      let pipelineLog: PipelineRunLog | undefined

      // openaiApiKey があれば LLM パイプラインを実行
      // whisperxUrl が空 → ローカル Docker、設定済み → AWS HTTP
      const hasLocalPipeline = adminSettings.openaiApiKey.trim().length > 0

      if (hasLocalPipeline && sourcePath) {
        // ─── ローカルパイプライン（ffmpeg → WhisperX → LLMパイプライン）────
        const pipelineConfig = buildPipelineConfig(adminSettings)
        const embedProvider = createOpenAIEmbedProvider(
          pipelineConfig.openaiApiKey,
          pipelineConfig.embeddingModel,
        )
        const ctx = {
          config: pipelineConfig,
          glossary: glossary
            .filter(g => g.confirmed)
            .map(g => ({ ja: g.ja, en: g.en, ...(g.abbr ? { abbr: g.abbr } : {}) })),
          onProgress: (msg: string) => {
            const step = (
              msg.startsWith('extractAudio') ? 'transcribe' :
              msg.startsWith('transcribe') ? 'transcribe' :
              msg.startsWith('correctJa') ? 'correct' :
              msg.startsWith('splitJa') || msg.startsWith('mergeShort') || msg.startsWith('translateEn') || msg.startsWith('expandEn') || msg.startsWith('formatLines') || msg.startsWith('compressEn') || msg.startsWith('splitEn') ? 'translate' :
              msg.startsWith('finalQA') ? 'subtitle' :
              'subtitle'
            ) as PipelineRunResult['step']
            setPipelineRun({ status: 'running', step, message: msg, sourceName, startedAt })
          },
          reportUsage: (_: { tokensIn: number; tokensOut: number; model: string; provider: string }) => {
            // TODO: Phase 5 でコスト集計に接続
          },
        }

        currentStep = 'extractAudio'
        setPipelineRun({ status: 'running', step: 'transcribe', message: '音声抽出中...', sourceName, startedAt })
        const ffmpegProvider = createTauriFFmpegProvider()
        const { wavPath } = await extractAudioNode.run({ videoPath: sourcePath, ffmpeg: ffmpegProvider }, ctx)

        // whisperxUrl が設定済み → AWS HTTP、未設定 → ローカル Docker
        const whisperxProvider = pipelineConfig.whisperxUrl
          ? createHTTPWhisperXProvider(pipelineConfig.whisperxUrl, pipelineConfig.whisperxApiKey)
          : createDockerWhisperXProvider()

        currentStep = 'transcribe'
        setPipelineRun({ status: 'running', step: 'transcribe', message: 'WhisperX 書き起こし中...', sourceName, startedAt })
        let transcriptSegments
        try {
          transcriptSegments = await transcribeNode.run({ wavPath, whisperxProvider }, ctx)
        } finally {
          // WAV 一時ファイルを確実に削除（書き起こし成功・失敗どちらでも）
          const { remove } = await import('@tauri-apps/plugin-fs')
          await remove(wavPath).catch(() => {})
        }

        currentStep = 'correctJa'

        const pipelineResult = await runPipeline(transcriptSegments, ctx, {
          embedProvider,
          sourceFile: sourceName,
          startedAt,
        })

        generated = pipelineBlocksToSubtitleBlocks(pipelineResult.result.subtitleBlocks)
        pipelineLog = pipelineResult.log

        const pipelineTraces: PipelineNodeTrace[] = pipelineResult.runState.nodeTraces.map((t: import('@/lib/pipeline/nodeContract').NodeTrace) => ({
          nodeId: t.nodeId,
          status: t.status,
          attempt: t.attempt,
          durationMs: t.durationMs,
          provider: t.provider,
          model: t.model,
          summary: t.error ?? `${t.nodeId} 完了`,
        }))
        audit = buildAuditReport(generated, pipelineTraces)

      } else if (hasPipelineApi(adminSettings)) {
        // ─── 旧バックエンドAPI ────────────────────────────────────────────────
        setPipelineRun({ status: 'running', step: 'transcribe', message: 'パイプライン開始中...', sourceName, startedAt })
        const apiResult = await runPipelineViaApi(sourceName, adminSettings, sourcePath, (progress) => {
          const nodeLabel: Record<string, string> = {
            extract_audio: '音声抽出',
            transcribe: '書き起こし（WhisperX）',
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
          const stepKey = (node || 'transcribe') as PipelineRunResult['step']
          setPipelineRun({
            status: 'running',
            step: stepKey,
            message: `${label}${elapsed}`,
            sourceName,
            startedAt,
          })
        })
        generated = apiResult.blocks
        audit = apiResult.audit
      } else {
        // ─── スタブ（開発用） ─────────────────────────────────────────────────
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

      const finishedAt = Date.now()
      const metrics = calcPipelineMetrics(generated, startedAt, finishedAt)
      const result: PipelineRunResult = {
        status: 'success',
        step: 'done',
        message: `パイプライン完了（${generated.length}ブロック）`,
        sourceName,
        startedAt,
        finishedAt,
        metrics,
        audit,
        log: pipelineLog,
      }
      setPipelineRun(result)
      appendPipelineHistory(result)
      if (pipelineLog) {
        savePipelineLog(pipelineLog, adminSettings.logRetentionCount)
      }
    } catch (err) {
      const userMessage = toUserMessage(err, currentStep)
      const result: PipelineRunResult = {
        status: 'error',
        step: 'done',
        message: userMessage,
        sourceName,
        startedAt,
        finishedAt: Date.now(),
        audit: {
          mustReviewCount: 1,
          shouldReviewCount: 0,
          autoPassCount: 0,
          reviewItems: [
            {
              id: 'pipeline-error',
              nodeId: currentStep,
              reason: userMessage,
              priority: 'must_review',
              score: 0,
            },
          ],
          nodeTraces: traces,
        },
      }
      setPipelineRun(result)
      appendPipelineHistory(result)
    }
  }, [adminSettings, appendPipelineHistory, buildAuditReport, buildPipelineStubBlocks, calcPipelineMetrics, pipelineBlocksToSubtitleBlocks, reset, sleep])

  const confirmAndLoadVideo = useCallback(async (doLoad: () => void, newFileId?: string) => {
    // 同じファイルの再読み込みなら字幕を保持してそのまま切り替え（リセット確認不要）
    if (newFileId && newFileId === videoSource?.fileId) {
      doLoad()
      return
    }
    // 動画は必ず読み込む。字幕が存在する場合のみリセットするか確認する。
    doLoad()
    if (blocks.length > 0) {
      const ok = isTauri()
        ? await confirmDialog('字幕データをリセットしますか？\n\nOK → 字幕をクリアして新しい動画に切り替えます\nキャンセル → 字幕を保持したまま動画だけ切り替えます', { title: '字幕のリセット', kind: 'warning' })
        : window.confirm('字幕データをリセットしますか？\nキャンセルを選ぶと字幕を保持したまま動画だけ切り替えます。')
      if (ok) reset([])
    }
  }, [blocks.length, reset, videoSource?.fileId])

  const handleVideoInput = useCallback((file: File) => {
    const fileId = `${file.name}-${file.size}-${file.lastModified}`
    confirmAndLoadVideo(() => loadVideoFile(file), fileId)
  }, [confirmAndLoadVideo, loadVideoFile])

  const handleVideoPathInput = useCallback((path: string) => {
    confirmAndLoadVideo(() => loadVideoPath(path), path)
  }, [confirmAndLoadVideo, loadVideoPath])

  const handleOpenVideoDialog = useCallback(async () => {
    if (!isTauri()) return
    const selected = await openDialog({
      multiple: false,
      filters: [{ name: '動画ファイル', extensions: ['mp4', 'mkv', 'avi', 'mov', 'webm', 'ts', 'mts'] }],
    })
    if (!selected) return
    const path = typeof selected === 'string' ? selected : selected
    confirmAndLoadVideo(() => loadVideoPath(path), path)
  }, [confirmAndLoadVideo, loadVideoPath])

  const handleRunPipelineFromReport = useCallback(async () => {
    if (!videoSource) return
    // Tauri 環境でフルパスが未取得の場合、ダイアログでパスを取得してから実行
    if (!videoSource.path && isTauri()) {
      const selected = await openDialog({
        multiple: false,
        title: `パイプライン用の動画ファイルを選択（${videoSource.name}）`,
        filters: [{ name: '動画ファイル', extensions: ['mp4', 'mkv', 'avi', 'mov', 'webm', 'ts', 'mts'] }],
      })
      if (!selected) return
      const path = typeof selected === 'string' ? selected : selected
      void runDropPipeline(videoSource.name, path)
      return
    }
    void runDropPipeline(videoSource.name, videoSource.path)
  }, [videoSource, runDropPipeline])

  const handleRerunFromTranscript = useCallback(async (run: PipelineRunResult) => {
    const transcriptSegments = run.log?.transcribeOutput
    if (!transcriptSegments || transcriptSegments.length === 0) return

    const sourceName = run.sourceName ?? 'unknown'
    const startedAt = Date.now()
    setActiveTab('subtitles')

    const toUserMessage = (err: unknown, step: string): string => {
      const rawFull = err instanceof Error ? err.message :
        typeof err === 'string' ? err :
        (() => { try { return JSON.stringify(err) } catch { return String(err) } })()
      return `[${step}] ${rawFull}`
    }

    let currentStep = 'correctJa'
    try {
      const pipelineConfig = buildPipelineConfig(adminSettings)
      const embedProvider = createOpenAIEmbedProvider(
        pipelineConfig.openaiApiKey,
        pipelineConfig.embeddingModel,
      )
      const ctx = {
        config: pipelineConfig,
        glossary: glossary
          .filter(g => g.confirmed)
          .map(g => ({ ja: g.ja, en: g.en, ...(g.abbr ? { abbr: g.abbr } : {}) })),
        onProgress: (msg: string) => {
          const step = (
            msg.startsWith('correctJa') ? 'correct' :
            msg.startsWith('splitJa') || msg.startsWith('mergeShort') || msg.startsWith('translateEn') || msg.startsWith('expandEn') || msg.startsWith('formatLines') || msg.startsWith('compressEn') || msg.startsWith('splitEn') ? 'translate' :
            msg.startsWith('finalQA') ? 'subtitle' :
            'subtitle'
          ) as PipelineRunResult['step']
          setPipelineRun({ status: 'running', step, message: msg, sourceName, startedAt })
        },
        reportUsage: (_: { tokensIn: number; tokensOut: number; model: string; provider: string }) => {},
      }

      setPipelineRun({ status: 'running', step: 'correct', message: '書き起こし再利用: 日本語補正中...', sourceName, startedAt })

      const pipelineResult = await runPipeline(transcriptSegments as readonly TranscriptSegment[], ctx, {
        embedProvider,
        sourceFile: sourceName,
        startedAt,
      })

      const generated = pipelineBlocksToSubtitleBlocks(pipelineResult.result.subtitleBlocks)
      const pipelineLog = pipelineResult.log

      const pipelineTraces: PipelineNodeTrace[] = pipelineResult.runState.nodeTraces.map((t: import('@/lib/pipeline/nodeContract').NodeTrace) => ({
        nodeId: t.nodeId,
        status: t.status,
        attempt: t.attempt,
        durationMs: t.durationMs,
        provider: t.provider,
        model: t.model,
        summary: t.error ?? `${t.nodeId} 完了`,
      }))
      const audit = buildAuditReport(generated, pipelineTraces)

      reset(generated)

      const finishedAt = Date.now()
      const metrics = calcPipelineMetrics(generated, startedAt, finishedAt)
      const result: PipelineRunResult = {
        status: 'success',
        step: 'done',
        message: `再実行完了（書き起こし再利用・${generated.length}ブロック）`,
        sourceName,
        startedAt,
        finishedAt,
        metrics,
        audit,
        log: pipelineLog,
      }
      setPipelineRun(result)
      appendPipelineHistory(result)
      if (pipelineLog) {
        savePipelineLog(pipelineLog, adminSettings.logRetentionCount)
      }
    } catch (err) {
      const userMessage = toUserMessage(err, currentStep)
      const result: PipelineRunResult = {
        status: 'error',
        step: 'done',
        message: userMessage,
        sourceName,
        startedAt,
        finishedAt: Date.now(),
        audit: {
          mustReviewCount: 1,
          shouldReviewCount: 0,
          autoPassCount: 0,
          reviewItems: [{ id: 'pipeline-error', nodeId: currentStep, reason: userMessage, priority: 'must_review', score: 0 }],
          nodeTraces: [],
        },
      }
      setPipelineRun(result)
      appendPipelineHistory(result)
    }
  }, [adminSettings, appendPipelineHistory, buildAuditReport, calcPipelineMetrics, pipelineBlocksToSubtitleBlocks, reset])

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
    lastHtmlDropRef.current = Date.now()
    const file = e.dataTransfer.files[0]
    if (!file) return
    const name = file.name.toLowerCase()
    if (name.endsWith('.srt') || name.endsWith('.txt')) {
      try {
        const imported = await importSrt(file)
        reset(imported)
      } catch {
        alert(t.importSrtError)
      }
    } else if (name.endsWith('.json')) {
      try {
        const imported = await importProjectJson(file)
        reset(imported)
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
        alert(`用語辞書の読み込みに失敗しました: ${err instanceof Error ? err.message : '不明なエラー'}`)
      }
    } else {
      alert(`非対応のファイル形式です: ${file.name}\n対応形式: .srt, .txt, .json, .csv, .xlsx`)
    }
  }, [reset, t.importSrtError, t.importError, importEntries])

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
        if (name.endsWith('.mp4') || name.endsWith('.mov') || name.endsWith('.mkv') || name.endsWith('.webm')) {
          handleVideoPathInput(path)
          return
        }
        if (name.endsWith('.srt') || name.endsWith('.txt')) {
          const imported = await importSrt(await readTextFileAsFile(path))
          reset(imported)
          return
        }
        if (name.endsWith('.json')) {
          const imported = await importProjectJson(await readTextFileAsFile(path))
          reset(imported)
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
対応形式: .srt, .txt, .json, .csv, .xlsx, .mp4`)
      } catch (err) {
        alert(`読み込みに失敗しました: ${err instanceof Error ? err.message : '不明なエラー'}`)
      }
    }).then(fn => {
      if (cancelled) fn()  // すでにアンマウント済みなら即解除
      else unlisten = fn
    })
    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [reset, importEntries, handleVideoPathInput, readTextFileAsFile, readBinaryFileAsFile])

  const handleLoadVideo = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    handleVideoInput(file)
    e.target.value = ''
  }, [handleVideoInput])

  // I/O ショートカット用: currentTime は毎フレーム変わるため ref で保持
  const currentTimeRef = useRef(currentTime)
  useEffect(() => { currentTimeRef.current = currentTime }, [currentTime])

  // アイドル時に自動保存（最大5秒以内に必ず実行）
  // requestIdleCallback でメインスレッドをブロックしない
  useEffect(() => {
    setSaveStatus('saving')
    const doSave = () => {
      saveToLocalStorage(blocks)
      setSaveStatus('saved')
    }
    if (typeof requestIdleCallback !== 'undefined') {
      const handle = requestIdleCallback(doSave, { timeout: 5000 })
      return () => cancelIdleCallback(handle)
    }
    // フォールバック（未対応環境）
    const timerId = setTimeout(doSave, 1000)
    return () => clearTimeout(timerId)
  }, [blocks])

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
    } catch {
      alert(t.importError)
    }
    e.target.value = ''
  }, [reset])

  const handleImportSrt = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const imported = await importSrt(file)
      reset(imported)
    } catch {
      alert(t.importSrtError)
    }
    e.target.value = ''
  }, [reset, t.importSrtError])

  const handleBlockSelect = useCallback((id: number) => {
    const block = blocks.find(b => b.id === id)
    if (block) seekTo(block.startTime)
  }, [blocks, seekTo])

  const handleApprove = useCallback((id: number) => {
    push(blocks.map(b => {
      if (b.id !== id) return b
      return { ...b, status: b.status === 'approved' ? 'pending' as const : 'approved' as const }
    }))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocks])

  const handleFlag = useCallback((id: number) => {
    push(blocks.map(b => {
      if (b.id !== id) return b
      return { ...b, status: b.status === 'flagged' ? 'pending' as const : 'flagged' as const }
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
    const [b1, b2] = makeSplitBlocks(block, splitTime, textBefore, textAfter)
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
    const [b1, b2] = makeSplitBlocks(block, splitTime, textBefore, textAfter)
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
    const [b1, b2] = makeSplitBlocks(block, splitTime, textBefore, textAfter)
    const next = [...blocks]
    next.splice(idx, 1, b1, b2)
    push(next)
  }, [blocks, push, splitAtWordBoundary, makeSplitBlocks])

  const handleMerge = useCallback((dragId: number, dropId: number) => {
    const dragIdx = blocks.findIndex(b => b.id === dragId)
    const dropIdx = blocks.findIndex(b => b.id === dropId)
    if (dragIdx === -1 || dropIdx === -1) return

    const firstIdx = Math.min(dragIdx, dropIdx)
    const secondIdx = Math.max(dragIdx, dropIdx)
    const first = blocks[firstIdx]
    const second = blocks[secondIdx]
    const mergedText = first.source + ' ' + second.source
    const duration = second.endTime - first.startTime
    const merged: SubtitleBlock = {
      ...first,
      endTime: second.endTime,
      target: first.target + second.target,
      source: mergedText,
      cps: duration > 0 ? Math.round(mergedText.length / duration * 10) / 10 : 0,
      charCount: mergedText.length,
      status: 'pending',
      glossaryTerms: [...first.glossaryTerms, ...second.glossaryTerms],
    }
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
        const dur = Math.max(0.01, block.endTime - newStart)
        push(blocks.map(b => b.id !== activeBlockId ? b : {
          ...b, startTime: newStart, cps: Math.round(b.charCount / dur * 10) / 10,
        }))
        return
      }

      // O: アウト点マーク — アクティブブロックの終了時刻を再生位置にセット
      if (e.key === 'o' && !e.ctrlKey && !e.metaKey) {
        if (activeBlockId === null) return
        const block = blocks.find(b => b.id === activeBlockId)
        if (!block || block.status === 'approved') return
        const newEnd = currentTimeRef.current
        if (newEnd <= block.startTime) return
        const dur = Math.max(0.01, newEnd - block.startTime)
        push(blocks.map(b => b.id !== activeBlockId ? b : {
          ...b, endTime: newEnd, cps: Math.round(b.charCount / dur * 10) / 10,
        }))
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
    push(blocks.map(b => {
      if (b.id !== id) return b
      const dur = Math.max(0.01, endTime - startTime)
      return { ...b, startTime, endTime, cps: Math.round(b.charCount / dur * 10) / 10 }
    }))
  }, [blocks, push])

  const handleAdjustBoundary = useCallback((id1: number, id2: number, newTime: number) => {
    push(blocks.map(b => {
      if (b.id === id1) {
        const dur = Math.max(0.01, newTime - b.startTime)
        return { ...b, endTime: newTime, cps: Math.round(b.charCount / dur * 10) / 10 }
      }
      if (b.id === id2) {
        const dur = Math.max(0.01, b.endTime - newTime)
        return { ...b, startTime: newTime, cps: Math.round(b.charCount / dur * 10) / 10 }
      }
      return b
    }))
  }, [blocks, push])

  const handleUpdateTarget = useCallback((id: number, text: string) => {
    push(blocks.map(b => b.id !== id ? b : { ...b, target: text }))
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
    const b1: SubtitleBlock = {
      ...block,
      endTime: splitTime,
      target: targetBefore,
      // source はそのままコピー（言語が違うため比率分割しない）
      cps: Math.round(block.source.length / dur1 * 10) / 10,
    }
    const b2: SubtitleBlock = {
      ...block,
      id: newId,
      startTime: splitTime,
      target: targetAfter,
      // source はそのままコピー
      cps: Math.round(block.source.length / dur2 * 10) / 10,
      status: 'pending' as const,
      glossaryTerms: [],
    }
    const next = [...blocks]
    next.splice(idx, 1, b1, b2)
    push(next)
  }, [blocks, push])

  const handleUpdateSource = useCallback((id: number, text: string) => {
    push(blocks.map(b => {
      if (b.id !== id) return b
      const duration = b.endTime - b.startTime
      return { ...b, source: text, cps: Math.round(text.length / Math.max(0.1, duration) * 10) / 10, charCount: text.length }
    }))
  }, [blocks, push])

  const handleIgnoreWarning = useCallback((id: number, type: 'typo' | 'missing', key: string) => {
    push(blocks.map(b => {
      if (b.id !== id) return b
      if (type === 'typo') {
        const cur = b.ignoredTypos ?? []
        const next = cur.includes(key) ? cur.filter(k => k !== key) : [...cur, key]
        return { ...b, ignoredTypos: next }
      } else {
        const cur = b.ignoredMissing ?? []
        const next = cur.includes(key) ? cur.filter(k => k !== key) : [...cur, key]
        return { ...b, ignoredMissing: next }
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
              onClick={() => isTauri() ? handleOpenVideoDialog() : videoFileRef.current?.click()}
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
            onOpenDialogLoadVideo={isTauri() ? handleOpenVideoDialog : undefined}
            onTogglePlay={togglePlay}
            onSeek={seekTo}
            subtitleOverlay={subtitleOverlay}
            blocks={blocks}
            onTimeUpdate={onTimeUpdate}
            onPlay={onPlay}
            onPause={onPause}
            onLoadedMetadata={onLoadedMetadata}
            onError={onVideoError}
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
              <button onClick={() => exportSrt(blocks)} title={t.exportSrtTitle}
                style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, whiteSpace: 'nowrap', color: theme.textSecondary, padding: '3px 8px', borderRadius: 5, border: `1px solid ${theme.panelBorder}`, background: theme.btnBg, cursor: 'pointer' }}>
                <Download size={11} />SRT出力
              </button>
              <div style={{ width: 1, background: theme.panelBorder, alignSelf: 'stretch', margin: '2px 2px' }} />
              <button onClick={() => importRef.current?.click()} title={t.loadProjectTitle}
                style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, whiteSpace: 'nowrap', color: theme.textSecondary, padding: '3px 8px', borderRadius: 5, border: `1px solid ${theme.panelBorder}`, background: theme.btnBg, cursor: 'pointer' }}>
                <FolderOpen size={11} />JSON読込
              </button>
              <button onClick={() => exportProjectJson(blocks)} title={t.saveProjectTitle}
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
                  Pipeline: {pipelineRun.status === 'running' ? '実行中' : pipelineRun.status === 'success' ? '完了' : pipelineRun.status === 'error' ? '失敗' : '待機中'}
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
                    42文字超過率: {(pipelineRun.metrics.quality.overLengthRate * 100).toFixed(1)}%
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
          <div className="flex-1 overflow-hidden min-h-0">
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
              />
            )}
            {!isResizing && activeTab === 'dictionary' && <GlossaryTab onApplyAll={handleApplyGlossary} />}
            {!isResizing && activeTab === 'help' && <HelpTab />}
            {!isResizing && activeTab === 'report' && (
              <ReportTab
                runs={pipelineHistory}
                pipelineRun={pipelineRun}
                videoSourceName={videoSource?.name ?? null}
                onRunPipeline={handleRunPipelineFromReport}
                onRerunFromTranscript={handleRerunFromTranscript}
                activeBlockId={activeBlockId}
              />
            )}
            {!isResizing && activeTab === 'settings' && (
              <SettingsTab
                adminSettings={adminSettings}
                onAdminSettingsChange={updateAdminSettings}
                onAdminSettingsReset={resetAdminSettings}
              />
            )}
          </div>
        </section>

      </main>
    </div>
  )
}


