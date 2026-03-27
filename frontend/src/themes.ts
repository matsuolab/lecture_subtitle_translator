export type ThemeId = 'poc' | 'matsuo'

export interface Theme {
  id: ThemeId
  label: string
  // App layout
  appBg: string
  panelBg: string
  panelBorder: string
  headerBg: string
  // Typography
  textPrimary: string
  textSecondary: string
  textMuted: string
  textJapanese: string
  textDisabled: string
  textAccentLink: string
  // Accent
  accent: string
  // Cards
  cardBg: string
  cardBgActive: string
  cardBgApproved: string
  cardBgDragOver: string
  cardBorder: string
  cardBorderActive: string
  cardBorderApproved: string
  cardBorderDragOver: string
  cardShadowActive: string
  cardShadowDragOver: string
  // Inputs
  inputBg: string
  inputBorder: string
  inputBorderFocus: string
  inputText: string
  // Buttons
  btnBg: string
  btnBorder: string
  btnText: string
  btnBgApproved: string
  btnBorderApproved: string
  btnTextApproved: string
  // Progress bar
  progressBg: string
  progressCompleteBg: string
  // CPS badges [bg, text]
  cpsBadgeOk: [string, string]
  cpsBadgeWarn: [string, string]
  cpsBadgeError: [string, string]
  overCountColor: string
  // Boundary handle / gap
  handleLine: string
  handleLineActive: string
  handleLineDragging: string
  handleTooltipBg: string
  handleTooltipBorder: string
  handleTooltipText: string
  handleTooltipDraggingColor: string
  gapLabelColor: string
  gapLabelActiveColor: string
  // Balloon tooltip
  balloonBg: string
  balloonBorder: string
  balloonText: string
  balloonTextSecondary: string
  // Video player
  videoControlsBg: string
  videoProgressTrack: string
  videoProgressFill: string
  videoBtnBg: string
  videoBtnBorder: string
  videoIconColor: string
  videoTimeColor: string
  videoSubtitleProgressColor: string
  // Glossary
  glossaryCardBgConfirmed: string
  glossaryCardBorderConfirmed: string
  glossaryCardBgDefault: string
  glossaryCardBorderDefault: string
  glossaryEnTermColor: string
  glossaryBadgeConfirmedBg: string
  glossaryBadgeUnconfirmedBg: string
  glossaryBadgeText: string
  glossaryLinkColor: string
  glossaryUnregisteredBorder: string
  glossaryUnregisteredBg: string
  glossaryUnregisteredBadgeBg: string
  // Misc
  restoreBg: string
  restoreBorder: string
  restoreText: string
  savingColor: string
  savedColor: string
}

export const pocTheme: Theme = {
  id: 'poc',
  label: 'PoC カラー',
  appBg: 'linear-gradient(180deg, #0a1020 0%, #0f172a 100%)',
  panelBg: 'rgba(18,26,43,0.94)',
  panelBorder: '#2a3550',
  headerBg: 'rgba(255,255,255,0.02)',
  textPrimary: '#e7edf8',
  textSecondary: '#9aa9c2',
  textMuted: '#4a6080',
  textJapanese: '#9ba7bb',
  textDisabled: '#3d4f75',
  textAccentLink: '#7fb3ff',
  accent: '#4a90ff',
  cardBg: 'rgba(255,255,255,0.02)',
  cardBgActive: 'rgba(74,144,255,0.10)',
  cardBgApproved: 'rgba(46,204,113,0.06)',
  cardBgDragOver: 'rgba(241,196,15,0.10)',
  cardBorder: '#2a3550',
  cardBorderActive: '#4a90ff',
  cardBorderApproved: '#2d8a52',
  cardBorderDragOver: '#f1c40f',
  cardShadowActive: 'inset 0 0 0 1px rgba(74,144,255,0.35)',
  cardShadowDragOver: '0 0 0 2px rgba(241,196,15,0.5)',
  inputBg: '#0d1527',
  inputBorder: '#314062',
  inputBorderFocus: '#4a90ff',
  inputText: '#e7edf8',
  btnBg: '#1f2a43',
  btnBorder: '#3d4f75',
  btnText: '#e7edf8',
  btnBgApproved: '#2ecc71',
  btnBorderApproved: '#27ae60',
  btnTextApproved: '#08131f',
  progressBg: 'rgba(94,164,255,0.10)',
  progressCompleteBg: 'rgba(46,204,113,0.07)',
  cpsBadgeOk: ['#2ecc71', '#08131f'],
  cpsBadgeWarn: ['#f1c40f', '#08131f'],
  cpsBadgeError: ['#e74c3c', '#fff'],
  overCountColor: '#e74c3c',
  handleLine: '#2a3550',
  handleLineActive: '#4a6080',
  handleLineDragging: '#f1c40f',
  handleTooltipBg: '#1a2338',
  handleTooltipBorder: '#3d5078',
  handleTooltipText: '#4a6080',
  handleTooltipDraggingColor: '#f1c40f',
  gapLabelColor: '#3d5070',
  gapLabelActiveColor: '#7a9abf',
  balloonBg: '#1e2d4a',
  balloonBorder: '#4a90ff',
  balloonText: '#e7edf8',
  balloonTextSecondary: '#9aa9c2',
  videoControlsBg: 'rgba(18,26,43,0.94)',
  videoProgressTrack: '#2a3550',
  videoProgressFill: '#4a90ff',
  videoBtnBg: '#1a2338',
  videoBtnBorder: '#2a3550',
  videoIconColor: '#e7edf8',
  videoTimeColor: '#9aa9c2',
  videoSubtitleProgressColor: '#5ea4ff',
  glossaryCardBgConfirmed: 'rgba(46,204,113,0.06)',
  glossaryCardBorderConfirmed: '#2d8a52',
  glossaryCardBgDefault: 'rgba(255,255,255,0.02)',
  glossaryCardBorderDefault: '#2a3550',
  glossaryEnTermColor: '#7fb3ff',
  glossaryBadgeConfirmedBg: '#2ecc71',
  glossaryBadgeUnconfirmedBg: '#f1c40f',
  glossaryBadgeText: '#08131f',
  glossaryLinkColor: '#4a90ff',
  glossaryUnregisteredBorder: '#e74c3c',
  glossaryUnregisteredBg: 'rgba(231,76,60,0.05)',
  glossaryUnregisteredBadgeBg: '#e74c3c',
  restoreBg: '#1a2d1a',
  restoreBorder: '#2d5a3a',
  restoreText: '#4caf6e',
  savingColor: '#4a6080',
  savedColor: '#2d5a3a',
}

