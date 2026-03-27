import { useState } from 'react'
import { useTheme } from '@/context/ThemeContext'
import { useLocale } from '@/context/LocaleContext'

type HelpSection = 'guide' | 'shortcuts'

function KeyBadge({ label }: { label: string }) {
  const { theme } = useTheme()
  const isClick = label.startsWith('クリック') || label.startsWith('ドラッグ') ||
                  label.startsWith('Click') || label.startsWith('Drag') ||
                  label.startsWith('点击') || label.startsWith('拖')
  if (isClick) {
    return (
      <span style={{ fontSize: 11, color: theme.textSecondary, fontStyle: 'italic' }}>{label}</span>
    )
  }
  return (
    <span style={{
      display: 'inline-block',
      padding: '1px 7px',
      borderRadius: 4,
      border: `1px solid ${theme.btnBorder}`,
      background: theme.btnBg,
      fontSize: 11,
      fontFamily: 'monospace',
      color: theme.btnText,
      lineHeight: '18px',
    }}>
      {label}
    </span>
  )
}

export function HelpTab() {
  const { theme } = useTheme()
  const { strings: t } = useLocale()
  const [section, setSection] = useState<HelpSection>('guide')

  const tabStyle = (active: boolean) => ({
    padding: '6px 14px',
    fontSize: 12,
    fontWeight: 600,
    borderRadius: 6,
    border: 'none',
    cursor: 'pointer',
    background: active ? theme.accent : 'transparent',
    color: active ? '#fff' : theme.textSecondary,
    transition: 'background 0.15s, color 0.15s',
  } as React.CSSProperties)

  return (
    <div className="h-full overflow-y-auto" style={{ padding: 14 }}>

      {/* セクション切り替えタブ */}
      <div style={{
        display: 'flex', gap: 4, marginBottom: 16,
        padding: 3, borderRadius: 8,
        background: theme.cardBg, border: `1px solid ${theme.panelBorder}`,
        width: 'fit-content',
      }}>
        <button style={tabStyle(section === 'guide')} onClick={() => setSection('guide')}>
          {t.id === 'ja' ? '使い方ガイド' : t.id === 'zh' ? '使用指南' : 'Guide'}
        </button>
        <button style={tabStyle(section === 'shortcuts')} onClick={() => setSection('shortcuts')}>
          {t.id === 'ja' ? 'キー操作' : t.id === 'zh' ? '快捷键' : 'Shortcuts'}
        </button>
      </div>

      {/* ガイドセクション */}
      {section === 'guide' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {t.guide.map((item, i) => (
            <div key={i} style={{
              padding: '12px 14px',
              borderRadius: 8,
              border: `1px solid ${theme.panelBorder}`,
              background: theme.cardBg,
            }}>
              <div style={{
                fontSize: 12, fontWeight: 700,
                color: theme.textPrimary, marginBottom: 8,
              }}>
                {item.title}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {item.paragraphs.map((p, j) => (
                  <p key={j} style={{
                    fontSize: 12, color: theme.textSecondary,
                    lineHeight: 1.7, margin: 0,
                  }}>
                    {p}
                  </p>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ショートカットセクション */}
      {section === 'shortcuts' && (
        <div>
          {t.shortcuts.map(sec => (
            <div key={sec.category} style={{ marginBottom: 20 }}>
              <div style={{
                fontSize: 11, fontWeight: 700,
                color: theme.textSecondary, letterSpacing: '0.5px', marginBottom: 8,
              }}>
                {sec.category}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {sec.items.map((item, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 200, flexWrap: 'wrap' }}>
                      {item.keys.map((k, j) => (
                        <span key={j} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                          {j > 0 && <span style={{ fontSize: 10, color: theme.textMuted }}>+</span>}
                          <KeyBadge label={k} />
                        </span>
                      ))}
                    </div>
                    <span style={{ fontSize: 12, color: theme.textSecondary }}>{item.desc}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* AI に聞く */}
      <div style={{
        marginTop: 16,
        borderTop: `1px solid ${theme.panelBorder}`,
        paddingTop: 16,
      }}>
        <div style={{
          fontSize: 11, fontWeight: 700,
          color: theme.textSecondary, letterSpacing: '0.5px', marginBottom: 8,
        }}>
          {t.aiAskTitle}
        </div>
        <div style={{
          padding: '12px 14px',
          borderRadius: 8,
          border: `1px dashed ${theme.panelBorder}`,
          background: theme.cardBg,
          fontSize: 12,
          color: theme.textMuted,
          lineHeight: 1.6,
        }}>
          {t.aiAskDesc}
        </div>
      </div>

    </div>
  )
}
