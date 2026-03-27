import { useTheme } from '@/context/ThemeContext'
import { useLocale } from '@/context/LocaleContext'
import { useGlossary } from '@/context/GlossaryContext'

interface GlossaryTabProps {
  onApplyAll: () => { blocksUpdated: number; replacements: number }
}

export function GlossaryTab({ onApplyAll }: GlossaryTabProps) {
  const { theme } = useTheme()
  const { strings: t } = useLocale()
  const { glossary, setGlossary, extracted, setExtracted } = useGlossary()

  const btn: React.CSSProperties = {
    border: `1px solid ${theme.btnBorder}`,
    background: theme.btnBg,
    color: theme.btnText,
    borderRadius: 6,
    padding: '3px 10px',
    fontSize: 11,
    cursor: 'pointer',
    marginLeft: 'auto',
  }

  const toggleConfirmed = (i: number) => {
    setGlossary(prev => prev.map((g, idx) => idx === i ? { ...g, confirmed: !g.confirmed } : g))
  }

  const addToGlossary = (i: number) => {
    const term = extracted[i]
    setExtracted(prev => prev.filter((_, idx) => idx !== i))
    setGlossary(prev => [...prev, { en: term.en, ja: term.ja, desc: t.noDesc, source: term.source, sourceUrl: term.sourceUrl, confirmed: false }])
  }

  const sectionHeader = (text: string, color: string) => (
    <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.5px', padding: '4px 2px 8px', color }}>
      {text}
    </div>
  )

  const confirmedCount = glossary.filter(g => g.confirmed).length

  return (
    <div className="h-full overflow-y-auto" style={{ padding: 10 }}>

      {/* 用語辞書適応ボタン */}
      {confirmedCount > 0 && (
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
            確定済み用語 {confirmedCount} 件を全ブロックに適用
            <br />
            <span style={{ color: theme.textMuted }}>
              表記ゆれ（大文字・複数形）を正規化し、訳語漏れを検出します
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

      {glossary.map((g, i) => (
        <div key={g.en} style={{
          border: '1px solid',
          borderColor: g.confirmed ? theme.glossaryCardBorderConfirmed : theme.glossaryCardBorderDefault,
          borderRadius: 8,
          padding: '10px 12px',
          marginBottom: 8,
          background: g.confirmed ? theme.glossaryCardBgConfirmed : theme.glossaryCardBgDefault,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
            <span style={{ fontSize: 15, fontWeight: 700, color: theme.textPrimary }}>{g.ja}</span>
            <span style={{ color: theme.textSecondary, fontSize: 13 }}>→</span>
            <span style={{ fontSize: 15, fontWeight: 700, color: theme.glossaryEnTermColor }}>{g.en}</span>
            <span style={{
              fontSize: 11,
              padding: '2px 8px',
              borderRadius: 999,
              fontWeight: 700,
              marginLeft: 'auto',
              background: g.confirmed ? theme.glossaryBadgeConfirmedBg : theme.glossaryBadgeUnconfirmedBg,
              color: theme.glossaryBadgeText,
              whiteSpace: 'nowrap',
            }}>
              {g.confirmed ? t.confirmed : t.unconfirmed}
            </span>
          </div>
          <div style={{ fontSize: 12, color: theme.textSecondary, lineHeight: 1.5, marginBottom: 6 }}>{g.desc}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            {g.sourceUrl
              ? <a href={g.sourceUrl} target="_blank" rel="noreferrer" style={{ fontSize: 11, color: theme.glossaryLinkColor }}>{t.source} {g.source}</a>
              : <span style={{ fontSize: 11, color: theme.textSecondary }}>{t.source} {g.source}</span>
            }
            <button
              onClick={() => toggleConfirmed(i)}
              style={{
                ...btn,
                background: g.confirmed ? theme.glossaryCardBgConfirmed : theme.btnBg,
                borderColor: g.confirmed ? theme.glossaryCardBorderConfirmed : theme.btnBorder,
              }}
            >
              {g.confirmed ? t.confirmedBtn : t.requestConfirmation}
            </button>
          </div>
        </div>
      ))}

      {sectionHeader(t.unregisteredTerms(extracted.length), theme.glossaryUnregisteredBadgeBg)}

      {extracted.map((term, i) => (
        <div key={term.en} style={{
          border: `1px dashed ${theme.glossaryUnregisteredBorder}`,
          borderRadius: 8,
          padding: '10px 12px',
          marginBottom: 8,
          background: theme.glossaryUnregisteredBg,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
            <span style={{ fontSize: 15, fontWeight: 700, color: theme.textPrimary }}>{term.ja}</span>
            <span style={{ color: theme.textSecondary, fontSize: 13 }}>→</span>
            <span style={{ fontSize: 15, fontWeight: 700, color: theme.glossaryEnTermColor }}>{term.en}</span>
            <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 999, fontWeight: 700, marginLeft: 'auto', background: theme.glossaryUnregisteredBadgeBg, color: '#fff', whiteSpace: 'nowrap' }}>
              {t.unregistered}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            {term.sourceUrl
              ? <a href={term.sourceUrl} target="_blank" rel="noreferrer" style={{ fontSize: 11, color: theme.glossaryLinkColor }}>{t.source} {term.source}</a>
              : <span style={{ fontSize: 11, color: theme.textSecondary }}>{t.source} {term.source}</span>
            }
            <button onClick={() => addToGlossary(i)} style={{ ...btn, borderColor: theme.glossaryUnregisteredBorder }}>
              {t.addToDictionary}
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}
