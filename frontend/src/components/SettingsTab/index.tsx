import React from 'react'
import type { Theme } from '@/themes'
import { themes } from '@/themes'
import { locales } from '@/i18n'
import { useTheme } from '@/context/ThemeContext'
import { useLocale } from '@/context/LocaleContext'
import type { AdminSettings, ServiceMode, TranslationProvider } from '@/types/adminSettings'
import {
  DEFAULT_GEMINI_CHAT_MODEL,
  DEFAULT_OPENAI_CHAT_MODEL,
  LOCAL_OLLAMA_OPENAI_COMPAT_BASE_URL,
  LOCAL_OPENAI_COMPAT_BASE_URL,
  resolveAiConnection,
} from '@/lib/pipeline/aiProvider'
import { tauriFetch } from '@/lib/tauriFetch'

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

  const [availableModels, setAvailableModels] = React.useState<string[]>(() => {
    try {
      const cached = localStorage.getItem('subtitle-editor.available-models')
      return cached ? JSON.parse(cached) as string[] : []
    } catch { return [] }
  })
  const [modelRefreshState, setModelRefreshState] = React.useState<'idle' | 'loading' | 'error'>('idle')
  const isLocalOpenAiProvider = adminSettings.translationProvider === 'local_openai'

  async function handleRefreshModels() {
    setModelRefreshState('loading')
    try {
      const connection = resolveAiConnection(adminSettings)
      const res = await tauriFetch(`${connection.baseUrl}/models`, {
        headers: connection.apiKey ? { Authorization: `Bearer ${connection.apiKey}` } : {},
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json<{ data?: Array<{ id: string }> }>()
      const ids: string[] = ((data.data ?? []) as Array<{ id: string }>)
        .map((m) => m.id)
        .sort()
      setAvailableModels(ids)
      localStorage.setItem('subtitle-editor.available-models', JSON.stringify(ids))
      if (isLocalOpenAiProvider && ids.length === 1) {
        const modelId = ids[0]
        onAdminSettingsChange({
          translationModel: adminSettings.translationModel.trim() || modelId,
          correctionModel: adminSettings.correctionModel.trim() || modelId,
          pdfExtractionVisionModel: adminSettings.pdfExtractionVisionModel.trim() || modelId,
          compressModel: adminSettings.compressModel.trim() || modelId,
          microModel: adminSettings.microModel.trim() || modelId,
          expandModel: adminSettings.expandModel.trim() || modelId,
          contextMergeModel: adminSettings.contextMergeModel.trim() || modelId,
        })
      }
      setModelRefreshState('idle')
    } catch {
      setModelRefreshState('error')
    }
  }

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

  const refreshLabel = modelRefreshState === 'loading'
    ? t.settingsRefreshModelsLoading
    : modelRefreshState === 'error'
      ? t.settingsRefreshModelsError
      : t.settingsRefreshModels

  const localModelPlaceholder = availableModels.length === 1
    ? availableModels[0]
    : 'モデル一覧を更新して選択'

  function getChatModelPlaceholder(defaultModel: string): string {
    return isLocalOpenAiProvider ? localModelPlaceholder : defaultModel
  }

  function handleTranslationProviderChange(value: TranslationProvider) {
    if (value === 'gemini') {
      onAdminSettingsChange({
        translationProvider: value,
        translationModel: DEFAULT_GEMINI_CHAT_MODEL,
        correctionModel: DEFAULT_GEMINI_CHAT_MODEL,
        pdfExtractionVisionModel: DEFAULT_GEMINI_CHAT_MODEL,
        compressModel: DEFAULT_GEMINI_CHAT_MODEL,
        microModel: DEFAULT_GEMINI_CHAT_MODEL,
        expandModel: DEFAULT_GEMINI_CHAT_MODEL,
        contextMergeModel: DEFAULT_GEMINI_CHAT_MODEL,
      })
      return
    }
    if (value === 'local_openai') {
      onAdminSettingsChange({
        translationProvider: value,
        openaiCompatibleBaseUrl: adminSettings.openaiCompatibleBaseUrl.trim() || LOCAL_OPENAI_COMPAT_BASE_URL,
        translationModel: '',
        correctionModel: '',
        pdfExtractionVisionModel: '',
        compressModel: '',
        microModel: '',
        expandModel: '',
        contextMergeModel: '',
      })
      return
    }
    onAdminSettingsChange({
      translationProvider: value,
      openaiCompatibleBaseUrl: '',
      translationModel: DEFAULT_OPENAI_CHAT_MODEL,
      correctionModel: DEFAULT_OPENAI_CHAT_MODEL,
      pdfExtractionVisionModel: DEFAULT_OPENAI_CHAT_MODEL,
      compressModel: DEFAULT_OPENAI_CHAT_MODEL,
      microModel: DEFAULT_OPENAI_CHAT_MODEL,
      expandModel: DEFAULT_OPENAI_CHAT_MODEL,
      contextMergeModel: 'gpt-5.5',
    })
  }

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
          <div style={{ fontSize: 12, fontWeight: 600, color: theme.textPrimary }}>接続先AIプロバイダ</div>
          <SelectField
            theme={theme}
            label={t.settingsTranslatorProvider}
            value={adminSettings.translationProvider}
            onChange={handleTranslationProviderChange}
            options={[
              { value: 'openai', label: t.settingsTranslatorProviderOpenAi },
              { value: 'gemini', label: t.settingsTranslatorProviderGemini },
              { value: 'local_openai', label: t.settingsTranslatorProviderLocalOpenAi },
            ]}
          />
          <Field
            theme={theme}
            label={adminSettings.translationProvider === 'gemini'
              ? t.settingsGeminiApiKey
              : isLocalOpenAiProvider
                ? t.settingsLocalOpenAiApiKey
                : t.settingsOpenAiApiKey}
            value={adminSettings.translationProvider === 'gemini' ? adminSettings.geminiApiKey : adminSettings.openaiApiKey}
            placeholder={adminSettings.translationProvider === 'gemini' ? 'AIza...' : isLocalOpenAiProvider ? '任意' : 'sk-...'}
            type="password"
            onChange={(value) => onAdminSettingsChange(
              adminSettings.translationProvider === 'gemini'
                ? { geminiApiKey: value }
                : { openaiApiKey: value },
            )}
          />
          {isLocalOpenAiProvider && (
            <>
              <Field
                theme={theme}
                label={t.settingsOpenAiBaseUrl}
                value={adminSettings.openaiCompatibleBaseUrl}
                placeholder={isLocalOpenAiProvider ? LOCAL_OPENAI_COMPAT_BASE_URL : t.settingsOpenAiBaseUrlPlaceholder}
                onChange={(value) => onAdminSettingsChange({ openaiCompatibleBaseUrl: value })}
              />
              {isLocalOpenAiProvider && (
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    onClick={() => onAdminSettingsChange({ openaiCompatibleBaseUrl: LOCAL_OPENAI_COMPAT_BASE_URL })}
                    style={{
                      padding: '7px 10px',
                      borderRadius: 8,
                      border: `1px solid ${theme.panelBorder}`,
                      background: theme.panelBg,
                      color: theme.textPrimary,
                      cursor: 'pointer',
                      fontSize: 12,
                      fontWeight: 600,
                    }}
                  >
                    LM Studio
                  </button>
                  <button
                    type="button"
                    onClick={() => onAdminSettingsChange({ openaiCompatibleBaseUrl: LOCAL_OLLAMA_OPENAI_COMPAT_BASE_URL })}
                    style={{
                      padding: '7px 10px',
                      borderRadius: 8,
                      border: `1px solid ${theme.panelBorder}`,
                      background: theme.panelBg,
                      color: theme.textPrimary,
                      cursor: 'pointer',
                      fontSize: 12,
                      fontWeight: 600,
                    }}
                  >
                    Ollama
                  </button>
                </div>
              )}
            </>
          )}
          <div style={{ fontSize: 11, color: theme.textSecondary, lineHeight: 1.6 }}>
            {isLocalOpenAiProvider
              ? 'LM Studio・Ollama などのローカルサーバーや、Azure OpenAI・Groq などの OpenAI 互換サービスを使います。APIキーはサービス側で要求される場合のみ入力してください。'
              : '翻訳、補正、短縮、分割、文脈統合などのLLM処理に使うプロバイダとAPIキーです。入力したキーはこのPCの設定として保存されます。'}
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

        <datalist id="available-models-list">
          {availableModels.map((id) => (
            <option key={id} value={id} />
          ))}
        </datalist>

        <FieldCard theme={theme}>
          <div style={{ fontSize: 11, color: theme.textSecondary, lineHeight: 1.5 }}>
            入力でフィルター・絞り込み。「モデル一覧を更新」で選択肢を取得してから ▼ をクリックすると一覧表示されます。
          </div>
          <ComboField
            theme={theme}
            label="補正モデル (Correction)"
            value={adminSettings.correctionModel}
            placeholder={adminSettings.translationProvider === 'gemini' ? DEFAULT_GEMINI_CHAT_MODEL : getChatModelPlaceholder(DEFAULT_OPENAI_CHAT_MODEL)}
            listId="available-models-list"
            hint="接続先AIプロバイダに対応するモデルIDを指定します"
            onChange={(value) => onAdminSettingsChange({ correctionModel: value })}
          />
          <ComboField
            theme={theme}
            label="翻訳モデル (Translation)"
            value={adminSettings.translationModel}
            placeholder={adminSettings.translationProvider === 'gemini' ? DEFAULT_GEMINI_CHAT_MODEL : getChatModelPlaceholder(DEFAULT_OPENAI_CHAT_MODEL)}
            listId="available-models-list"
            hint="圧縮・展開モデルが空欄の場合もこのモデルを流用します"
            onChange={(value) => onAdminSettingsChange({ translationModel: value })}
          />
          <ComboField
            theme={theme}
            label="PDF抽出Visionモデル"
            value={adminSettings.pdfExtractionVisionModel}
            placeholder={adminSettings.translationProvider === 'gemini' ? DEFAULT_GEMINI_CHAT_MODEL : getChatModelPlaceholder(DEFAULT_OPENAI_CHAT_MODEL)}
            listId="available-models-list"
            hint="辞書作成でVision LLMを有効にした場合だけ使います。テキスト専用モデルでは失敗します"
            onChange={(value) => onAdminSettingsChange({ pdfExtractionVisionModel: value })}
          />
          <ToggleField
            theme={theme}
            label="PDF辞書作成を並列化"
            checked={adminSettings.pdfExtractionParallel}
            hint="OFFでは1ページずつ処理します。ONではローカルLLMは2並列、Vision APIは3並列で処理します。ローカルLLMが不安定な場合はOFFにしてください"
            onChange={(value) => onAdminSettingsChange({ pdfExtractionParallel: value })}
          />
          <ComboField
            theme={theme}
            label="Embedding モデル"
            value={adminSettings.embeddingModel}
            placeholder="text-embedding-3-small"
            listId="available-models-list"
            hint="空欄 = text-embedding-3-small"
            onChange={(value) => onAdminSettingsChange({ embeddingModel: value })}
          />
          <ComboField
            theme={theme}
            label={t.settingsCompressModel}
            value={adminSettings.compressModel}
            placeholder="（翻訳モデルと同じ）"
            listId="available-models-list"
            hint="空欄 = 翻訳モデルと同じ"
            onChange={(value) => onAdminSettingsChange({ compressModel: value })}
          />
          <ComboField
            theme={theme}
            label={t.settingsMicroModel}
            value={adminSettings.microModel}
            placeholder="（圧縮モデルと同じ）"
            listId="available-models-list"
            hint="1単語ずつ削るマイクロ圧縮用。空欄 = 圧縮モデルと同じ。コストを抑えたい場合は小型モデルを指定"
            onChange={(value) => onAdminSettingsChange({ microModel: value })}
          />
          <ComboField
            theme={theme}
            label={t.settingsExpandModel}
            value={adminSettings.expandModel}
            placeholder="（翻訳モデルと同じ）"
            listId="available-models-list"
            hint="空欄 = 翻訳モデルと同じ"
            onChange={(value) => onAdminSettingsChange({ expandModel: value })}
          />
          <ComboField
            theme={theme}
            label="文脈統合モデル (Context Merge)"
            value={adminSettings.contextMergeModel}
            placeholder={adminSettings.translationProvider === 'gemini' ? DEFAULT_GEMINI_CHAT_MODEL : getChatModelPlaceholder('gpt-5.5')}
            listId="available-models-list"
            hint="文脈依存の短い断片を前後どちらに統合するか判断する高精度モデル"
            onChange={(value) => onAdminSettingsChange({ contextMergeModel: value })}
          />
          <Field
            theme={theme}
            label="字幕言語ラベル"
            value={adminSettings.subtitleLanguageLabel}
            placeholder="English"
            onChange={(value) => onAdminSettingsChange({ subtitleLanguageLabel: value })}
          />
          <Field
            theme={theme}
            label="書き起こし言語ラベル"
            value={adminSettings.transcriptLanguageLabel}
            placeholder="Japanese"
            onChange={(value) => onAdminSettingsChange({ transcriptLanguageLabel: value })}
          />
          <TextareaField
            theme={theme}
            label="言語プロファイルJSON"
            value={adminSettings.languageProfileConfigJson}
            placeholder='{"subtitle":{"label":"English","script":"latin"},"transcript":{"label":"Japanese","script":"japanese"}}'
            onChange={(value) => onAdminSettingsChange({ languageProfileConfigJson: value })}
          />
          <button
            onClick={handleRefreshModels}
            disabled={modelRefreshState === 'loading'}
            style={{
              padding: '8px 12px',
              borderRadius: 8,
              border: `1px solid ${theme.panelBorder}`,
              background: theme.panelBg,
              color: modelRefreshState === 'error' ? '#ef4444' : theme.textPrimary,
              cursor: modelRefreshState === 'loading' ? 'wait' : 'pointer',
              fontSize: 12,
              fontWeight: 600,
            }}
          >
            {refreshLabel}
          </button>
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

        <FieldCard theme={theme}>
          <div style={{ fontSize: 12, fontWeight: 600, color: theme.textPrimary }}>{t.settingsSemanticCheckTitle}</div>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: theme.textPrimary }}>{t.settingsSemanticCheckMode}</span>
            <select
              value={adminSettings.semanticCheckMode}
              onChange={(e) => onAdminSettingsChange({ semanticCheckMode: e.target.value as 'off' | 'log_only' | 'enforce' })}
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
              <option value="off">{t.settingsSemanticCheckOff}</option>
              <option value="log_only">{t.settingsSemanticCheckLogOnly}</option>
              <option value="enforce">{t.settingsSemanticCheckEnforce}</option>
            </select>
          </label>
          <div style={{ fontSize: 11, color: theme.textSecondary, lineHeight: 1.6 }}>
            {t.settingsSemanticCheckDesc}
          </div>
        </FieldCard>
      </Section>

      <Section title={t.settingsPipelineThresholdsTitle} theme={theme}>
        <FieldCard theme={theme}>
          <NumberField
            theme={theme}
            label={t.settingsPipelineShortDurationSec}
            value={adminSettings.pipelineShortDurationSec}
            min={0.1}
            step={0.1}
            onChange={(value) => onAdminSettingsChange({ pipelineShortDurationSec: value })}
          />
          <NumberField
            theme={theme}
            label={t.settingsPipelineLongDurationSec}
            value={adminSettings.pipelineLongDurationSec}
            min={1}
            step={0.5}
            onChange={(value) => onAdminSettingsChange({ pipelineLongDurationSec: value })}
          />
          <NumberField
            theme={theme}
            label={t.settingsPipelineMergedLongDurationSec}
            value={adminSettings.pipelineMergedLongDurationSec}
            min={1}
            step={0.5}
            onChange={(value) => onAdminSettingsChange({ pipelineMergedLongDurationSec: value })}
          />
        </FieldCard>
        <FieldCard theme={theme}>
          <NumberField
            theme={theme}
            label={t.settingsPipelineVerboseEnRatio}
            value={adminSettings.pipelineVerboseEnRatio}
            min={0.5}
            step={0.1}
            onChange={(value) => onAdminSettingsChange({ pipelineVerboseEnRatio: value })}
          />
          <NumberField
            theme={theme}
            label={t.settingsPipelineOverCompressedRatio}
            value={adminSettings.pipelineOverCompressedRatio}
            min={0.05}
            step={0.05}
            onChange={(value) => onAdminSettingsChange({ pipelineOverCompressedRatio: value })}
          />
          <NumberField
            theme={theme}
            label={t.settingsPipelineOverCompressedJaChars}
            value={adminSettings.pipelineOverCompressedJaChars}
            min={1}
            onChange={(value) => onAdminSettingsChange({ pipelineOverCompressedJaChars: value })}
          />
          <NumberField
            theme={theme}
            label={t.settingsPipelineSlowCps}
            value={adminSettings.pipelineSlowCps}
            min={0.5}
            step={0.5}
            onChange={(value) => onAdminSettingsChange({ pipelineSlowCps: value })}
          />
        </FieldCard>
        <FieldCard theme={theme}>
          <NumberField
            theme={theme}
            label={t.settingsPipelineMaxExpandPerBlock}
            value={adminSettings.pipelineMaxExpandPerBlock}
            min={0}
            onChange={(value) => onAdminSettingsChange({ pipelineMaxExpandPerBlock: value })}
          />
          <NumberField
            theme={theme}
            label={t.settingsPipelineMaxCompressPerBlock}
            value={adminSettings.pipelineMaxCompressPerBlock}
            min={0}
            onChange={(value) => onAdminSettingsChange({ pipelineMaxCompressPerBlock: value })}
          />
          <NumberField
            theme={theme}
            label={t.settingsPipelineMaxPhase2Retries}
            value={adminSettings.pipelineMaxPhase2Retries}
            min={0}
            onChange={(value) => onAdminSettingsChange({ pipelineMaxPhase2Retries: value })}
          />
        </FieldCard>
        <FieldCard theme={theme}>
          <TextareaField
            theme={theme}
            label={t.settingsCompressPromptOverride}
            value={adminSettings.compressPromptOverride}
            placeholder="(empty = use default)"
            onChange={(value) => onAdminSettingsChange({ compressPromptOverride: value })}
          />
          <TextareaField
            theme={theme}
            label={t.settingsExpandPromptOverride}
            value={adminSettings.expandPromptOverride}
            placeholder="(empty = use default)"
            onChange={(value) => onAdminSettingsChange({ expandPromptOverride: value })}
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

