import type { Theme } from '@/themes'
import { themes } from '@/themes'
import { locales } from '@/i18n'
import { useTheme } from '@/context/ThemeContext'
import { useLocale } from '@/context/LocaleContext'

export function SettingsTab() {
  const { theme, setThemeId } = useTheme()
  const { strings: t, setLocaleId } = useLocale()

  return (
    <div className="h-full overflow-y-auto" style={{ padding: 14 }}>

      {/* カラーテーマ */}
      <Section title={t.settingsColorTheme} theme={theme}>
        {themes.map(th => (
          <OptionCard
            key={th.id}
            isActive={th.id === theme.id}
            onClick={() => setThemeId(th.id)}
            theme={theme}
          >
            <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
              {[th.appBg, th.panelBg, th.accent].map((color, i) => (
                <div key={i} style={{
                  width: 14, height: 14, borderRadius: 3,
                  background: color, border: `1px solid ${theme.panelBorder}`,
                }} />
              ))}
            </div>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: theme.textPrimary }}>{th.label}</div>
              <div style={{ fontSize: 11, color: theme.textSecondary, marginTop: 2 }}>
                {th.id === 'poc' ? t.pocThemeDesc : t.matsuoThemeDesc}
              </div>
            </div>
          </OptionCard>
        ))}
      </Section>

      {/* 言語 */}
      <Section title={t.settingsLanguage} theme={theme}>
        {locales.map(locale => (
          <OptionCard
            key={locale.id}
            isActive={locale.id === t.id}
            onClick={() => setLocaleId(locale.id)}
            theme={theme}
          >
            <div style={{ fontSize: 18, lineHeight: 1, flexShrink: 0 }}>
              {locale.id === 'ja' ? '🇯🇵' : locale.id === 'en' ? '🇺🇸' : locale.id === 'zh' ? '🇨🇳' : '🌐'}
            </div>
            <div style={{ fontSize: 13, fontWeight: 600, color: theme.textPrimary }}>
              {locale.label}
            </div>
          </OptionCard>
        ))}
      </Section>

    </div>
  )
}

function Section({ title, theme, children }: { title: string; theme: Theme; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{
        fontSize: 11, fontWeight: 700, color: theme.textSecondary,
        letterSpacing: '0.5px', marginBottom: 12,
      }}>
        {title}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {children}
      </div>
    </div>
  )
}

function OptionCard({ isActive, onClick, theme, children }: {
  isActive: boolean
  onClick: () => void
  theme: Theme
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '10px 14px', borderRadius: 8, cursor: 'pointer',
        border: `1.5px solid ${isActive ? theme.accent : theme.panelBorder}`,
        background: isActive ? theme.cardBgActive : theme.cardBg,
        textAlign: 'left', width: '100%',
        transition: 'border-color 0.15s, background 0.15s',
      }}
    >
      {children}
      {isActive && (
        <div style={{ marginLeft: 'auto', fontSize: 12, color: theme.accent, fontWeight: 700 }}>✓</div>
      )}
    </button>
  )
}
