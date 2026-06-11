import React from 'react'
import type { Theme } from '@/themes'
import { themes } from '@/themes'
import { locales } from '@/i18n'
import { useTheme } from '@/context/ThemeContext'
import { useLocale } from '@/context/LocaleContext'
import { useToast } from '@/context/ToastContext'
import type { AdminSettings, ApiCompatibilityProfilePresetId, ModelProfilePresetId, ServiceMode, TranslationProvider } from '@/types/adminSettings'
import { createSharedAdminSettingsExport, parseSharedAdminSettingsExport } from '@/api/adminSettings'
import { createAiGateway } from '@/lib/aiGateway'
import type { AiGatewayProbeName } from '@/lib/aiGateway'
import {
  createUserApiCompatibilityProfileFromBuiltin,
  formatApiCompatibilityProfileJson,
  resolveApiCompatibilityProfile,
  validateApiCompatibilityProfileJson,
} from '@/lib/aiGateway/apiCompatibilityProfile'
import {
  DEFAULT_GEMINI_CHAT_MODEL,
  DEFAULT_OPENAI_CHAT_MODEL,
  LOCAL_OLLAMA_OPENAI_COMPAT_BASE_URL,
  LOCAL_OPENAI_COMPAT_BASE_URL,
  resolveAiConnection,
} from '@/lib/pipeline/aiProvider'
import {
  normalizeSubtitleText,
  parseTextNormalizationConfig,
  validateTextNormalizationRulesJson,
} from '@/lib/pipeline/textNormalization'
import { tauriFetch } from '@/lib/tauriFetch'
import { getWorkLogDir, isWorkLogPersistent, openWorkLogDir } from '@/lib/worklog/repository'

type ServiceCheckState = {
  status: 'idle' | 'checking' | 'success' | 'error'
  message: string
}

type AiGatewayProbeItem = {
  name: AiGatewayProbeName
  status: 'checking' | 'success' | 'error'
  message: string
}

type AiGatewayProbeGuidance = {
  title: string
  actions: string[]
}

type SettingsTabProps = {
  adminSettings: AdminSettings
  serviceCheck: ServiceCheckState
  onAdminSettingsChange: (patch: Partial<AdminSettings>) => void
  onServiceCheck: () => void
}

const serviceModeOptions: Array<{ value: ServiceMode; label: string }> = [
  { value: 'managed_service', label: 'AWS / リモート実行' },
  { value: 'legacy_pipeline', label: 'このPCで実行' },
]

const modelProfilePresetOptions: Array<{ value: ModelProfilePresetId; label: string }> = [
  { value: 'auto', label: 'Auto' },
  { value: 'gemma', label: 'Gemma' },
  { value: 'qwen', label: 'Qwen' },
]

const apiCompatibilityProfilePresetOptions: Array<{ value: ApiCompatibilityProfilePresetId; label: string }> = [
  { value: 'auto', label: 'Auto' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'lmstudio', label: 'LM Studio' },
  { value: 'ollama', label: 'Ollama' },
  { value: 'gemini_openai_compatible', label: 'Gemini OpenAI互換' },
  { value: 'user', label: 'User Profile' },
]

