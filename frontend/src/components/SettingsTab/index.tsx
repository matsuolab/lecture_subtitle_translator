import type { Theme } from '@/themes'
import { themes } from '@/themes'
import { locales } from '@/i18n'
import { useTheme } from '@/context/ThemeContext'
import { useLocale } from '@/context/LocaleContext'
import type { AdminSettings, ServiceMode, TranslationProvider } from '@/types/adminSettings'

type ServiceCheckState = {
  status: 'idle' | 'checking' | 'success' | 'error'
  message: string
}

type SettingsTabProps = {
  adminSettings: AdminSettings
  serviceCheck: ServiceCheckState
  onAdminSettingsChange: (patch: Partial<AdminSettings>) => void
  onAdminSettingsReset: () => void
  onServiceCheck: () => void
}

const serviceModeOptions: Array<{ value: ServiceMode; label: string }> = [
  { value: 'managed_service', label: 'AWS / リモート実行' },
  { value: 'legacy_pipeline', label: 'このPCで実行' },
]

export function SettingsTab({
  adminSettings,
  serviceCheck,
  onAdminSettingsChange,
  onAdminSettingsReset,
  onServiceCheck,
}: SettingsTabProps) {
  const { theme, setThemeId } = useTheme()
  const { strings: t, setLocaleId } = useLocale()
  const currentVersion = (import.meta.env.VITE_APP_VERSION as string | undefined) || null

  const serviceUrlPlaceholder = adminSettings.serviceMode === 'managed_service'
    ? 'https://service.example.com'
    : 'http://127.0.0.1:8000'

  const serviceHelpText = adminSettings.serviceMode === 'managed_service'
    ? '音声アップロード、ジョブ投入、結果取得を行う managed service の公開 URL を指定します。'
    : 'このPC上でローカル実行します。必要な書き起こしサービスはアプリが自動で起動します。'

  const serviceCheckColor = serviceCheck.status === 'success'
    ? '#22c55e'
    : serviceCheck.status === 'error'
      ? '#ef4444'
      : theme.textSecondary

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

      <Section title="アプリ情報" theme={theme}>
        <FieldCard theme={theme}>
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: theme.textPrimary }}>バージョン</div>
            <div style={{ fontSize: 11, color: theme.textSecondary, marginTop: 2 }}>
              {currentVersion && currentVersion !== '0.0.0' ? currentVersion : '開発ビルド'}
            </div>
          </div>
        </FieldCard>
      </Section>

      <Section title={t.settingsAdminTitle} theme={theme}>
        <FieldCard theme={theme}>
          <ModeSelectField
            theme={theme}
            label="実行先"
            value={adminSettings.serviceMode}
            onChange={(value) => onAdminSettingsChange({ serviceMode: value })}
            options={serviceModeOptions}
          />
          {adminSettings.serviceMode === 'managed_service' ? (
            <>
              <Field
                theme={theme}
                label="Service URL"
                value={adminSettings.serviceUrl}
                placeholder={serviceUrlPlaceholder}
                onChange={(value) => onAdminSettingsChange({ serviceUrl: value })}
              />
              <Field
                theme={theme}
                label="Service Auth Token"
                value={adminSettings.serviceAuthToken}
                placeholder="Bearer token or API token"
                type="password"
                onChange={(value) => onAdminSettingsChange({ serviceAuthToken: value })}
              />
            </>
          ) : (
            <div style={{
              padding: '10px 12px',
              borderRadius: 8,
              border: `1px solid ${theme.panelBorder}`,
              background: theme.panelBg,
              color: theme.textSecondary,
              fontSize: 12,
              lineHeight: 1.6,
            }}>
              ローカル実行に必要なサービスはアプリが自動で起動します。
            </div>
          )}
          <div style={{ fontSize: 11, color: theme.textSecondary, lineHeight: 1.6 }}>
            {serviceHelpText}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <button
              onClick={onServiceCheck}
              disabled={serviceCheck.status === 'checking'}
              style={{
                padding: '8px 12px',
                borderRadius: 8,
                border: `1px solid ${theme.panelBorder}`,
                background: theme.panelBg,
                color: theme.textPrimary,
                cursor: serviceCheck.status === 'checking' ? 'wait' : 'pointer',
                fontSize: 12,
                fontWeight: 600,
              }}
            >
              {serviceCheck.status === 'checking' ? 'Checking...' : '接続テスト'}
            </button>
            <span style={{ fontSize: 11, color: serviceCheckColor }}>
              {serviceCheck.message}
            </span>
          </div>
        </FieldCard>

        <FieldCard theme={theme}>
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
            label="補正モデル (Correction)"
            value={adminSettings.correctionModel}
            placeholder="gpt-4.1-nano"
            onChange={(value) => onAdminSettingsChange({ correctionModel: value })}
          />
          <Field
            theme={theme}
            label="翻訳モデル (Translation)"
            value={adminSettings.translationModel}
            placeholder=""
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

      <Section title={t.settingsSubtitleQualityTitle} theme={theme}>
        <FieldCard theme={theme}>
          <NumberField
            theme={theme}
            label={t.settingsEnMaxCharsPerLine}
            value={adminSettings.enMaxCharsPerLine}
            min={10}
            onChange={(value) => onAdminSettingsChange({ enMaxCharsPerLine: value })}
          />
          <NumberField
            theme={theme}
            label={t.settingsEnMaxLines}
            value={adminSettings.enMaxLines}
            min={1}
            onChange={(value) => onAdminSettingsChange({ enMaxLines: value })}
          />
          <NumberField
            theme={theme}
            label={t.settingsEnMaxTotalChars}
            value={adminSettings.enMaxTotalChars}
            min={10}
            onChange={(value) => onAdminSettingsChange({ enMaxTotalChars: value })}
          />
          <NumberField
            theme={theme}
            label={t.settingsEnMaxCps}
            value={adminSettings.enMaxCps}
            min={1}
            step={0.1}
            onChange={(value) => onAdminSettingsChange({ enMaxCps: value })}
          />
        </FieldCard>

        <FieldCard theme={theme}>
          <NumberField
            theme={theme}
            label={t.settingsSubtitleMinDuration}
            value={adminSettings.subtitleMinDurationSec}
            min={0.1}
            step={0.001}
            onChange={(value) => onAdminSettingsChange({ subtitleMinDurationSec: value })}
          />
          <NumberField
            theme={theme}
            label={t.settingsSubtitleMaxDuration}
            value={adminSettings.subtitleMaxDurationSec}
            min={1}
            step={0.1}
            onChange={(value) => onAdminSettingsChange({ subtitleMaxDurationSec: value })}
          />
          <NumberField
            theme={theme}
            label={t.settingsMergeMinJaChars}
            value={adminSettings.mergeMinJaChars}
            min={1}
            onChange={(value) => onAdminSettingsChange({ mergeMinJaChars: value })}
          />
        </FieldCard>

        <FieldCard theme={theme}>
          <NumberField
            theme={theme}
            label={t.settingsQualityCorrectionThreshold}
            value={adminSettings.qualityCorrectionThreshold}
            min={0.01}
            step={0.01}
            onChange={(value) => onAdminSettingsChange({ qualityCorrectionThreshold: value })}
          />
          <NumberField
            theme={theme}
            label={t.settingsQualityTranslationThreshold}
            value={adminSettings.qualityTranslationThreshold}
            min={0.01}
            step={0.01}
            onChange={(value) => onAdminSettingsChange({ qualityTranslationThreshold: value })}
          />
        </FieldCard>
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

function NumberField({
  theme,
  label,
  value,
  min,
  step = 1,
  onChange,
}: {
  theme: Theme
  label: string
  value: number
  min?: number
  step?: number
  onChange: (value: number) => void
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{ fontSize: 12, fontWeight: 600, color: theme.textPrimary }}>{label}</span>
      <input
        type="number"
        value={value}
        min={min}
        step={step}
        onChange={(e) => {
          const n = parseFloat(e.target.value)
          if (isFinite(n) && (min === undefined || n >= min)) onChange(n)
        }}
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

function ModeSelectField({
  theme,
  label,
  value,
  onChange,
  options,
}: {
  theme: Theme
  label: string
  value: ServiceMode
  onChange: (value: ServiceMode) => void
  options: Array<{ value: ServiceMode; label: string }>
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{ fontSize: 12, fontWeight: 600, color: theme.textPrimary }}>{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as ServiceMode)}
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
