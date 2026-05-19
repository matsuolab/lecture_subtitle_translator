import { useRef, useState, useCallback, type Dispatch, type SetStateAction } from 'react'
import { FileText, Upload, Download, Trash2, Sparkles } from 'lucide-react'
import { useTheme } from '@/context/ThemeContext'
import { useLocale } from '@/context/LocaleContext'
import { useGlossary, type SelfMadeGlossaryEntry } from '@/context/GlossaryContext'
import { useToast } from '@/context/ToastContext'
import { parseGlossaryCsv, exportGlossaryCsv } from '@/lib/glossary/csvParser'
import { generateSelfMadeGlossaryFromPdf, type GlossaryGenerationProgressEvent } from '@/lib/glossary/documentGlossaryGenerator'
import { extractPdfDocument } from '@/lib/glossary/pdfExtractor'
import { convertMatsuoLabXlsx } from '@/lib/glossary/xlsxConverter'
import { describeError } from '@/lib/describeError'
import type { AdminSettings } from '@/types/adminSettings'

interface GlossaryTabProps {
  onApplyAll: () => { blocksUpdated: number; replacements: number }
  adminSettings: AdminSettings
  onAdminSettingsChange: (patch: Partial<AdminSettings>) => void
  generationLog: string[]
  setGenerationLog: Dispatch<SetStateAction<string[]>>
  isGenerating: boolean
  setIsGenerating: Dispatch<SetStateAction<boolean>>
}

type PendingDeleteTarget = 'formal' | 'self-made'

