import { useRef, useState, useCallback } from 'react'
import { isTauri } from '@tauri-apps/api/core'
import { confirm as confirmDialog } from '@tauri-apps/plugin-dialog'
import { Upload, Download, Trash2 } from 'lucide-react'
import { useTheme } from '@/context/ThemeContext'
import { useLocale } from '@/context/LocaleContext'
import { useGlossary } from '@/context/GlossaryContext'
import { parseGlossaryCsv, exportGlossaryCsv } from '@/lib/glossary/csvParser'
import { convertMatsuoLabXlsx } from '@/lib/glossary/xlsxConverter'

interface GlossaryTabProps {
  onApplyAll: () => { blocksUpdated: number; replacements: number }
}

export function GlossaryTab({ onApplyAll }: GlossaryTabProps) {
  const { theme } = useTheme()
  const { strings: t } = useLocale()
  const { glossary, setGlossary, extracted, setExtracted, importEntries, clearGlossary } = useGlossary()

  const importRef = useRef<HTMLInputElement>(null)
  const [isDragOver, setIsDragOver] = useState(false)
  const [isImporting, setIsImporting] = useState(false)
  const [importMsg, setImportMsg] = useState<string | null>(null)

  const showMsg = (msg: string) => {
    setImportMsg(msg)
    setTimeout(() => setImportMsg(null), 3000)
  }

  const processFile = useCallback(async (file: File) => {
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
      } else if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
        const entries = await convertMatsuoLabXlsx(file)
        const { added, updated } = importEntries(entries)
        showMsg(`XLSX インポート完了: ${added} 件追加、${updated} 件更新`)
      } else {
        showMsg('非対応形式です（CSV または XLSX を使用してください）')
      }
    } catch (err) {
      showMsg(`読み込みエラー: ${err instanceof Error ? err.message : '不明なエラー'}`)
    } finally {
      setIsImporting(false)
    }
  }, [importEntries])

  const handleFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) await processFile(file)
    e.target.value = ''
  }, [processFile])

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
  }, [glossary])

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
            CSV / XLSX をドロップしてインポート
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
      <div style={{ display: 'flex', gap: 6, marginBottom: 12, alignItems: 'center' }}>
        <input
          ref={importRef}
          type="file"
          accept=".csv,.txt,.xlsx,.xls"
          onChange={handleFileChange}
          style={{ display: 'none' }}
        />
        <button
          onClick={() => importRef.current?.click()}
          disabled={isImporting}
          title="CSV / XLSX をインポート"
          style={{
            display: 'flex', alignItems: 'center', gap: 5,
            border: `1px solid ${theme.btnBorder}`,
            background: theme.btnBg, color: theme.btnText,
            borderRadius: 6, padding: '5px 10px',
            fontSize: 11, cursor: isImporting ? 'not-allowed' : 'pointer',
            opacity: isImporting ? 0.65 : 1,
          }}
        >
          <Upload size={11} />
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
          }}
        >
          <Download size={11} />
          エクスポート
        </button>
        <span style={{ fontSize: 11, color: theme.textMuted, marginLeft: 'auto' }}>
          {isImporting ? '用語集を取り込み中です...' : 'CSV・XLSXをD&Dでも読み込めます'}
        </span>
        <button
          onClick={async () => {
            const ok = isTauri()
              ? await confirmDialog(`用語辞書を全件削除しますか？（${glossary.length} 件）`, { title: '確認', kind: 'warning' })
              : window.confirm(`用語辞書を全件削除しますか？（${glossary.length} 件）`)
            if (ok) clearGlossary()
          }}
          disabled={glossary.length === 0}
          title="全件削除"
          style={{
            display: 'flex', alignItems: 'center', gap: 4,
            border: `1px solid ${theme.btnBorder}`,
            background: 'none',
            color: glossary.length > 0 ? theme.textSecondary : theme.textDisabled,
            borderRadius: 6, padding: '5px 8px',
            fontSize: 11, cursor: glossary.length > 0 ? 'pointer' : 'not-allowed',
          }}
        >
          <Trash2 size={11} />
        </button>
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
    </div>
  )
}
