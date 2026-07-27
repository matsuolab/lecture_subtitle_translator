export type ToastMessageParams = Record<string, number | string>

export type ToastMessage = string | ((params: ToastMessageParams) => string)

export interface LocaleStrings {
  id: string
  label: string
  toast: {
    exportSrt: ToastMessage
    saveProjectJson: ToastMessage
    exportCsv: ToastMessage
    exportJson: ToastMessage
    exportAdminSettings: ToastMessage
    exportGlossaryLog: ToastMessage
    importGlossary: ToastMessage
    importAdminSettings: ToastMessage
    saveSettings: ToastMessage
    invalidNormalizationRules: ToastMessage
    unsupportedGlossaryFile: ToastMessage
    glossaryImportError: ToastMessage
    adminSettingsImportError: ToastMessage
    spellCheckFound: ToastMessage
    spellWordAdded: ToastMessage
    apiCompatibilityProfileDuplicated: ToastMessage
    apiCompatibilityProfileDuplicateError: ToastMessage
    apiCompatibilityProfileExported: ToastMessage
    apiCompatibilityProfileImported: ToastMessage
    apiCompatibilityProfileInvalid: ToastMessage
  }

  videoPlayer: string
  tabSubtitles: string
  tabDictionary: string
  tabHelp: string
  tabReport: string
  saving: string
  saved: string
  loadProject: string
  saveProject: string
  exportSrt: string
  loadProjectTitle: string
  saveProjectTitle: string
  exportSrtTitle: string
  srtFormatLabel: string
  srtFormatSource: string
  srtFormatTarget: string
  srtFormatBoth: string
  srtFormatSelectTitle: string
  restored: string
  videoLoadChoiceTitle: string
  videoLoadChoiceDesc: (name: string, count: number) => string
  videoLoadReset: string
  videoLoadKeep: string
  videoLoadCancel: string
  approvedCount: (approved: number, total: number) => string
  reSplitAlert: (id: number) => string
  reTranslateAlert: (id: number) => string
  importError: string
  loadSrt: string
  loadSrtTitle: string
  importSrtError: string

  approve: string
  approvedBtn: string
  flag: string
  flaggedBtn: string
  reSplit: string
  reTranslate: string
  editHint: string
  charCount: (lineLengths: number[], isOver: boolean) => string
  timeErrorFormat: string
  timeErrorStartNeg: string
  timeErrorOrder: string
  timeEditTitle: string

  gapLabel: (seconds: number) => string
  gapDragHint: string
  boundaryDragging: string
  boundaryHover: string

  registeredTerms: (n: number) => string
  unregisteredTerms: (n: number) => string
  confirmed: string
  unconfirmed: string
  unregistered: string
  source: string
  requestConfirmation: string
  confirmedBtn: string
  addToDictionary: string
  noDesc: string

  guide: Array<{
    title: string
    paragraphs: string[]
  }>
  shortcuts: Array<{
    category: string
    items: Array<{ keys: string[]; desc: string }>
  }>
  shortcutsTitle: string
  aiAskTitle: string
  aiAskDesc: string

  reportReviewQueue: string
  reportReviewQueueEmpty: string
  reportNodeTraceCount: (n: number) => string
  reportSummary: string
  reportRecentRuns: string
  reportEmpty: string
  reportTotalRuns: string
  reportSuccessRate: string
  reportAvgCost: string
  reportAvgDuration: string
  reportColSource: string
  reportColStatus: string
  reportColFinishedAt: string
  reportColCost: string
  reportColDuration: string
  reportColQuality: string
  reportStatusSuccess: string
  reportStatusError: string
  reportStatusRunning: string
  reportStatusIdle: string

  settingsColorTheme: string
  settingsLanguage: string
  settingsAdminTitle: string
  settingsPipelineApiUrl: string
  settingsPipelineApiUrlPlaceholder: string
  settingsHfToken: string
  settingsHfTokenPlaceholder: string
  settingsTranslatorProvider: string
  settingsTranslatorProviderOpenAi: string
  settingsTranslatorProviderGemini: string
  settingsTranslatorProviderLocalOpenAi: string
  settingsOpenAiApiKey: string
  settingsLocalOpenAiApiKey: string
  settingsGeminiApiKey: string
  settingsOpenAiBaseUrl: string
  settingsOpenAiBaseUrlPlaceholder: string
  settingsStorageNotice: string
  settingsResetAdmin: string
  pocThemeDesc: string
  matsuoThemeDesc: string
  settingsSubtitleQualityTitle: string
  settingsEnMaxCharsPerLine: string
  settingsEnMaxLines: string
  settingsEnMaxCps: string
  settingsSubtitleMinDuration: string
  settingsQualityCorrectionThreshold: string
  settingsPipelineThresholdsTitle: string
  settingsPipelineShortDurationSec: string
  settingsPipelineLongDurationSec: string
  settingsPipelineMergedLongDurationSec: string
  settingsPipelineVerboseEnRatio: string
  settingsPipelineOverCompressedRatio: string
  settingsPipelineOverCompressedJaChars: string
  settingsPipelineSlowCps: string
  settingsPipelineMaxExpandPerBlock: string
  settingsPipelineMaxCompressPerBlock: string
  settingsPipelineMergeContinuationEnabled: string
  settingsPipelineMergeContinuationMaxGapSec: string
  settingsPipelineMergeContinuationMaxDurationSec: string
  settingsPipelineMergeContinuationMaxTranscriptChars: string
  settingsIncompleteEndDetectionModel: string
  settingsIncompleteEndDetectionBatchSize: string
  settingsLlmRequestTimeoutSec: string
  settingsCompressModel: string
  settingsMicroModel: string
  settingsExpandModel: string
  settingsCompressPromptOverride: string
  settingsExpandPromptOverride: string
  settingsRefreshModels: string
  settingsRefreshModelsLoading: string
  settingsRefreshModelsError: string
  settingsSemanticCheckTitle: string
  settingsSemanticCheckMode: string
  settingsSemanticCheckOff: string
  settingsSemanticCheckLogOnly: string
  settingsSemanticCheckEnforce: string
  settingsSemanticCheckDesc: string
}
