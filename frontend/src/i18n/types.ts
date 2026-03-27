export interface LocaleStrings {
  // メタ
  id: string
  label: string  // 表示名（日本語, English, ...）

  // アプリシェル
  videoPlayer: string
  tabSubtitles: string
  tabDictionary: string
  tabHelp: string
  saving: string
  saved: string
  loadProject: string
  saveProject: string
  exportSrt: string
  loadProjectTitle: string
  saveProjectTitle: string
  exportSrtTitle: string
  restored: string
  approvedCount: (approved: number, total: number) => string
  reSplitAlert: (id: number) => string
  reTranslateAlert: (id: number) => string
  importError: string

  // SubtitleBlock
  approve: string
  approvedBtn: string
  reSplit: string
  reTranslate: string
  editHint: string
  charCount: (lineLengths: number[], isOver: boolean) => string
  timeErrorFormat: string
  timeErrorStartNeg: string
  timeErrorOrder: string
  timeEditTitle: string

  // SubtitleBlockList
  gapLabel: (seconds: number) => string
  gapDragHint: string
  boundaryDragging: string
  boundaryHover: string

  // GlossaryTab
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

  // HelpTab
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

  // SettingsTab
  settingsColorTheme: string
  settingsLanguage: string
  pocThemeDesc: string
  matsuoThemeDesc: string
}