export function GlossaryTab({
  onApplyAll,
  adminSettings,
  onAdminSettingsChange,
  generationLog,
  setGenerationLog,
  isGenerating,
  setIsGenerating,
}: GlossaryTabProps) {
  const { theme } = useTheme()
  const { strings: t } = useLocale()
  const toast = useToast()
  const {
    glossary,
    setGlossary,
    extracted,
    setExtracted,
    selfMadeGlossary,
    importEntries,
    importSelfMadeEntries,
    importGlossaryIntoSelfMade,
    updateSelfMadeEntry,
    promoteSelfMadeEntry,
    clearGlossary,
    clearSelfMadeGlossary,
  } = useGlossary()

  const importRef = useRef<HTMLInputElement>(null)
  const createRef = useRef<HTMLInputElement>(null)
  const [isDragOver, setIsDragOver] = useState(false)
  const [isImporting, setIsImporting] = useState(false)
  const [importMsg, setImportMsg] = useState<string | null>(null)
  const [selfMadeFilter, setSelfMadeFilter] = useState<'active' | 'formal' | 'assistive' | 'term' | 'proper_noun' | 'formula' | 'abbreviation' | 'reference' | 'disabled' | 'all'>('active')
  const [pendingDelete, setPendingDelete] = useState<PendingDeleteTarget | null>(null)
  const isBusy = isImporting || isGenerating

  const selfMadeFilterOptions: Array<{ value: typeof selfMadeFilter; label: string }> = [
    { value: 'active', label: '有効' },
    { value: 'formal', label: '正式候補' },
    { value: 'assistive', label: '補正用' },
    { value: 'term', label: '専門用語' },
    { value: 'proper_noun', label: '固有名詞' },
    { value: 'formula', label: '数式' },
    { value: 'abbreviation', label: '略語' },
    { value: 'reference', label: '参照/URL' },
    { value: 'disabled', label: '無効' },
    { value: 'all', label: 'すべて' },
  ]

  const filteredSelfMadeGlossary = selfMadeGlossary.filter(entry => {
    if (selfMadeFilter === 'all') return true
    if (selfMadeFilter === 'active') return !entry.disabled && entry.category !== 'reference'
    if (selfMadeFilter === 'formal') return !entry.disabled && entry.formalEligible
    if (selfMadeFilter === 'assistive') return !entry.disabled && entry.assistiveEligible && !entry.formalEligible
    if (selfMadeFilter === 'term') return !entry.disabled && entry.category === 'term'
    if (selfMadeFilter === 'proper_noun') return !entry.disabled && entry.category === 'proper_noun'
    if (selfMadeFilter === 'formula') return !entry.disabled && entry.category === 'formula'
    if (selfMadeFilter === 'abbreviation') return !entry.disabled && entry.category === 'abbreviation'
    if (selfMadeFilter === 'reference') return entry.category === 'reference'
    if (selfMadeFilter === 'disabled') return entry.disabled
    return true
  })

  const showMsg = (msg: string) => {
    setImportMsg(msg)
    setTimeout(() => setImportMsg(null), 3000)
  }

  const executePendingDelete = useCallback(() => {
    if (isBusy || !pendingDelete) return
    if (pendingDelete === 'formal') {
      clearGlossary()
      showMsg('用語辞書を削除しました')
    } else {
      clearSelfMadeGlossary()
      showMsg('自作辞書を削除しました')
    }
    setPendingDelete(null)
  }, [clearGlossary, clearSelfMadeGlossary, isBusy, pendingDelete])

  const appendGenerationLog = useCallback((event: GlossaryGenerationProgressEvent | string) => {
    const text = typeof event === 'string' ? event : event.message
    const stamp = new Date().toLocaleTimeString()
    setGenerationLog(prev => [`${stamp} ${text}`, ...prev].slice(0, 80))
  }, [setGenerationLog])

  const processFile = useCallback(async (file: File) => {
    if (isBusy) return
    const name = file.name.toLowerCase()
    setIsImporting(true)
    // 「固まっている」印象を減らすため、先に UI を1フレーム描画
    await new Promise<void>(resolve => {
      requestAnimationFrame(() => resolve())
    })
    try {
      if (name.endsWith('.csv') || name.endsWith('.txt')) {
        const entries = parseGlossaryCsv(await file.text())
        const { added, updated } = importEntries(entries)
        showMsg(`インポート完了: ${added} 件追加、${updated} 件更新`)
        toast.success('importGlossary', { added, updated })
      } else if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
        const entries = await convertMatsuoLabXlsx(file)
        const { added, updated } = importEntries(entries)
        showMsg(`XLSX インポート完了: ${added} 件追加、${updated} 件更新`)
        toast.success('importGlossary', { added, updated })
      } else if (name.endsWith('.pdf')) {
        setGenerationLog([])
        const document = await extractPdfDocument(file, { renderPageImages: adminSettings.pdfExtractionUseVision })
        appendGenerationLog(`PDF extracted: ${document.pages.length} pages, vision=${adminSettings.pdfExtractionUseVision ? 'on' : 'off'}`)
        let addedTotal = 0
        let updatedTotal = 0
        await generateSelfMadeGlossaryFromPdf(adminSettings, document, {
          onProgress: appendGenerationLog,
          onEntries: entries => {
            const { added, updated } = importSelfMadeEntries(entries)
            addedTotal += added
            updatedTotal += updated
            appendGenerationLog(`saved batch: ${added} added, ${updated} updated`)
          },
        })
        const added = addedTotal
        const updated = updatedTotal
        showMsg(`自作辞書を作成しました: ${added} 件追加、${updated} 件更新`)
        setGenerationLog([])
        toast.success('importGlossary', { added, updated })
      } else {
        showMsg('非対応形式です（CSV / XLSX / PDF を使用してください）')
        toast.error('unsupportedGlossaryFile')
      }
    } catch (err) {
      const error = describeError(err)
      showMsg(`読み込みエラー: ${error}`)
      toast.error('glossaryImportError', { error })
    } finally {
      setIsImporting(false)
    }
  }, [adminSettings, appendGenerationLog, importEntries, importSelfMadeEntries, isBusy, setGenerationLog, toast])

  const createFromPdf = useCallback(async (file: File) => {
    if (isBusy) return
    setIsGenerating(true)
    await new Promise<void>(resolve => {
      requestAnimationFrame(() => resolve())
    })
    try {
      setGenerationLog([])
      const document = await extractPdfDocument(file, { renderPageImages: adminSettings.pdfExtractionUseVision })
      appendGenerationLog(`PDF extracted: ${document.pages.length} pages, vision=${adminSettings.pdfExtractionUseVision ? 'on' : 'off'}`)
      let addedTotal = 0
      let updatedTotal = 0
      await generateSelfMadeGlossaryFromPdf(adminSettings, document, {
        onProgress: appendGenerationLog,
        onEntries: entries => {
          const { added, updated } = importSelfMadeEntries(entries)
          addedTotal += added
          updatedTotal += updated
          appendGenerationLog(`saved batch: ${added} added, ${updated} updated`)
        },
      })
      showMsg(`PDFから自作辞書を作成しました: ${addedTotal} 件追加、${updatedTotal} 件更新`)
      setGenerationLog([])
      toast.success('importGlossary', { added: addedTotal, updated: updatedTotal })
    } catch (err) {
      const error = describeError(err)
      appendGenerationLog(`ERROR: ${error}`)
      showMsg(`辞書作成エラー: ${error}`)
      toast.error('glossaryImportError', { error })
    } finally {
      setIsGenerating(false)
    }
  }, [adminSettings, appendGenerationLog, importSelfMadeEntries, isBusy, setGenerationLog, setIsGenerating, toast])

  const handleFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) await processFile(file)
    e.target.value = ''
  }, [processFile])

  const handleCreateFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) await createFromPdf(file)
    e.target.value = ''
  }, [createFromPdf])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    if (e.dataTransfer.types.includes('Files')) setIsDragOver(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node)) return
    setIsDragOver(false)
  }, [])

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(false)
    const file = e.dataTransfer.files[0]
    if (file) await processFile(file)
  }, [processFile])

  const handleExport = useCallback(() => {
    const csv = exportGlossaryCsv(glossary)
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'glossary.csv'
    a.click()
    URL.revokeObjectURL(url)
    toast.success('exportCsv')
  }, [glossary, toast])

  const handleExportSelfMadeConfirmed = useCallback(() => {
    if (isBusy) return
    const entries = selfMadeGlossary
      .filter(entry => entry.formalEligible && entry.jaConfirmed && entry.enConfirmed && entry.ja.trim() && entry.en.trim() && !entry.disabled)
      .map(entry => ({
        id: entry.id,
        ja: entry.ja,
        en: entry.en,
        abbr: entry.abbr,
        domain: entry.domain,
        note: entry.note,
        desc: entry.desc,
        source: entry.source.name,
        sourceUrl: entry.children.find(child => child.url)?.url ?? null,
        confirmed: true,
      }))
    const csv = exportGlossaryCsv(entries)
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'self-made-glossary-confirmed.csv'
    a.click()
    URL.revokeObjectURL(url)
    toast.success('exportCsv')
  }, [isBusy, selfMadeGlossary, toast])

  const handleExportSelfMadeAll = useCallback(() => {
    if (isBusy) return
    const blob = new Blob([JSON.stringify(selfMadeGlossary, null, 2)], { type: 'application/json;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'self-made-glossary.json'
    a.click()
    URL.revokeObjectURL(url)
    toast.success('exportJson')
  }, [isBusy, selfMadeGlossary, toast])

  const handleToggleConfirmed = useCallback((entry: SelfMadeGlossaryEntry, field: 'jaConfirmed' | 'enConfirmed') => {
    if (isBusy) return
    const nextValue = !entry[field]
    const nextJaConfirmed = field === 'jaConfirmed' ? nextValue : entry.jaConfirmed
    const nextEnConfirmed = field === 'enConfirmed' ? nextValue : entry.enConfirmed
    updateSelfMadeEntry(entry.id, {
      [field]: nextValue,
      provisional: !(nextJaConfirmed && nextEnConfirmed),
    })
    if (nextJaConfirmed && nextEnConfirmed && entry.ja.trim() && entry.en.trim()) {
      setTimeout(() => {
        const result = promoteSelfMadeEntry(entry.id)
        if (result.promoted) showMsg('日英確認済みのため正式辞書へ昇格しました')
      }, 0)
    }
  }, [isBusy, promoteSelfMadeEntry, updateSelfMadeEntry])

  const primarySourceLabel = (entry: SelfMadeGlossaryEntry) => {
    const page = entry.children.find(child => child.page)?.page
    return page ? `${entry.source.name} p.${page}` : entry.source.name
  }

  const categoryLabel = (entry: SelfMadeGlossaryEntry) => {
    switch (entry.category) {
      case 'term': return '専門用語'
      case 'proper_noun': return '固有名詞'
      case 'formula': return '数式'
      case 'abbreviation': return '略語'
      case 'reference': return '参照/URL'
      default: return '候補'
    }
  }

  const sourceLabel = (source: SelfMadeGlossaryEntry['jaSource'] | SelfMadeGlossaryEntry['enSource']) => {
    switch (source) {
      case 'document': return 'PDF'
      case 'vision': return 'Vision'
      case 'llm_inferred': return 'LLM推定'
      case 'llm_translation': return 'LLM翻訳'
      case 'manual': return '手動'
      case 'missing': return '未取得'
      default: return '不明'
    }
  }

  const addToGlossary = (i: number) => {
    const term = extracted[i]
    setExtracted(prev => prev.filter((_, idx) => idx !== i))
    setGlossary(prev => [...prev, {
      id: crypto.randomUUID(),
      en: term.en,
      ja: term.ja,
      source: term.source,
      sourceUrl: term.sourceUrl,
      confirmed: true,
    }])
  }

  const sectionHeader = (text: string, color: string) => (
    <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.5px', padding: '4px 2px 8px', color }}>
      {text}
    </div>
  )

  return (
    <div
      className="h-full overflow-y-auto"
      style={{ padding: 10, position: 'relative' }}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* ドラッグオーバーレイ */}
      {isDragOver && (
        <div style={{
          position: 'absolute', inset: 0, zIndex: 50,
          background: 'rgba(99,102,241,0.13)',
          border: '2px dashed rgba(99,102,241,0.7)',
          borderRadius: 8,
          display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center',
          gap: 8, pointerEvents: 'none',
        }}>
          <Upload size={32} color="rgba(99,102,241,0.85)" strokeWidth={1.5} />
          <span style={{ color: 'rgba(99,102,241,0.9)', fontSize: 13, fontWeight: 600 }}>
            CSV / XLSX / PDF をドロップして読み込み
          </span>
        </div>
      )}

      {/* インポート通知 */}
      {importMsg && (
        <div style={{
          position: 'sticky', top: 0, zIndex: 10,
          background: theme.cardBgActive,
          border: `1px solid ${theme.accent}44`,
          borderRadius: 6, padding: '7px 12px',
          fontSize: 11, color: theme.textPrimary,
          marginBottom: 10,
        }}>
          {importMsg}
        </div>
      )}

      {/* ツールバー */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
        <input
          ref={importRef}
          type="file"
          accept=".csv,.txt,.xlsx,.xls"
          onChange={handleFileChange}
          style={{ display: 'none' }}
        />
        <input
          ref={createRef}
          type="file"
          accept=".pdf,application/pdf"
          onChange={handleCreateFileChange}
          style={{ display: 'none' }}
        />
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <button
            onClick={() => importRef.current?.click()}
            disabled={isBusy}
            title="CSV / XLSX をインポート"
            style={{
              display: 'flex', alignItems: 'center', gap: 5,
              border: `1px solid ${theme.btnBorder}`,
              background: theme.btnBg, color: theme.btnText,
              borderRadius: 6, padding: '5px 10px',
              fontSize: 11, cursor: isBusy ? 'not-allowed' : 'pointer',
              opacity: isBusy ? 0.65 : 1,
              whiteSpace: 'nowrap',
              flexShrink: 0,
              lineHeight: 1,
            }}
          >
            <Upload size={11} style={{ flexShrink: 0 }} />
            {isImporting ? '読み込み中...' : 'インポート'}
          </button>
          <button
            onClick={handleExport}
            disabled={glossary.length === 0}
            title="CSV としてエクスポート"
            style={{
              display: 'flex', alignItems: 'center', gap: 5,
              border: `1px solid ${theme.btnBorder}`,
              background: theme.btnBg,
              color: glossary.length > 0 ? theme.btnText : theme.textDisabled,
              borderRadius: 6, padding: '5px 10px',
              fontSize: 11, cursor: glossary.length > 0 ? 'pointer' : 'not-allowed',
              whiteSpace: 'nowrap',
              flexShrink: 0,
              lineHeight: 1,
            }}
          >
            <Download size={11} style={{ flexShrink: 0 }} />
            エクスポート
          </button>
          <span style={{ fontSize: 11, color: theme.textMuted, marginLeft: 'auto', whiteSpace: 'nowrap', flexShrink: 0 }}>
            {isBusy ? '用語集を処理中です...' : 'CSV・XLSX・PDFをD&Dでも読み込めます'}
          </span>
          <button
            onClick={() => {
              if (isBusy) return
              setPendingDelete('formal')
            }}
            disabled={glossary.length === 0 || isBusy}
            title="全件削除"
            style={{
              display: 'flex', alignItems: 'center', gap: 4,
              border: `1px solid ${theme.btnBorder}`,
              background: 'none',
              color: glossary.length > 0 && !isBusy ? theme.textSecondary : theme.textDisabled,
              borderRadius: 6, padding: '5px 8px',
              fontSize: 11, cursor: glossary.length > 0 && !isBusy ? 'pointer' : 'not-allowed',
              flexShrink: 0,
              lineHeight: 1,
            }}
          >
            <Trash2 size={11} style={{ flexShrink: 0 }} />
          </button>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', paddingTop: 2 }}>
          <button
            onClick={() => createRef.current?.click()}
            disabled={isBusy}
            title="PDFから自作辞書を作成"
            style={{
              display: 'flex', alignItems: 'center', gap: 5,
              border: `1px solid ${theme.accent}`,
              background: theme.accent,
              color: '#fff',
              borderRadius: 6, padding: '5px 10px',
              fontSize: 11,
              fontWeight: 700,
              cursor: isBusy ? 'not-allowed' : 'pointer',
              opacity: isBusy ? 0.65 : 1,
              whiteSpace: 'nowrap',
              flexShrink: 0,
              lineHeight: 1,
            }}
          >
            <Sparkles size={11} style={{ flexShrink: 0 }} />
            {isGenerating ? '作成中...' : '辞書作成'}
          </button>
          <label
            title="ページ画像もVision対応LLMへ送って、数式・図表・画像化文字の抽出精度を上げる"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 5,
              fontSize: 11,
              color: theme.textSecondary,
              whiteSpace: 'nowrap',
              cursor: isBusy ? 'not-allowed' : 'pointer',
              flexShrink: 0,
            }}
          >
            <input
              type="checkbox"
              checked={adminSettings.pdfExtractionUseVision}
              disabled={isBusy}
              onChange={(e) => onAdminSettingsChange({ pdfExtractionUseVision: e.target.checked })}
            />
            Vision LLM
          </label>
          <label
            title="PDF辞書作成のLLM処理をページ単位で並列実行します。ローカルLLMで不安定な場合はOFFにしてください"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 5,
              fontSize: 11,
              color: theme.textSecondary,
              whiteSpace: 'nowrap',
              cursor: isBusy ? 'not-allowed' : 'pointer',
              flexShrink: 0,
            }}
          >
            <input
              type="checkbox"
              checked={adminSettings.pdfExtractionParallel}
              disabled={isBusy}
              onChange={(e) => onAdminSettingsChange({ pdfExtractionParallel: e.target.checked })}
            />
            並列化
          </label>
        </div>
      </div>

      {/* 全ブロック適用ボタン */}
      {glossary.length > 0 && (
        <div style={{
          marginBottom: 12,
          padding: '10px 12px',
          borderRadius: 8,
          border: `1px solid ${theme.accent}33`,
          background: theme.cardBgActive,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
        }}>
          <div style={{ flex: 1, fontSize: 11, color: theme.textSecondary, lineHeight: 1.5 }}>
            用語 {glossary.length} 件を全ブロックに適用
            <br />
            <span style={{ color: theme.textMuted }}>
              表記ゆれ（大文字・複数形）を正規化します
            </span>
          </div>
          <button
            onClick={() => {
              const result = onApplyAll()
              if (result.replacements === 0) {
                alert('修正が必要な表記ゆれは見つかりませんでした')
              } else {
                alert(`${result.blocksUpdated} ブロックを更新、${result.replacements} 件修正しました（Ctrl+Z で元に戻せます）`)
              }
            }}
            style={{
              border: `1px solid ${theme.accent}`,
              background: theme.accent,
              color: '#fff',
              borderRadius: 6,
              padding: '6px 14px',
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            全ブロックに適用
          </button>
        </div>
      )}

      {(generationLog.length > 0 || isBusy) && (
        <div style={{
          marginBottom: 12,
          padding: '10px 12px',
          borderRadius: 8,
          border: `1px solid ${theme.panelBorder}`,
          background: theme.cardBg,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: theme.textSecondary }}>辞書作成ログ</span>
            {isBusy && <span style={{ fontSize: 11, color: theme.textMuted }}>処理中...</span>}
            <button
              type="button"
              onClick={() => setGenerationLog([])}
              disabled={isBusy}
              style={{
                marginLeft: 'auto',
                border: `1px solid ${theme.btnBorder}`,
                background: 'none',
                color: isBusy ? theme.textDisabled : theme.textSecondary,
                borderRadius: 6,
                padding: '2px 8px',
                fontSize: 11,
                cursor: isBusy ? 'not-allowed' : 'pointer',
              }}
            >
              クリア
            </button>
          </div>
          <div style={{
            maxHeight: 160,
            overflowY: 'auto',
            fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
            fontSize: 10,
            lineHeight: 1.5,
            color: theme.textSecondary,
            whiteSpace: 'pre-wrap',
          }}>
            {generationLog.length > 0 ? generationLog.join('\n') : 'ログ待機中'}
          </div>
        </div>
      )}

      {sectionHeader(`自作辞書 (${filteredSelfMadeGlossary.length}/${selfMadeGlossary.length})`, theme.textSecondary)}

      <div style={{
        marginBottom: 12,
        padding: '10px 12px',
        borderRadius: 8,
        border: `1px solid ${theme.panelBorder}`,
        background: theme.cardBg,
        display: 'flex',
        gap: 8,
        alignItems: 'center',
        flexWrap: 'wrap',
      }}>
        <button
          onClick={() => {
            if (isBusy) return
            const { added, updated } = importGlossaryIntoSelfMade()
            showMsg(`正式辞書を自作辞書へ取り込みました: ${added} 件追加、${updated} 件更新`)
          }}
          disabled={glossary.length === 0 || isBusy}
          title="正式辞書の内容を自作辞書へ作業用データとして取り込む"
          style={{
            display: 'flex', alignItems: 'center', gap: 5,
            border: `1px solid ${theme.btnBorder}`,
            background: theme.btnBg,
            color: glossary.length > 0 && !isBusy ? theme.btnText : theme.textDisabled,
            borderRadius: 6,
            padding: '5px 10px',
            fontSize: 11,
            cursor: glossary.length > 0 && !isBusy ? 'pointer' : 'not-allowed',
          }}
        >
          <FileText size={11} />
          正式辞書を取り込む
        </button>
        <button
          onClick={handleExportSelfMadeConfirmed}
          disabled={selfMadeGlossary.length === 0 || isBusy}
          title="日英両方が確認済みの自作辞書だけCSV出力"
          style={{
            display: 'flex', alignItems: 'center', gap: 5,
            border: `1px solid ${theme.btnBorder}`,
            background: theme.btnBg,
            color: selfMadeGlossary.length > 0 && !isBusy ? theme.btnText : theme.textDisabled,
            borderRadius: 6,
            padding: '5px 10px',
            fontSize: 11,
            cursor: selfMadeGlossary.length > 0 && !isBusy ? 'pointer' : 'not-allowed',
          }}
        >
          <Download size={11} />
          確認済みCSV
        </button>
        <button
          onClick={handleExportSelfMadeAll}
          disabled={selfMadeGlossary.length === 0 || isBusy}
          title="自作辞書全体をJSON出力"
          style={{
            display: 'flex', alignItems: 'center', gap: 5,
            border: `1px solid ${theme.btnBorder}`,
            background: theme.btnBg,
            color: selfMadeGlossary.length > 0 && !isBusy ? theme.btnText : theme.textDisabled,
            borderRadius: 6,
            padding: '5px 10px',
            fontSize: 11,
            cursor: selfMadeGlossary.length > 0 && !isBusy ? 'pointer' : 'not-allowed',
          }}
        >
          <Download size={11} />
          全体JSON
        </button>
        <button
          onClick={() => {
            if (isBusy) return
            setPendingDelete('self-made')
          }}
          disabled={selfMadeGlossary.length === 0 || isBusy}
          title="自作辞書を全件削除"
          style={{
            display: 'flex', alignItems: 'center', gap: 4,
            border: `1px solid ${theme.btnBorder}`,
            background: 'none',
            color: selfMadeGlossary.length > 0 && !isBusy ? theme.textSecondary : theme.textDisabled,
            borderRadius: 6,
            padding: '5px 8px',
            fontSize: 11,
            cursor: selfMadeGlossary.length > 0 && !isBusy ? 'pointer' : 'not-allowed',
            marginLeft: 'auto',
          }}
        >
          <Trash2 size={11} />
        </button>
      </div>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
        {selfMadeFilterOptions.map(option => (
          <button
            key={option.value}
            type="button"
            onClick={() => setSelfMadeFilter(option.value)}
            style={{
              border: `1px solid ${selfMadeFilter === option.value ? theme.accent : theme.btnBorder}`,
              background: selfMadeFilter === option.value ? theme.cardBgActive : theme.btnBg,
              color: selfMadeFilter === option.value ? theme.accent : theme.btnText,
              borderRadius: 6,
              padding: '4px 8px',
              fontSize: 11,
              cursor: 'pointer',
            }}
          >
            {option.label}
          </button>
        ))}
      </div>

      {selfMadeGlossary.length === 0 && (
        <div style={{
          textAlign: 'center', padding: '18px 16px', marginBottom: 12,
          fontSize: 12, color: theme.textMuted, lineHeight: 1.8,
          border: `1px dashed ${theme.panelBorder}`,
          borderRadius: 8,
        }}>
          自作辞書は空です。PDFから辞書作成すると候補が追加されます。
        </div>
      )}

      {filteredSelfMadeGlossary.map((entry) => (
        <div key={entry.id} style={{
          border: `1px solid ${entry.disabled ? theme.panelBorder : theme.glossaryUnregisteredBorder}`,
          borderRadius: 8,
          padding: '10px 12px',
          marginBottom: 8,
          background: entry.disabled ? theme.cardBg : theme.glossaryUnregisteredBg,
          opacity: entry.disabled ? 0.65 : 1,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11, color: entry.formalEligible ? theme.savedColor : theme.textMuted, border: `1px solid ${theme.panelBorder}`, borderRadius: 4, padding: '1px 5px' }}>
              {categoryLabel(entry)}
            </span>
            <span style={{ fontSize: 15, fontWeight: 700, color: theme.textPrimary }}>
              {entry.ja || entry.displayText || entry.formula || '(日本語未設定)'}
            </span>
            <span style={{ fontSize: 10, color: theme.textMuted }}>[{sourceLabel(entry.jaSource)}]</span>
            <span style={{ color: theme.textSecondary, fontSize: 13 }}>→</span>
            <span style={{ fontSize: 15, fontWeight: 700, color: theme.glossaryEnTermColor }}>
              {entry.en || entry.spokenEn || '(英語未設定)'}
            </span>
            <span style={{ fontSize: 10, color: theme.textMuted }}>[{sourceLabel(entry.enSource)}]</span>
            {entry.abbr && (
              <span style={{ fontSize: 11, color: theme.textMuted }}>({entry.abbr})</span>
            )}
          </div>
          {(entry.desc || entry.note || entry.latex) && (
            <div style={{ fontSize: 12, color: theme.textSecondary, lineHeight: 1.5, marginTop: 6 }}>
              {entry.desc || entry.note || entry.latex}
            </div>
          )}
          {entry.reviewReason && (
            <div style={{ fontSize: 11, color: theme.textMuted, lineHeight: 1.5, marginTop: 4 }}>
              {entry.reviewReason}
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
            <span style={{ fontSize: 11, color: theme.textSecondary }}>{t.source} {primarySourceLabel(entry)}</span>
            {!entry.formalEligible && (
              <span style={{ fontSize: 11, color: theme.textMuted }}>正式辞書対象外</span>
            )}
            {entry.assistiveEligible && (
              <span style={{ fontSize: 11, color: theme.textMuted }}>補正利用候補</span>
            )}
            {entry.origin === 'formal_import' && (
              <span style={{ fontSize: 11, color: theme.textMuted }}>正式辞書由来</span>
            )}
            {entry.promoted && (
              <span style={{ fontSize: 11, color: theme.savedColor }}>正式辞書へ昇格済み</span>
            )}
            <button
              onClick={() => handleToggleConfirmed(entry, 'jaConfirmed')}
              disabled={isBusy}
              style={{
                marginLeft: 'auto',
                border: `1px solid ${entry.jaConfirmed ? theme.accent : theme.btnBorder}`,
                background: entry.jaConfirmed ? theme.cardBgActive : theme.btnBg,
                color: entry.jaConfirmed ? theme.accent : theme.btnText,
                borderRadius: 6,
                padding: '3px 8px',
                fontSize: 11,
                cursor: isBusy ? 'not-allowed' : 'pointer',
              }}
            >
              日{entry.jaConfirmed ? '確認済み' : '未確認'}
            </button>
            <button
              onClick={() => handleToggleConfirmed(entry, 'enConfirmed')}
              disabled={isBusy}
              style={{
                border: `1px solid ${entry.enConfirmed ? theme.accent : theme.btnBorder}`,
                background: entry.enConfirmed ? theme.cardBgActive : theme.btnBg,
                color: entry.enConfirmed ? theme.accent : theme.btnText,
                borderRadius: 6,
                padding: '3px 8px',
                fontSize: 11,
                cursor: isBusy ? 'not-allowed' : 'pointer',
              }}
            >
              英{entry.enConfirmed ? '確認済み' : '未確認'}
            </button>
            <button
              onClick={() => {
                if (!isBusy) updateSelfMadeEntry(entry.id, { disabled: !entry.disabled })
              }}
              disabled={isBusy}
              style={{
                border: `1px solid ${theme.btnBorder}`,
                background: 'none',
                color: theme.textSecondary,
                borderRadius: 6,
                padding: '3px 8px',
                fontSize: 11,
                cursor: isBusy ? 'not-allowed' : 'pointer',
              }}
            >
              {entry.disabled ? '有効化' : '無効化'}
            </button>
          </div>
        </div>
      ))}

      {sectionHeader(t.registeredTerms(glossary.length), theme.textSecondary)}

      {glossary.length === 0 && (
        <div style={{
          textAlign: 'center', padding: '24px 16px',
          fontSize: 12, color: theme.textMuted, lineHeight: 1.8,
        }}>
          用語辞書が空です。<br />
          CSVまたはXLSXファイルをドロップしてインポートしてください。
        </div>
      )}

      {glossary.map((g) => (
        <div key={g.id} style={{
          border: `1px solid ${theme.glossaryCardBorderDefault}`,
          borderRadius: 8,
          padding: '10px 12px',
          marginBottom: 8,
          background: theme.glossaryCardBgDefault,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: g.desc ? 6 : 0, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 15, fontWeight: 700, color: theme.textPrimary }}>{g.ja}</span>
            <span style={{ color: theme.textSecondary, fontSize: 13 }}>→</span>
            <span style={{ fontSize: 15, fontWeight: 700, color: theme.glossaryEnTermColor }}>{g.en}</span>
            {g.abbr && (
              <span style={{
                fontSize: 11, padding: '1px 6px', borderRadius: 4,
                background: theme.videoBtnBg, color: theme.textSecondary,
                border: `1px solid ${theme.panelBorder}`,
              }}>
                {g.abbr}
              </span>
            )}
            {g.domain && (
              <span style={{ fontSize: 11, color: theme.textMuted, marginLeft: 'auto' }}>#{g.domain}</span>
            )}
          </div>
          {g.desc && (
            <div style={{ fontSize: 12, color: theme.textSecondary, lineHeight: 1.5, marginTop: 4 }}>{g.desc}</div>
          )}
          {g.source && (
            <div style={{ marginTop: 6 }}>
              {g.sourceUrl
                ? <a href={g.sourceUrl} target="_blank" rel="noreferrer" style={{ fontSize: 11, color: theme.glossaryLinkColor }}>{t.source} {g.source}</a>
                : <span style={{ fontSize: 11, color: theme.textSecondary }}>{t.source} {g.source}</span>
              }
            </div>
          )}
        </div>
      ))}

      {/* 自動抽出候補（将来機能・現在はモックデータ表示） */}
      {extracted.length > 0 && (
        <>
          {sectionHeader(t.unregisteredTerms(extracted.length), theme.glossaryUnregisteredBadgeBg)}
          {extracted.map((term, i) => (
            <div key={term.en} style={{
              border: `1px dashed ${theme.glossaryUnregisteredBorder}`,
              borderRadius: 8,
              padding: '10px 12px',
              marginBottom: 8,
              background: theme.glossaryUnregisteredBg,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 15, fontWeight: 700, color: theme.textPrimary }}>{term.ja}</span>
                <span style={{ color: theme.textSecondary, fontSize: 13 }}>→</span>
                <span style={{ fontSize: 15, fontWeight: 700, color: theme.glossaryEnTermColor }}>{term.en}</span>
                <button
                  onClick={() => addToGlossary(i)}
                  style={{
                    marginLeft: 'auto',
                    border: `1px solid ${theme.glossaryUnregisteredBorder}`,
                    background: theme.btnBg, color: theme.btnText,
                    borderRadius: 6, padding: '3px 10px',
                    fontSize: 11, cursor: 'pointer',
                  }}
                >
                  {t.addToDictionary}
                </button>
              </div>
            </div>
          ))}
        </>
      )}

      {pendingDelete && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="glossary-delete-confirm-title"
          onClick={() => setPendingDelete(null)}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 2000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 16,
            background: 'rgba(0,0,0,0.45)',
          }}
        >
          <div
            onClick={event => event.stopPropagation()}
            style={{
              width: 'min(420px, 100%)',
              borderRadius: 8,
              border: `1px solid ${theme.panelBorder}`,
              background: theme.panelBg,
              color: theme.textPrimary,
              boxShadow: '0 18px 50px rgba(0,0,0,0.35)',
              padding: 18,
            }}
          >
            <div id="glossary-delete-confirm-title" style={{ fontSize: 15, fontWeight: 700, marginBottom: 8 }}>
              {pendingDelete === 'formal' ? '用語辞書を削除' : '自作辞書を削除'}
            </div>
            <div style={{ fontSize: 13, color: theme.textSecondary, lineHeight: 1.6, marginBottom: 16 }}>
              {pendingDelete === 'formal'
                ? `用語辞書を全件削除します。対象: ${glossary.length} 件`
                : `自作辞書を全件削除します。対象: ${selfMadeGlossary.length} 件`}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button
                type="button"
                onClick={() => setPendingDelete(null)}
                style={{
                  border: `1px solid ${theme.btnBorder}`,
                  background: theme.btnBg,
                  color: theme.btnText,
                  borderRadius: 6,
                  padding: '6px 12px',
                  fontSize: 12,
                  cursor: 'pointer',
                }}
              >
                キャンセル
              </button>
              <button
                type="button"
                onClick={executePendingDelete}
                style={{
                  border: '1px solid #dc2626',
                  background: '#dc2626',
                  color: '#fff',
                  borderRadius: 6,
                  padding: '6px 12px',
                  fontSize: 12,
                  fontWeight: 700,
                  cursor: 'pointer',
                }}
              >
                削除
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