export function SettingsTab({
  adminSettings,
  serviceCheck,
  onAdminSettingsChange,
  onServiceCheck,
}: SettingsTabProps) {
  const { theme, setThemeId } = useTheme()
  const { strings: t, setLocaleId } = useLocale()
  const toast = useToast()
  const currentVersion = (import.meta.env.VITE_APP_VERSION as string | undefined) || null

  const [availableModels, setAvailableModels] = React.useState<string[]>(() => {
    try {
      const cached = localStorage.getItem('subtitle-editor.available-models')
      return cached ? JSON.parse(cached) as string[] : []
    } catch { return [] }
  })
  const [modelRefreshState, setModelRefreshState] = React.useState<'idle' | 'loading' | 'error'>('idle')
  const [normalizationOpen, setNormalizationOpen] = React.useState(false)
  const [normalizationJsonDraft, setNormalizationJsonDraft] = React.useState(adminSettings.textNormalizationRulesJson)
  const [normalizationPreview, setNormalizationPreview] = React.useState('It’s “machine learning” with\u00A0NBSP.')
  const [normalizationMatchInput, setNormalizationMatchInput] = React.useState('')
  const [normalizationReplacementInput, setNormalizationReplacementInput] = React.useState('')
  const [aiGatewayProbeItems, setAiGatewayProbeItems] = React.useState<AiGatewayProbeItem[]>([])
  const [aiGatewayProbeRunning, setAiGatewayProbeRunning] = React.useState(false)
  const sharedSettingsImportRef = React.useRef<HTMLInputElement>(null)
  const apiCompatibilityProfileImportRef = React.useRef<HTMLInputElement>(null)
  const isLocalOpenAiProvider = adminSettings.translationProvider === 'local_openai'
  const resolvedApiCompatibilityProfile = React.useMemo(() => {
    try {
      return resolveApiCompatibilityProfile(adminSettings)
    } catch {
      return null
    }
  }, [adminSettings])
  const autoResolvedApiCompatibilityProfile = React.useMemo(() => {
    try {
      return resolveApiCompatibilityProfile({
        ...adminSettings,
        apiCompatibilityProfilePreset: 'auto',
        apiCompatibilityProfileJson: '',
      })
    } catch {
      return null
    }
  }, [adminSettings])
  const apiCompatibilityProfileValidation = React.useMemo(
    () => validateApiCompatibilityProfileJson(adminSettings.apiCompatibilityProfileJson),
    [adminSettings.apiCompatibilityProfileJson],
  )
  const normalizationValidation = React.useMemo(
    () => validateTextNormalizationRulesJson(normalizationJsonDraft),
    [normalizationJsonDraft],
  )
  const activeNormalizationRuleCount = normalizationValidation.config?.rules.filter(rule => rule.enabled).length ?? 0
  const normalizationPreviewOutput = React.useMemo(() => {
    if (!normalizationValidation.ok || !normalizationValidation.config) return normalizationPreview
    return normalizeSubtitleText(normalizationPreview, normalizationValidation.config)
  }, [normalizationPreview, normalizationValidation])

  React.useEffect(() => {
    setNormalizationJsonDraft(adminSettings.textNormalizationRulesJson)
  }, [adminSettings.textNormalizationRulesJson])

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
          pdfFormulaMiniModel: adminSettings.pdfFormulaMiniModel.trim() || modelId,
          compressModel: adminSettings.compressModel.trim() || modelId,
          microModel: adminSettings.microModel.trim() || modelId,
          expandModel: adminSettings.expandModel.trim() || modelId,
          contextMergeModel: adminSettings.contextMergeModel.trim() || modelId,
          splitJaModel: adminSettings.splitJaModel.trim() || modelId,
        })
      }
      setModelRefreshState('idle')
    } catch {
      setModelRefreshState('error')
    }
  }

  async function handleAiGatewayProbe() {
    setAiGatewayProbeRunning(true)
    setAiGatewayProbeItems([
      { name: 'Connection', status: 'checking', message: 'checking /models' },
      { name: 'Chat Text', status: 'checking', message: 'waiting' },
      { name: 'Embeddings', status: 'checking', message: 'waiting' },
      { name: 'Chat Vision', status: 'checking', message: 'waiting' },
    ])

    try {
      const results = await createAiGateway(adminSettings).probeAll()
      setAiGatewayProbeItems(results)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setAiGatewayProbeItems(prev => prev.map(item => (
        item.status === 'checking' ? { ...item, status: 'error', message } : item
      )))
    } finally {
      setAiGatewayProbeRunning(false)
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
        pdfFormulaMiniModel: DEFAULT_GEMINI_CHAT_MODEL,
        compressModel: DEFAULT_GEMINI_CHAT_MODEL,
        microModel: DEFAULT_GEMINI_CHAT_MODEL,
        expandModel: DEFAULT_GEMINI_CHAT_MODEL,
        contextMergeModel: DEFAULT_GEMINI_CHAT_MODEL,
        splitJaModel: DEFAULT_GEMINI_CHAT_MODEL,
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
        pdfFormulaMiniModel: '',
        compressModel: '',
        microModel: '',
        expandModel: '',
        contextMergeModel: '',
        splitJaModel: '',
      })
      return
    }
    onAdminSettingsChange({
      translationProvider: value,
      openaiCompatibleBaseUrl: '',
      translationModel: DEFAULT_OPENAI_CHAT_MODEL,
      correctionModel: DEFAULT_OPENAI_CHAT_MODEL,
      pdfExtractionVisionModel: 'gpt-5.4-nano',
      pdfFormulaMiniModel: DEFAULT_OPENAI_CHAT_MODEL,
      compressModel: DEFAULT_OPENAI_CHAT_MODEL,
      microModel: 'gpt-5.4-nano',
      expandModel: DEFAULT_OPENAI_CHAT_MODEL,
      contextMergeModel: DEFAULT_OPENAI_CHAT_MODEL,
      splitJaModel: 'gpt-5.4-nano',
    })
  }

  async function handlePickWorkLogDir() {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const picked = await open({
        directory: true,
        multiple: false,
        title: 'ワークログの保管場所を選択',
      })
      if (typeof picked === 'string') {
        onAdminSettingsChange({ workLogDir: picked })
      }
    } catch {
      alert('フォルダの選択に失敗しました。')
    }
  }

  async function handleOpenWorkLogDir() {
    try {
      const dir = await getWorkLogDir(adminSettings.workLogDir)
      await openWorkLogDir(dir)
    } catch (err) {
      alert(err instanceof Error ? err.message : 'フォルダを開けませんでした。')
    }
  }

  function exportSharedAdminSettings() {
    const includeOpenAiCompatibleBaseUrl = window.confirm('OpenAI互換 Base URL も共有設定に含めますか？\nローカルPC固有のURLや社内URLを含めたくない場合はキャンセルしてください。')
    const payload = createSharedAdminSettingsExport(adminSettings, { includeOpenAiCompatibleBaseUrl })
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'subtitle-admin-settings.shared.json'
    a.click()
    URL.revokeObjectURL(url)
    toast.success('exportAdminSettings')
  }

  async function importSharedAdminSettings(file: File | undefined) {
    if (!file) return
    try {
      const text = await file.text()
      const patch = parseSharedAdminSettingsExport(text)
      onAdminSettingsChange(patch)
      toast.success('importAdminSettings')
    } catch (error) {
      toast.error('adminSettingsImportError', { error: error instanceof Error ? error.message : String(error) })
    } finally {
      if (sharedSettingsImportRef.current) sharedSettingsImportRef.current.value = ''
    }
  }

  function duplicateResolvedApiCompatibilityProfile() {
    const source = resolvedApiCompatibilityProfile?.origin === 'builtin'
      ? resolvedApiCompatibilityProfile
      : autoResolvedApiCompatibilityProfile
    if (!source) {
      toast.error('apiCompatibilityProfileDuplicateError')
      return
    }
    const userProfile = createUserApiCompatibilityProfileFromBuiltin(source)
    onAdminSettingsChange({
      apiCompatibilityProfilePreset: 'user',
      apiCompatibilityProfileJson: formatApiCompatibilityProfileJson(userProfile),
    })
    toast.success('apiCompatibilityProfileDuplicated')
  }

  function exportApiCompatibilityProfileJson() {
    const result = validateApiCompatibilityProfileJson(adminSettings.apiCompatibilityProfileJson)
    if (!result.ok || !result.profile) {
      toast.error('apiCompatibilityProfileInvalid', { error: result.error ?? '' })
      return
    }
    const blob = new Blob([formatApiCompatibilityProfileJson(result.profile)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${result.profile.id.replace(/[^a-z0-9._-]+/gi, '_')}.json`
    a.click()
    URL.revokeObjectURL(url)
    toast.success('apiCompatibilityProfileExported')
  }

  async function importApiCompatibilityProfileJson(file: File | undefined) {
    if (!file) return
    try {
      const text = await file.text()
      const result = validateApiCompatibilityProfileJson(text)
      if (!result.ok || !result.profile) {
        toast.error('apiCompatibilityProfileInvalid', { error: result.error ?? '' })
        return
      }
      onAdminSettingsChange({
        apiCompatibilityProfilePreset: 'user',
        apiCompatibilityProfileJson: formatApiCompatibilityProfileJson(result.profile),
      })
      toast.success('apiCompatibilityProfileImported')
    } catch (error) {
      toast.error('apiCompatibilityProfileInvalid', { error: error instanceof Error ? error.message : String(error) })
    } finally {
      if (apiCompatibilityProfileImportRef.current) apiCompatibilityProfileImportRef.current.value = ''
    }
  }

  function applyNormalizationJsonDraft() {
    const result = validateTextNormalizationRulesJson(normalizationJsonDraft)
    if (!result.ok) {
      toast.error('invalidNormalizationRules', { error: result.error ?? '' })
      return
    }
    const formatted = JSON.stringify(result.config, null, 2)
    setNormalizationJsonDraft(formatted)
    onAdminSettingsChange({ textNormalizationRulesJson: formatted })
    toast.success('saveSettings')
  }

  async function importNormalizationRules(file: File | undefined) {
    if (!file) return
    const text = await file.text()
    const result = validateTextNormalizationRulesJson(text)
    if (!result.ok) {
      alert(`正規化ルールJSONが不正です。\n${result.error}`)
      return
    }
    const formatted = JSON.stringify(result.config, null, 2)
    setNormalizationJsonDraft(formatted)
    onAdminSettingsChange({ textNormalizationRulesJson: formatted })
  }

  function exportNormalizationRules() {
    const result = validateTextNormalizationRulesJson(normalizationJsonDraft)
    if (!result.ok) {
      toast.error('invalidNormalizationRules', { error: result.error ?? '' })
      return
    }
    const blob = new Blob([JSON.stringify(result.config, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'subtitle-text-normalization-rules.json'
    a.click()
    URL.revokeObjectURL(url)
    toast.success('exportJson')
  }

  function addNormalizationRule() {
    const match = normalizationMatchInput
    if (!match) {
      alert('変換元を入力してください。')
      return
    }
    const result = validateTextNormalizationRulesJson(normalizationJsonDraft)
    if (!result.ok || !result.config) {
      alert(`正規化ルールJSONが不正です。\n${result.error}`)
      return
    }
    const exists = result.config.rules.some(rule =>
      rule.match === match && rule.replacement === normalizationReplacementInput && rule.matchType === 'literal',
    )
    if (exists) {
      alert('同じ変換ルールが既にあります。')
      return
    }
    const nextRules = [
      ...result.config.rules,
      {
        enabled: true,
        match,
        replacement: normalizationReplacementInput,
        matchType: 'literal' as const,
      },
    ]
    const formatted = JSON.stringify({ version: 1, rules: nextRules }, null, 2)
    setNormalizationJsonDraft(formatted)
    onAdminSettingsChange({ textNormalizationRulesJson: formatted })
    setNormalizationMatchInput('')
    setNormalizationReplacementInput('')
  }

  function toggleNormalizationRule(index: number, enabled: boolean) {
    const config = parseTextNormalizationConfig(normalizationJsonDraft)
    const formatted = JSON.stringify({
      ...config,
      rules: config.rules.map((rule, ruleIndex) => ruleIndex === index ? { ...rule, enabled } : rule),
    }, null, 2)
    setNormalizationJsonDraft(formatted)
    onAdminSettingsChange({ textNormalizationRulesJson: formatted })
  }

  function deleteNormalizationRule(index: number) {
    const config = parseTextNormalizationConfig(normalizationJsonDraft)
    const formatted = JSON.stringify({
      ...config,
      rules: config.rules.filter((_, ruleIndex) => ruleIndex !== index),
    }, null, 2)
    setNormalizationJsonDraft(formatted)
    onAdminSettingsChange({ textNormalizationRulesJson: formatted })
  }

  function getAiGatewayProbeGuidance(item: AiGatewayProbeItem): AiGatewayProbeGuidance | null {
    if (item.status !== 'error') return null
    const message = item.message.toLowerCase()
    const actions: string[] = []

    if (item.name === 'Connection' || /failed to fetch|network|econnrefused|connection|models|http_?404/.test(message)) {
      actions.push(isLocalOpenAiProvider
        ? '接続設定の OpenAI互換 Base URL を確認してください。LM Studio は通常 http://127.0.0.1:1234/v1、Ollama は通常 http://127.0.0.1:11434/v1 です。'
        : '接続設定のAIプロバイダとAPIキーを確認してください。')
      actions.push('接続先サーバーが起動していて、/models エンドポイントを返せるか確認してください。')
    }

    if (/401|403|unauthorized|forbidden|api key|auth|permission/.test(message)) {
      actions.push('接続設定のAPIキーを確認してください。OpenAI互換サーバーでキー不要の場合は空欄にしてください。')
    }

    if (/model|not found|404|does not exist|unknown/.test(message) && item.name !== 'Connection') {
      actions.push('上級者向け設定 > モデル設定で、この用途に存在するモデルIDを指定してください。')
    }

    if (/embedding|embeddings/.test(message) || item.name === 'Embeddings') {
      actions.push('Embedding を使わないローカルサーバーの場合は、セマンティックチェックをオフまたはログのみ運用にするか、/embeddings 対応モデルを指定してください。')
    }

    if (/vision|image|unsupported/.test(message) || item.name === 'Chat Vision') {
      actions.push('PDF教材からの辞書作成を使う場合は、Vision対応モデルをPDF抽出Visionモデルに指定してください。使わない場合は通常の字幕生成には影響しません。')
    }

    if (/context_size_exceeded|context length|context size|maximum context/.test(message)) {
      actions.push('LM Studio / ローカルサーバー側で読み込むモデルの context length を増やしてください。接続チェックが通っても本番プロンプトで不足することがあります。')
    }

    if (/response_format|max_completion_tokens|max_tokens|json/.test(message)) {
      actions.push('このすぐ下の「API互換プロファイル」で API Compatibility Profile が接続先に合っているか確認してください。Auto が合わない場合は LM Studio / Ollama / User Profile を選びます。')
    }

    const uniqueActions = Array.from(new Set(actions))
    return {
      title: '確認する設定',
      actions: uniqueActions.length > 0
        ? uniqueActions
        : ['接続設定のAIプロバイダ/APIキー/Base URL/API互換プロファイル、上級者向け設定のモデルIDを順に確認してください。'],
    }
  }

  return (
    <div className="h-full overflow-y-auto" style={{ padding: 14 }}>
      <Section title="接続設定" theme={theme}>
        <FieldCard theme={theme}>
          <div style={{ fontSize: 12, fontWeight: 600, color: theme.textPrimary }}>共有設定の読み込み</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <button type="button" onClick={() => sharedSettingsImportRef.current?.click()} style={smallButtonStyle(theme)}>
              共有用JSONを読み込む
            </button>
            <input
              ref={sharedSettingsImportRef}
              type="file"
              accept=".json,application/json"
              onChange={(event) => void importSharedAdminSettings(event.target.files?.[0])}
              style={{ display: 'none' }}
            />
          </div>
          <div style={{ fontSize: 11, color: theme.textSecondary, lineHeight: 1.6 }}>
            管理者から共有用JSONを受け取っている場合は、最初にここで読み込みます。読み込み後は下のAPIキー入力と接続チェックだけで使い始められます。
          </div>
        </FieldCard>

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
            <span aria-live="polite" style={{ fontSize: 11, color: serviceCheckColor }}>
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
                placeholder={LOCAL_OPENAI_COMPAT_BASE_URL}
                onChange={(value) => onAdminSettingsChange({ openaiCompatibleBaseUrl: value })}
              />
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  onClick={() => onAdminSettingsChange({ openaiCompatibleBaseUrl: LOCAL_OPENAI_COMPAT_BASE_URL })}
                  style={smallButtonStyle(theme)}
                >
                  LM Studio
                </button>
                <button
                  type="button"
                  onClick={() => onAdminSettingsChange({ openaiCompatibleBaseUrl: LOCAL_OLLAMA_OPENAI_COMPAT_BASE_URL })}
                  style={smallButtonStyle(theme)}
                >
                  Ollama
                </button>
              </div>
              <div style={{ fontSize: 11, color: theme.textSecondary, lineHeight: 1.6 }}>
                Base URL は /v1 まで含めます。接続チェックの Connection が失敗する場合は、まずこのURLとローカルサーバーの起動状態を確認してください。
              </div>
            </>
          )}
          <div style={{ fontSize: 11, color: theme.textSecondary, lineHeight: 1.6 }}>
            {isLocalOpenAiProvider
              ? 'LM Studio・Ollama などのローカルサーバーや、Azure OpenAI・Groq などの OpenAI 互換サービスを使います。APIキーはサービス側で要求される場合のみ入力してください。'
              : '翻訳、補正、短縮、分割、文脈統合などのLLM処理に使うプロバイダとAPIキーです。入力したキーはこのPCの設定として保存されます。'}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={() => void handleAiGatewayProbe()}
              disabled={aiGatewayProbeRunning}
              style={{
                padding: '8px 12px',
                borderRadius: 8,
                border: `1px solid ${theme.panelBorder}`,
                background: theme.panelBg,
                color: theme.textPrimary,
                cursor: aiGatewayProbeRunning ? 'wait' : 'pointer',
                fontSize: 12,
                fontWeight: 600,
              }}
            >
              {aiGatewayProbeRunning ? 'Checking...' : 'AI Gateway 接続チェック'}
            </button>
            <span style={{ fontSize: 11, color: theme.textSecondary }}>
              /models、Chat Text、Embeddings、Chat Vision を個別に確認します。
            </span>
          </div>
          <div aria-live="polite">
          {aiGatewayProbeItems.length > 0 && (
            <div style={{ display: 'grid', gap: 8 }}>
              {aiGatewayProbeItems.map(item => {
                const color = item.status === 'success'
                  ? '#22c55e'
                  : item.status === 'error'
                    ? '#ef4444'
                    : theme.textSecondary
                const guidance = getAiGatewayProbeGuidance(item)
                return (
                  <div
                    key={item.name}
                    style={{
                      display: 'grid',
                      gap: 6,
                      padding: '8px 10px',
                      borderRadius: 8,
                      border: `1px solid ${theme.panelBorder}`,
                      background: theme.panelBg,
                    }}
                  >
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '92px 70px minmax(0, 1fr)',
                        gap: 8,
                        alignItems: 'center',
                        fontSize: 11,
                        color: theme.textSecondary,
                      }}
                    >
                      <span style={{ color: theme.textPrimary, fontWeight: 600 }}>{item.name}</span>
                      <span style={{ color, fontWeight: 700 }}>{item.status}</span>
                      <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{item.message}</span>
                    </div>
                    {guidance && (
                      <div style={{ display: 'grid', gap: 4, fontSize: 11, color: theme.textSecondary, lineHeight: 1.5 }}>
                        <div style={{ color: theme.textPrimary, fontWeight: 700 }}>{guidance.title}</div>
                        {guidance.actions.map(action => (
                          <div key={action}>- {action}</div>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
          </div>
          <details style={{
            border: `1px solid ${theme.panelBorder}`,
            borderRadius: 8,
            background: theme.panelBg,
            padding: '10px 12px',
          }}>
            <summary style={{ cursor: 'pointer', color: theme.textPrimary, fontSize: 12, fontWeight: 700 }}>
              API互換プロファイル（接続チェックが失敗する時）
            </summary>
            <div style={{ fontSize: 11, color: theme.textSecondary, lineHeight: 1.6, marginTop: 10 }}>
              OpenAI互換サーバーごとのAPI方言（パラメータ名・応答形式）と、モデルの能力差を吸収する設定です。AI Gateway 接続チェックが response_format / max_tokens 系のエラーで失敗する時だけ調整します。
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 12 }}>
              <ApiCompatibilityProfileSelect
                theme={theme}
                label="API Compatibility Profile"
                value={adminSettings.apiCompatibilityProfilePreset}
                onChange={(value) => onAdminSettingsChange({ apiCompatibilityProfilePreset: value })}
              />
              <div style={{
                padding: '8px 10px',
                borderRadius: 8,
                border: `1px solid ${theme.panelBorder}`,
                background: theme.cardBg,
                color: theme.textSecondary,
                fontSize: 11,
                lineHeight: 1.6,
              }}>
                <div style={{ color: theme.textPrimary, fontWeight: 700 }}>
                  Resolved: {resolvedApiCompatibilityProfile
                    ? `${resolvedApiCompatibilityProfile.id} (${resolvedApiCompatibilityProfile.label})`
                    : 'User Profile JSON が不正です'}
                </div>
                {resolvedApiCompatibilityProfile && (
                  <div>
                    tokenLimitParam: {resolvedApiCompatibilityProfile.requestDialect.chat.tokenLimitParam}
                    {' / '}
                    responseFormat: {resolvedApiCompatibilityProfile.requestDialect.chat.responseFormat}
                  </div>
                )}
                {adminSettings.apiCompatibilityProfilePreset === 'auto' && autoResolvedApiCompatibilityProfile && (
                  <div>Auto は現在 {autoResolvedApiCompatibilityProfile.id} を使用します。</div>
                )}
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button type="button" onClick={duplicateResolvedApiCompatibilityProfile} style={smallButtonStyle(theme)}>
                  Built-inをUser JSONへ複製
                </button>
                <button type="button" onClick={exportApiCompatibilityProfileJson} style={smallButtonStyle(theme)}>
                  User JSONを出力
                </button>
                <button type="button" onClick={() => apiCompatibilityProfileImportRef.current?.click()} style={smallButtonStyle(theme)}>
                  User JSONを読み込む
                </button>
                <input
                  ref={apiCompatibilityProfileImportRef}
                  type="file"
                  accept=".json,application/json"
                  onChange={(event) => void importApiCompatibilityProfileJson(event.target.files?.[0])}
                  style={{ display: 'none' }}
                />
              </div>
              <TextareaField
                theme={theme}
                label="API Compatibility User Profile JSON"
                value={adminSettings.apiCompatibilityProfileJson}
                placeholder="User Profile 選択時に使用。Built-inを複製して requestDialect を調整してください"
                onChange={(value) => onAdminSettingsChange({ apiCompatibilityProfileJson: value })}
              />
              <div style={{
                fontSize: 11,
                color: apiCompatibilityProfileValidation.ok ? '#22c55e' : '#ef4444',
                lineHeight: 1.5,
              }}>
                {adminSettings.apiCompatibilityProfileJson.trim()
                  ? apiCompatibilityProfileValidation.ok
                    ? `User Profile JSON OK: ${apiCompatibilityProfileValidation.profile?.id ?? 'unknown'}`
                    : `User Profile JSON error: ${apiCompatibilityProfileValidation.error ?? 'invalid profile'}`
                  : 'User Profile JSON は空です。Built-inを複製して外部エディタで編集できます。'}
              </div>
              <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
                <ModelProfileSelect
                  theme={theme}
                  label="Chat Text プロファイル"
                  value={adminSettings.chatTextProfilePreset}
                  onChange={(value) => onAdminSettingsChange({ chatTextProfilePreset: value })}
                />
                <ModelProfileSelect
                  theme={theme}
                  label="Chat Vision プロファイル"
                  value={adminSettings.chatVisionProfilePreset}
                  onChange={(value) => onAdminSettingsChange({ chatVisionProfilePreset: value })}
                />
                <ModelProfileSelect
                  theme={theme}
                  label="Embedding プロファイル"
                  value={adminSettings.embeddingProfilePreset}
                  onChange={(value) => onAdminSettingsChange({ embeddingProfilePreset: value })}
                />
              </div>
              <TextareaField
                theme={theme}
                label="Chat Text カスタムプロファイルJSON"
                value={adminSettings.chatTextProfileJson}
                placeholder="空欄 = プリセットまたはモデルIDから自動推定"
                onChange={(value) => onAdminSettingsChange({ chatTextProfileJson: value })}
              />
              <TextareaField
                theme={theme}
                label="Chat Vision カスタムプロファイルJSON"
                value={adminSettings.chatVisionProfileJson}
                placeholder="空欄 = プリセットまたはモデルIDから自動推定"
                onChange={(value) => onAdminSettingsChange({ chatVisionProfileJson: value })}
              />
              <TextareaField
                theme={theme}
                label="Embedding カスタムプロファイルJSON"
                value={adminSettings.embeddingProfileJson}
                placeholder="空欄 = プリセットまたはモデルIDから自動推定"
                onChange={(value) => onAdminSettingsChange({ embeddingProfileJson: value })}
              />
            </div>
          </details>
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
      </Section>

      <Section title="一般設定" theme={theme}>
        <FieldCard theme={theme}>
          <div style={{ fontSize: 12, fontWeight: 600, color: theme.textPrimary }}>{t.settingsColorTheme}</div>
          <div style={{ display: 'grid', gap: 10 }}>
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
          </div>
        </FieldCard>

        <FieldCard theme={theme}>
          <div style={{ fontSize: 12, fontWeight: 600, color: theme.textPrimary }}>{t.settingsLanguage}</div>
          <div style={{ display: 'grid', gap: 10 }}>
            {locales.map(locale => (
              <OptionCard
                key={locale.id}
                isActive={locale.id === t.id}
                onClick={() => setLocaleId(locale.id)}
                theme={theme}
              >
                <div style={{ fontSize: 18, lineHeight: 1, flexShrink: 0 }}>
                  {locale.id === 'ja' ? 'JP' : locale.id === 'en' ? 'EN' : locale.id === 'zh' ? 'ZH' : 'LANG'}
                </div>
                <div style={{ fontSize: 13, fontWeight: 600, color: theme.textPrimary }}>
                  {locale.label}
                </div>
              </OptionCard>
            ))}
          </div>
        </FieldCard>

        <FieldCard theme={theme}>
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: theme.textPrimary }}>バージョン</div>
            <div style={{ fontSize: 11, color: theme.textSecondary, marginTop: 2 }}>
              {currentVersion && currentVersion !== '0.0.0' ? currentVersion : '開発ビルド'}
            </div>
          </div>
        </FieldCard>

        <FieldCard theme={theme}>
          <div style={{ fontSize: 12, fontWeight: 600, color: theme.textPrimary }}>ワークログ（作業データ記録）</div>
          <div style={{ fontSize: 11, color: theme.textSecondary, lineHeight: 1.6 }}>
            失敗調査や作業履歴確認に使うローカル記録です。通常は既定のままで問題ありません。
          </div>
          <div style={{
            padding: '8px 10px',
            borderRadius: 8,
            border: `1px solid ${theme.panelBorder}`,
            background: theme.panelBg,
            color: theme.textSecondary,
            fontSize: 11,
            lineHeight: 1.6,
            wordBreak: 'break-all',
          }}>
            {adminSettings.workLogDir.trim() || '既定（アプリデータ領域内の worklogs フォルダ）'}
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" onClick={handlePickWorkLogDir} style={smallButtonStyle(theme)}>
              フォルダを選択
            </button>
            {adminSettings.workLogDir.trim() && (
              <button
                type="button"
                onClick={() => onAdminSettingsChange({ workLogDir: '' })}
                style={smallButtonStyle(theme)}
              >
                既定に戻す
              </button>
            )}
            <button type="button" onClick={handleOpenWorkLogDir} style={smallButtonStyle(theme)}>
              フォルダを開く
            </button>
          </div>
          <div style={{ fontSize: 11, color: theme.textSecondary, lineHeight: 1.6 }}>
            書き起こし・AI修正・手動編集の作業履歴をセッションごとの JSONL ファイルに記録します。
            保管場所を変更すると、変更後の新しいセッションから新フォルダに保存されます（過去のログは移動しません）。
            {!isWorkLogPersistent() && ' ※ブラウザ実行のため、ワークログはメモリ保持のみ（リロードで消えます）。'}
          </div>
        </FieldCard>
      </Section>

      <Section title="上級者向け設定" theme={theme}>
        <FieldCard theme={theme}>
          <div style={{ fontSize: 12, fontWeight: 600, color: theme.textPrimary }}>設定の共有</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" onClick={exportSharedAdminSettings} style={smallButtonStyle(theme)}>
              共有用JSONを出力
            </button>
          </div>
          <div style={{ fontSize: 11, color: theme.textSecondary, lineHeight: 1.6 }}>
            プロンプト、例文、モデル、プロファイル、閾値を共有します。OpenAI互換 Base URL は出力時に含めるか選択します。
            Service Auth Token、HuggingFace Token、OpenAI/Gemini APIキー、ワークログ保管場所は含めません。
            配布されたJSONは、接続設定の「共有設定の読み込み」から読み込みます。
          </div>
        </FieldCard>

        <FieldCard theme={theme}>
          <NumberField
            theme={theme}
            label="並列リクエスト数"
            value={adminSettings.apiRequestConcurrency}
            min={1}
            step={1}
            onChange={(value) => onAdminSettingsChange({ apiRequestConcurrency: Math.trunc(value) })}
          />
          <div style={{ fontSize: 11, color: theme.textSecondary, lineHeight: 1.5 }}>
            APIの並列処理上限。エラーが出る場合は下げてください。
          </div>
        </FieldCard>

        <FieldCard theme={theme}>
          <div style={{ fontSize: 12, fontWeight: 600, color: theme.textPrimary }}>モデル設定</div>
          <div style={{ fontSize: 11, color: theme.textSecondary, lineHeight: 1.5 }}>
            処理段階ごとに使うモデルを指定します。まず「モデル一覧を更新」で選択肢を取得し、各欄は入力でフィルター、▼ で一覧から選択できます。空欄の欄は記載のフォールバック先を使います。
          </div>
          <button
            onClick={handleRefreshModels}
            disabled={modelRefreshState === 'loading'}
            style={{
              alignSelf: 'flex-start',
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

          <SettingsGroupLabel
            theme={theme}
            title="基本モデル"
            hint="日本語書き起こしの補正と、英語字幕への翻訳に使う主モデルです。高品質な処理が必要な段階です。"
          />
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

          <SettingsGroupLabel
            theme={theme}
            title="字幕整形・修復モデル"
            hint="字幕の長さ調整（短縮・展開）、文脈統合、日本語分割に使います。判断が単純な処理が多く、軽量・低コストのモデルで十分です。"
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
            label={t.settingsExpandModel}
            value={adminSettings.expandModel}
            placeholder="（翻訳モデルと同じ）"
            listId="available-models-list"
            hint="空欄 = 翻訳モデルと同じ"
            onChange={(value) => onAdminSettingsChange({ expandModel: value })}
          />
          <ComboField
            theme={theme}
            label={t.settingsMicroModel}
            value={adminSettings.microModel}
            placeholder={adminSettings.translationProvider === 'gemini' ? DEFAULT_GEMINI_CHAT_MODEL : getChatModelPlaceholder('gpt-5.4-nano')}
            listId="available-models-list"
            hint="1単語ずつ削るマイクロ圧縮用。処理が極めて単純なので、軽量・低コストのモデルで十分です（default: gpt-5.4-nano）。空欄 = 圧縮モデルと同じにフォールバック"
            onChange={(value) => onAdminSettingsChange({ microModel: value })}
          />
          <ComboField
            theme={theme}
            label="文脈統合モデル (Context Merge)"
            value={adminSettings.contextMergeModel}
            placeholder={adminSettings.translationProvider === 'gemini' ? DEFAULT_GEMINI_CHAT_MODEL : getChatModelPlaceholder('gpt-5.4-mini')}
            listId="available-models-list"
            hint="文脈依存の短い断片を前後どちらに統合するか判断するモデル。前/後の二択なので、軽量なモデルで十分です"
            onChange={(value) => onAdminSettingsChange({ contextMergeModel: value })}
          />
          <ComboField
            theme={theme}
            label="日本語分割モデル (splitJa)"
            value={adminSettings.splitJaModel}
            placeholder={adminSettings.translationProvider === 'gemini' ? DEFAULT_GEMINI_CHAT_MODEL : getChatModelPlaceholder('gpt-5.4-nano')}
            listId="available-models-list"
            hint="日本語を意味単位に分割する用途。翻訳生成は不要なので、軽量・小型のモデルで十分です（default: gpt-5.4-nano）。空欄 = マイクロ圧縮モデルと同じ"
            onChange={(value) => onAdminSettingsChange({ splitJaModel: value })}
          />

          <SettingsGroupLabel
            theme={theme}
            title="検証モデル"
            hint="字幕生成ではなく、意味の近さチェックに使う Embedding モデルです。"
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

          <SettingsGroupLabel
            theme={theme}
            title="辞書生成モデル"
            hint="PDF教材から専門用語を抽出する辞書作成機能で使います。辞書作成を使わない場合は変更不要です。"
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
          <ComboField
            theme={theme}
            label="PDF数式確認モデル"
            value={adminSettings.pdfFormulaMiniModel}
            placeholder={adminSettings.translationProvider === 'gemini' ? DEFAULT_GEMINI_CHAT_MODEL : getChatModelPlaceholder(DEFAULT_OPENAI_CHAT_MODEL)}
            listId="available-models-list"
            hint="辞書作成で数式・画像文字の追加確認に使います。空欄の場合はPDF抽出Visionモデルにフォールバックします"
            onChange={(value) => onAdminSettingsChange({ pdfFormulaMiniModel: value })}
          />
          <NumberField
            theme={theme}
            label="辞書生成: 出力トークン上限 (max_tokens)"
            value={adminSettings.glossaryMaxOutputTokens}
            min={256}
            step={256}
            onChange={(value) => onAdminSettingsChange({ glossaryMaxOutputTokens: Math.trunc(value) })}
          />
          <div style={{ fontSize: 11, color: theme.textSecondary, lineHeight: 1.5 }}>
            辞書候補抽出・詳細展開で 1 リクエストあたりに生成できる最大トークン数。256〜16384。
            上限到達 (finish_reason=length) で停止する場合は増やします。
          </div>

          <SettingsGroupLabel
            theme={theme}
            title="言語ラベル"
            hint="AIへのプロンプトで使う、書き起こし（翻訳元）と字幕（翻訳先）の言語名です。どの言語からどの言語へ変換するかをモデルに伝えます。"
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
          <details style={{
            border: `1px solid ${theme.panelBorder}`,
            borderRadius: 8,
            background: theme.panelBg,
            padding: '10px 12px',
          }}>
            <summary style={{ cursor: 'pointer', color: theme.textPrimary, fontSize: 12, fontWeight: 700 }}>
              言語プロファイルJSON（英日以外の言語構成）
            </summary>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 12 }}>
              <TextareaField
                theme={theme}
                label="言語プロファイルJSON"
                value={adminSettings.languageProfileConfigJson}
                placeholder='{"subtitle":{"label":"English","script":"latin"},"transcript":{"label":"Japanese","script":"japanese"}}'
                onChange={(value) => onAdminSettingsChange({ languageProfileConfigJson: value })}
              />
              <div style={{ fontSize: 11, color: theme.textSecondary, lineHeight: 1.6 }}>
                上の言語ラベルより細かく、文字種（script）や文末パターンを指定します。既定の英日構成では空欄のままで構いません。
              </div>
            </div>
          </details>
        </FieldCard>

        <SettingsGroupLabel
          theme={theme}
          title="字幕品質・修復"
          hint="字幕の品質基準（行長・CPS・表示時間など）と、違反を自動修復するエージェントの設定です。チームの共有設定として配布する値です。"
        />
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

        <FieldCard theme={theme}>
          <div style={{ fontSize: 12, fontWeight: 600, color: theme.textPrimary }}>カバレッジ修復エージェント</div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              type="checkbox"
              checked={adminSettings.coverageRepairEnabled}
              onChange={(e) => onAdminSettingsChange({ coverageRepairEnabled: e.target.checked })}
            />
            <span style={{ fontSize: 12, color: theme.textPrimary }}>
              coverage_repair_agent を有効化
            </span>
          </label>
          <div style={{ fontSize: 11, color: theme.textSecondary, lineHeight: 1.6 }}>
            ON: ルールベース後の coverage 違反（source_text_undercovered）を mini + reasoning で自動修復。
            1 chunk あたり 1 回・改善しない場合は revert（コスト 0.02 USD 程度／発動）。
            OFF: coverage 違反は次段 general_repair か manual_review に流れる（API 呼出なし）。
          </div>
          <ComboField
            theme={theme}
            label="coverage_repair モデル"
            value={adminSettings.coverageRepairModel}
            placeholder={getChatModelPlaceholder('gpt-5.4-mini')}
            listId="available-models-list"
            hint="空欄 = 圧縮モデルにフォールバック。default: gpt-5.4-mini"
            onChange={(value) => onAdminSettingsChange({ coverageRepairModel: value })}
          />
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: theme.textPrimary }}>coverage_repair reasoning effort</span>
            <select
              value={adminSettings.coverageRepairEffort}
              onChange={(e) => onAdminSettingsChange({ coverageRepairEffort: e.target.value as 'minimal' | 'low' | 'medium' | 'high' })}
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
              <option value="minimal">minimal（最小）</option>
              <option value="low">low（推奨・default）</option>
              <option value="medium">medium</option>
              <option value="high">high（高コスト）</option>
            </select>
          </label>
        </FieldCard>

        <FieldCard theme={theme}>
          <div style={{ fontSize: 12, fontWeight: 600, color: theme.textPrimary }}>汎用修復エージェント（最終救済）</div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              type="checkbox"
              checked={adminSettings.generalRepairEnabled}
              onChange={(e) => onAdminSettingsChange({ generalRepairEnabled: e.target.checked })}
            />
            <span style={{ fontSize: 12, color: theme.textPrimary }}>
              general_repair_agent を有効化（エスカレーション）
            </span>
          </label>
          <div style={{ fontSize: 11, color: theme.textSecondary, lineHeight: 1.6 }}>
            ON: ここまでで救えなかった block 違反 + coverage 残存違反を mini + reasoning で段階的エスカレーション修復。
            各 effort で改善した時点で脱出、全失敗時のみ manual_review に確定（=「PoC でも解けない真の難ケース」のみ）。
            発動率 ~5%、コスト目安 0.02-0.06 USD/発動。
            OFF: 残違反は即 manual_review。
          </div>
          <ComboField
            theme={theme}
            label="general_repair モデル"
            value={adminSettings.generalRepairModel}
            placeholder={getChatModelPlaceholder('gpt-5.4-mini')}
            listId="available-models-list"
            hint="空欄 = 圧縮モデルにフォールバック。default: gpt-5.4-mini"
            onChange={(value) => onAdminSettingsChange({ generalRepairModel: value })}
          />
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: theme.textPrimary }}>エスカレーション上限</span>
            <select
              value={adminSettings.generalRepairMaxEffort}
              onChange={(e) => onAdminSettingsChange({ generalRepairMaxEffort: e.target.value as 'low' | 'medium' | 'high' })}
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
              <option value="low">low（1 段だけ）</option>
              <option value="medium">medium（low → medium）</option>
              <option value="high">high（現在は medium 相当に制限）</option>
            </select>
          </label>
        </FieldCard>

        <FieldCard theme={theme}>
          <details>
            <summary style={{ cursor: 'pointer', color: theme.textPrimary, fontSize: 12, fontWeight: 700 }}>
              診断設定: デバッグモード
            </summary>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 12 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              type="checkbox"
              checked={adminSettings.debugModeEnabled}
              onChange={(e) => onAdminSettingsChange({ debugModeEnabled: e.target.checked })}
            />
            <span style={{ fontSize: 12, fontWeight: 600, color: theme.textPrimary }}>デバッグモード ON</span>
          </label>
          <div style={{ fontSize: 11, color: theme.textSecondary, lineHeight: 1.6 }}>
            マスタースイッチ。OFF の間はサブ機能を ON にしても全部スルーされる（コスト 0）。
            実運用では OFF、調査時のみ ON にする。
          </div>

          <div style={{
            marginTop: 8,
            paddingLeft: 12,
            borderLeft: `2px solid ${theme.panelBorder}`,
            opacity: adminSettings.debugModeEnabled ? 1 : 0.5,
          }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: theme.textSecondary, marginBottom: 6 }}>
              サブ機能
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                type="checkbox"
                checked={adminSettings.correctionDebugEmbedding}
                disabled={!adminSettings.debugModeEnabled}
                onChange={(e) => onAdminSettingsChange({ correctionDebugEmbedding: e.target.checked })}
              />
              <span style={{ fontSize: 12, color: theme.textPrimary }}>
                correctJa 効果計測（Embedding 類似度）
              </span>
            </label>
            <div style={{ fontSize: 11, color: theme.textSecondary, lineHeight: 1.6, marginTop: 4 }}>
              correctJa の前後で書き起こしを Embedding 比較し、補正の意味変動を pipeline trace に記録。
              専門用語や数式の補正があった箇所は類似度が下がる（0.85-0.95 程度）。
              <br />※ デバッグモード OFF の間は機能しない。
            </div>
          </div>
            </div>
          </details>
        </FieldCard>

        <FieldCard theme={theme}>
          <button
            type="button"
            onClick={() => setNormalizationOpen(value => !value)}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 10,
              width: '100%',
              padding: 0,
              border: 0,
              background: 'transparent',
              color: theme.textPrimary,
              cursor: 'pointer',
              textAlign: 'left',
            }}
          >
            <span style={{ fontSize: 12, fontWeight: 700 }}>字幕テキスト正規化</span>
            <span style={{ fontSize: 11, color: theme.textSecondary }}>
              {adminSettings.textNormalizationEnabled ? `ON / ${activeNormalizationRuleCount}件` : 'OFF'} {normalizationOpen ? '▲' : '▼'}
            </span>
          </button>
          <ToggleField
            theme={theme}
            label="字幕テキスト正規化を有効にする"
            checked={adminSettings.textNormalizationEnabled}
            hint="自動生成の字幕ブロック出力前と、SRT出力時に同じルールを適用します。"
            onChange={(value) => onAdminSettingsChange({ textNormalizationEnabled: value })}
          />
          {normalizationOpen && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(120px, 1fr) minmax(120px, 1fr) auto', gap: 8, alignItems: 'end' }}>
                <Field
                  theme={theme}
                  label="変換元"
                  value={normalizationMatchInput}
                  placeholder="例: “"
                  onChange={setNormalizationMatchInput}
                />
                <Field
                  theme={theme}
                  label="変換先"
                  value={normalizationReplacementInput}
                  placeholder='例: "'
                  onChange={setNormalizationReplacementInput}
                />
                <button type="button" onClick={addNormalizationRule} style={{ ...smallButtonStyle(theme), minHeight: 34 }}>
                  追加
                </button>
              </div>

              {normalizationValidation.ok && normalizationValidation.config ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {normalizationValidation.config.rules.map((rule, index) => (
                    <div
                      key={`${index}-${rule.match}-${rule.replacement}-${rule.matchType}`}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: 'auto minmax(80px, 1fr) auto minmax(80px, 1fr) auto',
                        gap: 8,
                        alignItems: 'center',
                        padding: 8,
                        border: `1px solid ${theme.panelBorder}`,
                        borderRadius: 8,
                        background: theme.panelBg,
                        fontSize: 12,
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={rule.enabled}
                        onChange={(event) => toggleNormalizationRule(index, event.target.checked)}
                      />
                      <code style={{ color: theme.textPrimary, overflowWrap: 'anywhere' }}>{JSON.stringify(rule.match)}</code>
                      <span style={{ color: theme.textSecondary }}>→</span>
                      <code style={{ color: theme.textPrimary, overflowWrap: 'anywhere' }}>{JSON.stringify(rule.replacement)}</code>
                      <button
                        type="button"
                        onClick={() => deleteNormalizationRule(index)}
                        style={{
                          padding: '5px 8px',
                          borderRadius: 6,
                          border: `1px solid ${theme.panelBorder}`,
                          background: theme.cardBg,
                          color: theme.textSecondary,
                          cursor: 'pointer',
                          fontSize: 11,
                        }}
                      >
                        削除
                      </button>
                      <div style={{ gridColumn: '2 / -1', color: theme.textSecondary, fontSize: 11 }}>
                        {rule.matchType === 'regex' ? 'regex' : 'literal'}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{ color: '#ef4444', fontSize: 12, lineHeight: 1.6 }}>
                  JSONが不正です: {normalizationValidation.error}
                </div>
              )}

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <TextareaField
                  theme={theme}
                  label="プレビュー入力（自由入力）"
                  value={normalizationPreview}
                  placeholder="ここに任意の字幕テキストを入力"
                  onChange={setNormalizationPreview}
                />
                <TextareaField
                  theme={theme}
                  label="プレビュー出力"
                  value={normalizationPreviewOutput}
                  onChange={() => undefined}
                />
              </div>

              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button type="button" onClick={exportNormalizationRules} style={smallButtonStyle(theme)}>JSONエクスポート</button>
                <label style={smallButtonStyle(theme)}>
                  JSONインポート
                  <input
                    type="file"
                    accept="application/json,.json"
                    onChange={(event) => {
                      void importNormalizationRules(event.target.files?.[0])
                      event.target.value = ''
                    }}
                    style={{ display: 'none' }}
                  />
                </label>
              </div>

              <TextareaField
                theme={theme}
                label="ルールJSON"
                value={normalizationJsonDraft}
                onChange={setNormalizationJsonDraft}
              />
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <button type="button" onClick={applyNormalizationJsonDraft} style={smallButtonStyle(theme)}>JSONを検証して保存</button>
                <span style={{ fontSize: 11, color: normalizationValidation.ok ? theme.textSecondary : '#ef4444' }}>
                  {normalizationValidation.ok ? 'JSONは有効です' : normalizationValidation.error}
                </span>
              </div>
            </div>
          )}
        </FieldCard>

        <SettingsGroupLabel
          theme={theme}
          title="字幕の自動分割・結合（表示時間）"
          hint="自動処理が字幕を分割・結合する秒数のしきい値です。長い字幕は分割、短い字幕は前後と結合します。"
        />
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
        <SettingsGroupLabel
          theme={theme}
          title="字幕の自動調整（文字量・速度）"
          hint="英訳の文字量や読む速さを判定し、短縮・展開する基準です。英日文字比やCPSのしきい値で制御します。"
        />
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
        <SettingsGroupLabel
          theme={theme}
          title="自動修正のリトライ上限"
          hint="1ブロックを基準に合わせるための、短縮・展開の最大試行回数です。"
        />
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
        </FieldCard>

        <SettingsGroupLabel
          theme={theme}
          title="未完結な文の結合（前処理）"
          hint="文の途中で切れた字幕を次の字幕と結合してから翻訳し、英訳のあふれやCPS違反を防ぎます。"
        />
        <FieldCard theme={theme}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              type="checkbox"
              checked={adminSettings.pipelineMergeContinuationEnabled}
              onChange={(e) => onAdminSettingsChange({ pipelineMergeContinuationEnabled: e.target.checked })}
            />
            <span style={{ fontSize: 12, color: theme.textPrimary }}>
              {t.settingsPipelineMergeContinuationEnabled}
            </span>
          </label>
          <div style={{ fontSize: 11, color: theme.textSecondary, lineHeight: 1.6 }}>
            semanticSplitJa が継続助詞で切ったブロックを nano LLM で検出し、次ブロックと結合してから翻訳する。
            translateEn のオーバーフローと CPS 違反を未然に防ぐ。多言語対応のため判定は LLM 側で行う。
          </div>
          <NumberField
            theme={theme}
            label={t.settingsPipelineMergeContinuationMaxGapSec}
            value={adminSettings.pipelineMergeContinuationMaxGapSec}
            min={0}
            step={0.1}
            onChange={(value) => onAdminSettingsChange({ pipelineMergeContinuationMaxGapSec: value })}
          />
          <NumberField
            theme={theme}
            label={t.settingsPipelineMergeContinuationMaxDurationSec}
            value={adminSettings.pipelineMergeContinuationMaxDurationSec}
            min={1}
            step={0.5}
            onChange={(value) => onAdminSettingsChange({ pipelineMergeContinuationMaxDurationSec: value })}
          />
          <NumberField
            theme={theme}
            label={t.settingsPipelineMergeContinuationMaxTranscriptChars}
            value={adminSettings.pipelineMergeContinuationMaxTranscriptChars}
            min={1}
            onChange={(value) => onAdminSettingsChange({ pipelineMergeContinuationMaxTranscriptChars: value })}
          />
          <ComboField
            theme={theme}
            label={t.settingsIncompleteEndDetectionModel}
            value={adminSettings.incompleteEndDetectionModel}
            placeholder={getChatModelPlaceholder('gpt-5.4-nano')}
            listId="available-models-list"
            hint="未完結末尾の判定モデル。バッチ + 並列で高速判定。default: gpt-5.4-nano"
            onChange={(value) => onAdminSettingsChange({ incompleteEndDetectionModel: value })}
          />
          <NumberField
            theme={theme}
            label={t.settingsIncompleteEndDetectionBatchSize}
            value={adminSettings.incompleteEndDetectionBatchSize}
            min={1}
            onChange={(value) => onAdminSettingsChange({ incompleteEndDetectionBatchSize: value })}
          />
        </FieldCard>
        <FieldCard theme={theme}>
          <details>
            <summary style={{ cursor: 'pointer', color: theme.textPrimary, fontSize: 12, fontWeight: 700 }}>
プロンプト / few-shot 上書き
            </summary>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 12 }}>
              <TextareaField
                theme={theme}
                label="書き起こし補正 追加指示"
                value={adminSettings.correctionAdditionalInstructions}
                placeholder="空欄にすると追加指示なし"
                onChange={(value) => onAdminSettingsChange({ correctionAdditionalInstructions: value })}
              />
              <TextareaField
                theme={theme}
                label="書き起こし補正 例文JSON"
                value={adminSettings.correctionFewShotJson}
                placeholder='{"segments":[{"id":1,"text":"..."}],"corrections":[{"id":1,"text":"..."}]}'
                onChange={(value) => onAdminSettingsChange({ correctionFewShotJson: value })}
              />
              <TextareaField
                theme={theme}
                label="翻訳 追加指示"
                value={adminSettings.translationAdditionalInstructions}
                placeholder="空欄にすると追加指示なし"
                onChange={(value) => onAdminSettingsChange({ translationAdditionalInstructions: value })}
              />
              <TextareaField
                theme={theme}
                label="翻訳 例文JSON"
                value={adminSettings.translationFewShotJson}
                placeholder='{"segments":["..."],"translations":["..."]}'
                onChange={(value) => onAdminSettingsChange({ translationFewShotJson: value })}
              />
              <div style={{ borderTop: `1px solid ${theme.panelBorder}`, paddingTop: 12 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: '#ef4444' }}>完全上書き（注意）</div>
                <div style={{ fontSize: 11, color: theme.textSecondary, lineHeight: 1.6, marginTop: 4 }}>
                  以下の2欄はデフォルトプロンプトを完全に置き換えます。CPS・行長・行数・専門用語保持などの制約も自分で明示する必要があります。検証時以外は空欄のままにしてください。
                </div>
              </div>
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
            </div>
          </details>
        </FieldCard>

        <div style={{ fontSize: 11, color: theme.textSecondary, lineHeight: 1.6 }}>
          {t.settingsStorageNotice}
        </div>
      </Section>
    </div>
  )
}

function Section({ title, theme, children }: { title: string; theme: Theme; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 24 }}>
      <h3 style={{
        fontSize: 11, fontWeight: 700, color: theme.textSecondary,
        letterSpacing: '0.5px', margin: '0 0 12px 0',
      }}>
        {title}
      </h3>
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

function SettingsGroupLabel({ theme, title, hint }: { theme: Theme; title: string; hint?: string }) {
  return (
    <div style={{ marginTop: 4 }}>
      <h4 style={{ fontSize: 12, fontWeight: 700, color: theme.textPrimary, margin: 0 }}>{title}</h4>
      {hint && (
        <div style={{ fontSize: 11, color: theme.textSecondary, lineHeight: 1.5, marginTop: 2 }}>{hint}</div>
      )}
    </div>
  )
}

function smallButtonStyle(theme: Theme): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '7px 10px',
    borderRadius: 8,
    border: `1px solid ${theme.panelBorder}`,
    background: theme.panelBg,
    color: theme.textPrimary,
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 600,
  }
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

function ModelProfileSelect({
  theme,
  label,
  value,
  onChange,
}: {
  theme: Theme
  label: string
  value: ModelProfilePresetId
  onChange: (value: ModelProfilePresetId) => void
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{ fontSize: 12, fontWeight: 600, color: theme.textPrimary }}>{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as ModelProfilePresetId)}
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
        {modelProfilePresetOptions.map(option => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
    </label>
  )
}

function ApiCompatibilityProfileSelect({
  theme,
  label,
  value,
  onChange,
}: {
  theme: Theme
  label: string
  value: ApiCompatibilityProfilePresetId
  onChange: (value: ApiCompatibilityProfilePresetId) => void
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{ fontSize: 12, fontWeight: 600, color: theme.textPrimary }}>{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as ApiCompatibilityProfilePresetId)}
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
        {apiCompatibilityProfilePresetOptions.map(option => (
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