export const matsuoTheme: Theme = {
  id: 'matsuo',
  label: '松尾研カラー',
  appBg: '#eef0f4',
  panelBg: '#ffffff',
  panelBorder: '#d8dce6',
  headerBg: '#f5f6f9',
  textPrimary: '#1c2130',
  textSecondary: '#56637a',
  textMuted: '#8a95a8',
  textJapanese: '#6b7685',
  textDisabled: '#b0b8c8',
  textAccentLink: '#003f88',
  accent: '#003f88',
  cardBg: '#f8f9fc',
  cardBgActive: 'rgba(0,63,136,0.06)',
  cardBgApproved: 'rgba(0,80,50,0.05)',
  cardBgDragOver: 'rgba(160,120,0,0.08)',
  cardBorder: '#d8dce6',
  cardBorderActive: '#003f88',
  cardBorderApproved: '#1a7a50',
  cardBorderDragOver: '#b89000',
  cardShadowActive: 'inset 0 0 0 1px rgba(0,63,136,0.15)',
  cardShadowDragOver: '0 0 0 2px rgba(184,144,0,0.35)',
  inputBg: '#ffffff',
  inputBorder: '#c0c6d4',
  inputBorderFocus: '#003f88',
  inputText: '#1c2130',
  btnBg: '#f0f2f7',
  btnBorder: '#c0c6d4',
  btnText: '#344060',
  btnBgApproved: '#003f88',
  btnBorderApproved: '#002d66',
  btnTextApproved: '#ffffff',
  progressBg: 'rgba(0,63,136,0.07)',
  progressCompleteBg: 'rgba(0,100,60,0.06)',
  cpsBadgeOk: ['#27ae60', '#fff'],
  cpsBadgeWarn: ['#e67e22', '#fff'],
  cpsBadgeError: ['#c0392b', '#fff'],
  overCountColor: '#c0392b',
  handleLine: '#d0d4de',
  handleLineActive: '#8a95a8',
  handleLineDragging: '#b89000',
  handleTooltipBg: '#f0f2f7',
  handleTooltipBorder: '#c0c6d4',
  handleTooltipText: '#8a95a8',
  handleTooltipDraggingColor: '#8a7000',
  gapLabelColor: '#9aa3b0',
  gapLabelActiveColor: '#56637a',
  balloonBg: '#1c2130',
  balloonBorder: '#003f88',
  balloonText: '#eef0f4',
  balloonTextSecondary: '#8a95a8',
  videoControlsBg: '#1c2130',
  videoProgressTrack: '#3a4255',
  videoProgressFill: '#003f88',
  videoBtnBg: '#2c3448',
  videoBtnBorder: '#3a4255',
  videoIconColor: '#e0e4f0',
  videoTimeColor: '#8a95a8',
  videoSubtitleProgressColor: '#5580b8',
  glossaryCardBgConfirmed: 'rgba(0,63,136,0.05)',
  glossaryCardBorderConfirmed: '#1a7a50',
  glossaryCardBgDefault: '#f8f9fc',
  glossaryCardBorderDefault: '#d8dce6',
  glossaryEnTermColor: '#003f88',
  glossaryBadgeConfirmedBg: '#27ae60',
  glossaryBadgeUnconfirmedBg: '#e67e22',
  glossaryBadgeText: '#fff',
  glossaryLinkColor: '#003f88',
  glossaryUnregisteredBorder: '#c0392b',
  glossaryUnregisteredBg: 'rgba(192,57,43,0.04)',
  glossaryUnregisteredBadgeBg: '#c0392b',
  restoreBg: '#e8f0fa',
  restoreBorder: '#003f88',
  restoreText: '#003f88',
  savingColor: '#8a95a8',
  savedColor: '#1a7a50',
}

export const themes: Theme[] = [pocTheme, matsuoTheme]
export const defaultTheme = pocTheme
