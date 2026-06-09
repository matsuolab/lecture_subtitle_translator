import { useRef, useState } from 'react'
import { useTheme } from '@/context/ThemeContext'
import { useToast } from '@/context/ToastContext'
import type { AdminSettings } from '@/types/adminSettings'
import {
  userDictionariesAvailable, saveUserDictionary, removeUserDictionary,
} from '@/lib/pipeline/spellCheck/userDictionaryStore'

interface Props {
  adminSettings: AdminSettings
  onAdminSettingsChange: (patch: Partial<AdminSettings>) => void
}

/** 辞書タブ「一般用語」サブタブの本体：字幕スペル校正の設定＋一般用語辞書インポート */
export function GeneralDictionarySection({ adminSettings, onAdminSettingsChange }: Props) {
  const { theme } = useTheme()
  const toast = useToast()
  const affRef = useRef<HTMLInputElement>(null)
  const dicRef = useRef<HTMLInputElement>(null)
  const [label, setLabel] = useState('')
  const [affFile, setAffFile] = useState<File | null>(null)
  const [dicFile, setDicFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const canImport = userDictionariesAvailable()
  const imported = adminSettings.spellImportedDictionaryLabels

  const handleAdd = async () => {
    const name = label.trim()
    if (!name || !affFile || !dicFile) return
    setBusy(true)
    try {
      const [aff, dic] = await Promise.all([affFile.text(), dicFile.text()])
      await saveUserDictionary(name, aff, dic)
      if (!imported.some(l => l.toLowerCase() === name.toLowerCase())) {
        onAdminSettingsChange({ spellImportedDictionaryLabels: [...imported, name] })
      }
      setLabel(''); setAffFile(null); setDicFile(null)
      if (affRef.current) affRef.current.value = ''
      if (dicRef.current) dicRef.current.value = ''
      toast.success('spellWordAdded', { word: name })
    } catch (e) {
      toast.error('adminSettingsImportError', { error: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(false)
    }
  }

  const handleRemove = async (name: string) => {
    setBusy(true)
    try {
      await removeUserDictionary(name)
      onAdminSettingsChange({ spellImportedDictionaryLabels: imported.filter(l => l !== name) })
    } finally {
      setBusy(false)
    }
  }

  const cardStyle = { border: `1px solid ${theme.panelBorder}`, borderRadius: 8, padding: '10px 12px', display: 'flex', flexDirection: 'column' as const, gap: 8 }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* 字幕スペル校正の説明 */}
      <div style={cardStyle}>
        <div style={{ fontSize: 12, fontWeight: 700, color: theme.textPrimary }}>字幕スペル校正（Hunspell）</div>
        <div style={{ fontSize: 11, color: theme.textSecondary, lineHeight: 1.7 }}>
          字幕（英語など）の綴り誤りを <strong>Hunspell ベースのスペルチェッカー</strong>で検出します（承認時・編集確定時・出力時に<strong>自動チェック</strong>）。<br />
          <strong>英語辞書は内蔵</strong>しています。それ以外の言語は、下の「一般用語辞書インポート」から各自で辞書を準備して取り込んでください。<br />
          字幕言語に<strong>対応する辞書が無い場合・日本語などCJKの場合は、校正は自動的に行われません</strong>（オフになります）。<br />
          「専門用語」に登録された語、および誤検知時に「＋辞書」で登録した語は、スペル誤検出から除外されます。
        </div>
      </div>

      {/* 一般用語辞書インポート */}
      <div style={cardStyle}>
        <div style={{ fontSize: 12, fontWeight: 700, color: theme.textPrimary }}>一般用語辞書インポート</div>

        {!canImport && (
          <div style={{ fontSize: 11, color: theme.textSecondary }}>
            ※ 一般用語辞書インポートはデスクトップ版でのみ利用できます。
          </div>
        )}

        {canImport && (
          <>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              <input
                value={label}
                onChange={e => setLabel(e.target.value)}
                placeholder="言語ラベル（例: French）"
                style={{ flex: '1 1 160px', minWidth: 120, fontSize: 12, padding: '5px 8px', borderRadius: 6, border: `1px solid ${theme.btnBorder}`, background: theme.inputBg ?? theme.cardBg, color: theme.textPrimary }}
              />
              <input ref={affRef} type="file" accept=".aff" onChange={e => setAffFile(e.target.files?.[0] ?? null)} style={{ display: 'none' }} />
              <input ref={dicRef} type="file" accept=".dic" onChange={e => setDicFile(e.target.files?.[0] ?? null)} style={{ display: 'none' }} />
              <button onClick={() => affRef.current?.click()} style={btn(theme, !!affFile)}>{affFile ? `✓ ${affFile.name}` : '.aff 選択'}</button>
              <button onClick={() => dicRef.current?.click()} style={btn(theme, !!dicFile)}>{dicFile ? `✓ ${dicFile.name}` : '.dic 選択'}</button>
              <button
                onClick={handleAdd}
                disabled={busy || !label.trim() || !affFile || !dicFile}
                style={{ ...btn(theme, false), opacity: (busy || !label.trim() || !affFile || !dicFile) ? 0.5 : 1, fontWeight: 700 }}
              >
                追加
              </button>
            </div>

            {imported.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 2 }}>
                <div style={{ fontSize: 11, color: theme.textMuted, fontWeight: 600 }}>導入済み</div>
                {imported.map(name => (
                  <div key={name} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 12, color: theme.textPrimary, padding: '3px 0' }}>
                    <span>• {name}</span>
                    <button onClick={() => handleRemove(name)} disabled={busy} style={{ border: 'none', background: 'transparent', color: theme.textMuted, cursor: 'pointer', fontSize: 12 }} title="削除">削除</button>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function btn(theme: ReturnType<typeof useTheme>['theme'], active: boolean) {
  return {
    border: `1px solid ${active ? (theme.accent ?? theme.btnBorder) : theme.btnBorder}`,
    background: theme.btnBg, color: theme.btnText,
    borderRadius: 6, padding: '5px 10px', fontSize: 11, cursor: 'pointer', whiteSpace: 'nowrap' as const,
  }
}