function ComboField({
  theme,
  label,
  value,
  placeholder,
  listId,
  hint,
  onChange,
}: {
  theme: Theme
  label: string
  value: string
  placeholder?: string
  listId: string
  hint?: string
  onChange: (value: string) => void
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{ fontSize: 12, fontWeight: 600, color: theme.textPrimary }}>{label}</span>
      <input
        type="text"
        list={listId}
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
      {hint && (
        <span style={{ fontSize: 11, color: theme.textSecondary, lineHeight: 1.5 }}>{hint}</span>
      )}
    </div>
  )
}

function ToggleField({
  theme,
  label,
  checked,
  hint,
  onChange,
}: {
  theme: Theme
  label: string
  checked: boolean
  hint?: string
  onChange: (value: boolean) => void
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, fontWeight: 600, color: theme.textPrimary }}>
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
        />
        {label}
      </span>
      {hint && (
        <span style={{ fontSize: 11, color: theme.textSecondary, lineHeight: 1.5 }}>{hint}</span>
      )}
    </label>
  )
}

function TextareaField({
  theme,
  label,
  value,
  placeholder,
  onChange,
}: {
  theme: Theme
  label: string
  value: string
  placeholder?: string
  onChange: (value: string) => void
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{ fontSize: 12, fontWeight: 600, color: theme.textPrimary }}>{label}</span>
      <textarea
        value={value}
        placeholder={placeholder}
        rows={4}
        onChange={(e) => onChange(e.target.value)}
        style={{
          width: '100%',
          padding: '10px 12px',
          borderRadius: 8,
          border: `1px solid ${theme.panelBorder}`,
          background: theme.panelBg,
          color: theme.textPrimary,
          fontSize: 12,
          resize: 'vertical',
          fontFamily: 'inherit',
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
  const [display, setDisplay] = React.useState(() => String(value))

  React.useEffect(() => {
    setDisplay(String(value))
  }, [value])

  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{ fontSize: 12, fontWeight: 600, color: theme.textPrimary }}>{label}</span>
      <input
        type="number"
        value={display}
        min={min}
        step={step}
        onChange={(e) => {
          setDisplay(e.target.value)
          const n = parseFloat(e.target.value)
          if (isFinite(n) && (min === undefined || n >= min)) onChange(n)
        }}
        onBlur={() => {
          const n = parseFloat(display)
          if (!isFinite(n) || (min !== undefined && n < min)) setDisplay(String(value))
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
