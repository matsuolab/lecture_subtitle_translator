import type { Theme } from '@/themes'
import { themes } from '@/themes'
import { locales } from '@/i18n'
import { useTheme } from '@/context/ThemeContext'
import { useLocale } from '@/context/LocaleContext'
import type { AdminSettings, TranslationProvider } from '@/types/adminSettings'

type SettingsTabProps = {
  adminSettings: AdminSettings
  onAdminSettingsChange: (patch: Partial<AdminSettings>) => void
  onAdminSettingsReset: () => void
}

export function SettingsTab({
  adminSettings,
  onAdminSettingsChange,
  onAdminSettingsReset,
}: SettingsTabProps) {
  const { theme, setThemeId } = useTheme()
  const { strings: t, setLocaleId } = useLocale()

  return (
    <div className="h-full overflow-y-auto" style={{ padding: 14 }}>
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

      <Section title={t.settingsAdminTitle} theme={theme}>
        <FieldCard theme={theme}>
          <Field
            theme={theme}
            label="WhisperX URL"
            value={adminSettings.whisperxUrl}
            placeholder="http://localhost:8000"
            onChange={(value) => onAdminSettingsChange({ whisperxUrl: value })}
          />
          <Field
            theme={theme}
            label="WhisperX API Key"
            value={adminSettings.whisperxApiKey}
            placeholder="（不要な場合は空白）"
            type="password"
            onChange={(value) => onAdminSettingsChange({ whisperxApiKey: value })}
          />
          <Field
            theme={theme}
            label="WhisperX Language"
            value={adminSettings.whisperxLanguage}
            placeholder="ja"
            onChange={(value) => onAdminSettingsChange({ whisperxLanguage: value })}
          />
        </FieldCard>

        <FieldCard theme={theme}>
          <Field
            theme={theme}
            label="補正モデル (Correction)"
            value={adminSettings.correctionModel}
            placeholder="gpt-4.1-nano"
            onChange={(value) => onAdminSettingsChange({ correctionModel: value })}
          />
          <Field
            theme={theme}
            label="翻訳モデル (Translation)"
            value={adminSettings.translationModel}
            placeholder="gpt-4.1-mini"
            onChange={(value) => onAdminSettingsChange({ translationModel: value })}
          />
          <Field
            theme={theme}
            label="Embedding モデル"
            value={adminSettings.embeddingModel}
            placeholder="text-embedding-3-small"
            onChange={(value) => onAdminSettingsChange({ embeddingModel: value })}
          />
        </FieldCard>

        <FieldCard theme={theme}>
          <Field
            theme={theme}
            label={t.settingsPipelineApiUrl}
            value={adminSettings.pipelineApiUrl}
            placeholder={t.settingsPipelineApiUrlPlaceholder}
            onChange={(value) => onAdminSettingsChange({ pipelineApiUrl: value })}
          />
          <Field
            theme={theme}
            label={t.settingsHfToken}
            value={adminSettings.hfToken}
            placeholder={t.settingsHfTokenPlaceholder}
            type="password"
            onChange={(value) => onAdminSettingsChange({ hfToken: value })}
          />
        </FieldCard>

        <FieldCard theme={theme}>
          <SelectField
            theme={theme}
            label={t.settingsTranslatorProvider}
            value={adminSettings.translationProvider}
            onChange={(value) => onAdminSettingsChange({ translationProvider: value })}
            options={[
              { value: 'openai', label: t.settingsTranslatorProviderOpenAi },
              { value: 'gemini', label: t.settingsTranslatorProviderGemini },
              { value: 'deepl', label: t.settingsTranslatorProviderDeepL },
              { value: 'local', label: t.settingsTranslatorProviderLocal },
            ]}
          />
          <Field
            theme={theme}
            label={t.settingsOpenAiBaseUrl}
            value={adminSettings.openaiCompatibleBaseUrl}
            placeholder={t.settingsOpenAiBaseUrlPlaceholder}
            onChange={(value) => onAdminSettingsChange({ openaiCompatibleBaseUrl: value })}
          />
        </FieldCard>

        <FieldCard theme={theme}>
          <Field
            theme={theme}
            label={t.settingsOpenAiApiKey}
            value={adminSettings.openaiApiKey}
            placeholder="sk-..."
            type="password"
            onChange={(value) => onAdminSettingsChange({ openaiApiKey: value })}
          />
          <Field
            theme={theme}
            label={t.settingsGeminiApiKey}
            value={adminSettings.geminiApiKey}
            placeholder="AIza..."
            type="password"
            onChange={(value) => onAdminSettingsChange({ geminiApiKey: value })}
          />
          <Field
            theme={theme}
            label={t.settingsDeepLApiKey}
            value={adminSettings.deeplApiKey}
            placeholder="DeepL key"
            type="password"
            onChange={(value) => onAdminSettingsChange({ deeplApiKey: value })}
          />
        </FieldCard>

        <div style={{ fontSize: 11, color: theme.textSecondary, lineHeight: 1.6 }}>
          {t.settingsStorageNotice}
        </div>

        <button
          onClick={onAdminSettingsReset}
          style={{
            marginTop: 10,
            padding: '8px 12px',
            borderRadius: 8,
            border: `1px solid ${theme.panelBorder}`,
            background: theme.cardBg,
            color: theme.textPrimary,
            cursor: 'pointer',
          }}
        >
          {t.settingsResetAdmin}
        </button>
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

function FieldCard({ theme, children }: { theme: Theme; children: React.ReactNode }) {
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      gap: 12,
      padding: 14,
      borderRadius: 8,
      border: `1px solid ${theme.panelBorder}`,
      background: theme.cardBg,
    }}>
      {children}
    </div>
  )
}

function Field({
  theme,
  label,
  value,
  placeholder,
  onChange,
  type = 'text',
}: {
  theme: Theme
  label: string
  value: string
  placeholder?: string
  onChange: (value: string) => void
  type?: 'text' | 'password'
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{ fontSize: 12, fontWeight: 600, color: theme.textPrimary }}>{label}</span>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        style={{
          width: '100%',
          padding: '10px 12px',
          borderRadius: 8,
          border: `1px solid ${theme.panelBorder}`,
          background: theme.panelBg,
          color: theme.textPrimary,
          fontSize: 12,
        }}
      />
    </label>
  )
}

function SelectField({
  theme,
  label,
  value,
  onChange,
  options,
}: {
  theme: Theme
  label: string
  value: TranslationProvider
  onChange: (value: TranslationProvider) => void
  options: Array<{ value: TranslationProvider; label: string }>
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{ fontSize: 12, fontWeight: 600, color: theme.textPrimary }}>{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as TranslationProvider)}
        style={{
          width: '100%',
          padding: '10px 12px',
          borderRadius: 8,
          border: `1px solid ${theme.panelBorder}`,
          background: theme.panelBg,
          color: theme.textPrimary,
          fontSize: 12,
        }}
      >
        {options.map(option => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
    </label>
  )
}
