import { useState, useCallback, useEffect, useRef } from 'react'
import { convertFileSrc, isTauri } from '@tauri-apps/api/core'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { readFile, readTextFile } from '@tauri-apps/plugin-fs'
import { Download, Save, FolderOpen, Settings, Film } from 'lucide-react'
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
} from '@/api/persistence'
import type { SubtitleBlock } from '@/types/subtitle'
import type { PipelineRunMetrics, PipelineRunResult } from '@/types/pipeline'
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
  const [videoUrl, setVideoUrl] = useState<string | null>(null)
  const [isDragOverRight, setIsDragOverRight] = useState(false)
  const lastHtmlDropRef = useRef(0)
  const [pipelineRun, setPipelineRun] = useState<PipelineRunResult>({
    status: 'idle',
    step: 'idle',
    message: '動画をドロップするとパイプラインを開始します',
  })
  const [pipelineHistory, setPipelineHistory] = useState<PipelineRunResult[]>([])

  // パネルリサイズ
  const [leftPct, setLeftPct] = useState(45)
  const [timelineH, setTimelineH] = useState(60)
  const mainRef = useRef<HTMLDivElement>(null)
  const timelineHRef = useRef(timelineH)
  useEffect(() => { timelineHRef.current = timelineH }, [timelineH])

  const handleHResizeMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    const onMove = (mv: MouseEvent) => {
      const el = mainRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      const pct = ((mv.clientX - rect.left) / rect.width) * 100
      setLeftPct(Math.max(25, Math.min(72, pct)))
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [])

  const handleVResizeMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    const startY = e.clientY
    const startH = timelineHRef.current
    const onMove = (mv: MouseEvent) => {
      const dy = startY - mv.clientY
      setTimelineH(Math.max(30, Math.min(200, startH + dy)))
    }
    const onUp = () => {
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
    setVideoUrl(prev => {
      if (prev && prev.startsWith('blob:')) URL.revokeObjectURL(prev)
      return URL.createObjectURL(file)
    })
  }, [])

  const loadVideoPath = useCallback((path: string) => {
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


  const calcPipelineMetrics = useCallback((generated: SubtitleBlock[], startedAt: number, finishedAt: number): PipelineRunMetrics => {
    const totalBlocks = Math.max(1, generated.length)
    const cpsViolationCount = generated.filter(b => b.cps > 15).length
    const overLengthCount = generated.filter(b => b.target.split('\n').some(line => line.length > 42)).length
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
  }, [])

  const appendPipelineHistory = useCallback((result: PipelineRunResult) => {
    setPipelineHistory(prev => [result, ...prev].slice(0, 20))
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

  const runDropPipeline = useCallback(async (sourceName: string) => {
    const startedAt = Date.now()
    setActiveTab('subtitles')
    try {
      setPipelineRun({ status: 'running', step: 'transcribe', message: '文字起こしを実行中...', sourceName, startedAt })
      await sleep(350)
      setPipelineRun({ status: 'running', step: 'correct', message: '日本語テキストを補正中...', sourceName, startedAt })
      await sleep(300)
      setPipelineRun({ status: 'running', step: 'translate', message: '英訳を生成中...', sourceName, startedAt })
      await sleep(350)
      setPipelineRun({ status: 'running', step: 'subtitle', message: '字幕ブロックを生成中...', sourceName, startedAt })
      await sleep(260)

      const generated = buildPipelineStubBlocks(sourceName)
      reset(generated)

      const finishedAt = Date.now()
      const result: PipelineRunResult = {
        status: 'success',
        step: 'done',
        message: `パイプライン完了（${generated.length}ブロック）`,
        sourceName,
        startedAt,
        finishedAt,
        metrics: calcPipelineMetrics(generated, startedAt, finishedAt),
      }
      setPipelineRun(result)
      appendPipelineHistory(result)
    } catch (err) {
      const result: PipelineRunResult = {
        status: 'error',
        step: 'done',
        message: `パイプライン失敗: ${err instanceof Error ? err.message : '不明なエラー'}`,
        sourceName,
        startedAt,
        finishedAt: Date.now(),
      }
      setPipelineRun(result)
      appendPipelineHistory(result)
    }
  }, [appendPipelineHistory, buildPipelineStubBlocks, calcPipelineMetrics, reset, sleep])

  const handleVideoInput = useCallback((file: File) => {
    loadVideoFile(file)
    void runDropPipeline(file.name)
  }, [loadVideoFile, runDropPipeline])

  const handleVideoPathInput = useCallback((path: string) => {
    loadVideoPath(path)
    const sourceName = path.split(/[\\/]/).pop() ?? path
    void runDropPipeline(sourceName)
  }, [loadVideoPath, runDropPipeline])

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
    let unlisten: (() => void) | null = null
    getCurrentWebview().onDragDropEvent(async (event) => {
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
    }).then(fn => { unlisten = fn })
    return () => { if (unlisten) unlisten() }
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

  // 変更のたびに debounce 自動保存（1秒後）
  useEffect(() => {
    setSaveStatus('saving')
    const t = setTimeout(() => {
      saveToLocalStorage(blocks)
      setSaveStatus('saved')
    }, 1000)
    return () => clearTimeout(t)
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

  const handleBlockSelect = useCallback((block: SubtitleBlock) => {
    seekTo(block.startTime)
  }, [seekTo])

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

  const currentBlock = blocks.find(b => currentTime >= b.startTime && currentTime <= b.endTime)
  const subtitleOverlay = currentBlock
    ? {
        text: currentBlock.source,
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
              onClick={() => videoFileRef.current?.click()}
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

          {/* タブ + アンドゥ/リドゥ + SRT出力 */}
          <div className="flex items-center shrink-0" style={{ borderBottom: `1px solid ${theme.panelBorder}`, background: theme.headerBg }}>
            {(['subtitles', 'dictionary', 'help', 'report'] as Tab[]).map(tab => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                style={{
                  padding: '10px 16px',
                  fontSize: 13,
                  fontWeight: 600,
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
            <div className="ml-auto flex items-center gap-1.5 pr-3">
              <button
                onClick={undo}
                disabled={!canUndo}
                title="元に戻す (Ctrl+Z)"
                style={{
                  fontSize: 11, padding: '3px 7px', borderRadius: 5,
                  border: `1px solid ${theme.panelBorder}`, background: theme.btnBg,
                  color: canUndo ? theme.textSecondary : theme.textDisabled,
                  cursor: canUndo ? 'pointer' : 'not-allowed',
                }}
              >↩</button>
              <button
                onClick={redo}
                disabled={!canRedo}
                title="やり直し (Ctrl+Shift+Z)"
                style={{
                  fontSize: 11, padding: '3px 7px', borderRadius: 5,
                  border: `1px solid ${theme.panelBorder}`, background: theme.btnBg,
                  color: canRedo ? theme.textSecondary : theme.textDisabled,
                  cursor: canRedo ? 'pointer' : 'not-allowed',
                }}
              >↪</button>
              <span style={{ fontSize: 11, color: theme.textSecondary, marginLeft: 4 }}>
                {t.approvedCount(approvedCount, blocks.length)}
              </span>

              {/* 自動保存インジケーター */}
              <span style={{
                fontSize: 10,
                color: saveStatus === 'saving' ? theme.savingColor : theme.savedColor,
                marginLeft: 2,
                transition: 'color 0.3s',
              }}>
                {saveStatus === 'saving' ? t.saving : t.saved}
              </span>

              {/* 隠しファイル入力（JSON読み込み） */}
              <input ref={importRef} type="file" accept=".json" onChange={handleImportJson} style={{ display: 'none' }} />
              {/* 隠しファイル入力（SRT読み込み） */}
              <input ref={srtImportRef} type="file" accept=".srt,.txt" onChange={handleImportSrt} style={{ display: 'none' }} />

              {/* SRT読み込み */}
              <button
                className="flex items-center gap-1"
                onClick={() => srtImportRef.current?.click()}
                title={t.loadSrtTitle}
                style={{
                  fontSize: 11, color: theme.textSecondary, padding: '3px 8px',
                  borderRadius: 5, border: `1px solid ${theme.panelBorder}`,
                  background: theme.btnBg, cursor: 'pointer',
                }}
              >
                <FolderOpen size={11} />
                {t.loadSrt}
              </button>

              {/* プロジェクト読み込み */}
              <button
                className="flex items-center gap-1"
                onClick={() => importRef.current?.click()}
                title={t.loadProjectTitle}
                style={{
                  fontSize: 11, color: theme.textSecondary, padding: '3px 8px',
                  borderRadius: 5, border: `1px solid ${theme.panelBorder}`,
                  background: theme.btnBg, cursor: 'pointer',
                }}
              >
                <FolderOpen size={11} />
                {t.loadProject}
              </button>

              {/* プロジェクト保存（JSON） */}
              <button
                className="flex items-center gap-1"
                onClick={() => exportProjectJson(blocks)}
                title={t.saveProjectTitle}
                style={{
                  fontSize: 11, color: theme.textSecondary, padding: '3px 8px',
                  borderRadius: 5, border: `1px solid ${theme.panelBorder}`,
                  background: theme.btnBg, cursor: 'pointer',
                }}
              >
                <Save size={11} />
                {t.saveProject}
              </button>

              {/* SRT出力 */}
              <button
                className="flex items-center gap-1.5"
                onClick={() => exportSrt(blocks)}
                title={t.exportSrtTitle}
                style={{
                  fontSize: 11, color: theme.textSecondary, padding: '3px 8px',
                  borderRadius: 5, border: `1px solid ${theme.panelBorder}`,
                  background: theme.btnBg, cursor: 'pointer',
                }}
              >
                <Download size={11} />
                {t.exportSrt}
              </button>

            </div>

            {/* 設定タブ（歯車・右端固定） */}
            <button
              onClick={() => setActiveTab('settings')}
              title="設定"
              style={{
                marginLeft: 'auto',
                padding: '10px 14px',
                background: 'none',
                border: 'none',
                borderBottomWidth: 2,
                borderBottomStyle: 'solid',
                borderBottomColor: activeTab === 'settings' ? theme.accent : 'transparent',
                color: activeTab === 'settings' ? theme.accent : theme.textSecondary,
                cursor: 'pointer',
                marginBottom: -1,
                display: 'flex',
                alignItems: 'center',
              }}
            >
              <Settings size={15} />
            </button>
          </div>


          {activeTab === 'subtitles' && (
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
                  <span style={{ marginLeft: 'auto', color: theme.textMuted }}>
                    step: {pipelineRun.step}
                  </span>
                )}
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
            {activeTab === 'subtitles' && (
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
              />
            )}
            {activeTab === 'dictionary' && <GlossaryTab onApplyAll={handleApplyGlossary} />}
            {activeTab === 'help' && <HelpTab />}
            {activeTab === 'report' && <ReportTab runs={pipelineHistory} />}
            {activeTab === 'settings' && <SettingsTab />}
          </div>
        </section>

      </main>
    </div>
  )
}
