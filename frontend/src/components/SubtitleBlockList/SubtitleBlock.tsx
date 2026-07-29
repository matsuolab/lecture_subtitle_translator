import { useState, useRef, useEffect, useMemo, useCallback, useDeferredValue, memo } from 'react'
import { getCpsLevel, getLineLengthLevel, formatTime, parseTime, type SubtitleBlock as SubtitleBlockType } from '@/types/subtitle'
import { TermHighlight, type SearchHighlightRange } from './TermHighlight'
import { useTheme } from '@/context/ThemeContext'
import { useLocale } from '@/context/LocaleContext'
import { useGlossary } from '@/context/GlossaryContext'
import {
  findMissingTranslations,
  findMatchedGlossaryEntries,
  toSubtitleTerms,
  toTranscriptTerms,
  findTypoCandidates,
  DEFAULT_GLOSSARY_ROLES,
  type GlossaryRoles,
} from '@/utils/glossaryApply'
import { spellIssuesToTerms, type SpellIssue } from '@/lib/pipeline/spellCheck'
import type { Theme } from '@/themes'

interface SubtitleBlockProps {
  block: SubtitleBlockType
  isActive: boolean
  isCurrentlyPlaying: boolean
  playProgress: number // 0-100
  onSelect: (id: number) => void
  onApprove: (id: number) => void
  onFlag: (id: number) => void
  onUpdateSubtitle: (id: number, text: string) => void
  onUpdateTranscript: (id: number, text: string) => void
  onUpdateTimes: (id: number, startTime: number, endTime: number) => void
  onManualSplit: (id: number, textBefore: string, textAfter: string) => void
  onSplitFromTranscript: (id: number, targetBefore: string, targetAfter: string) => void
  onSplitAtPlayhead: (id: number) => void
  onEqualSplit: (id: number) => void
  onIgnoreWarning: (id: number, type: 'typo' | 'missing', key: string) => void
  onDraftChange: (id: number, text: string | null) => void
  /** このブロックのスペル校正結果（承認/出力時に算出） */
  spellIssues?: SpellIssue[]
  /** 用語辞書の ja/en フィールドと字幕・書きおこしロールの対応（翻訳方向で入れ替わる） */
  glossaryRoles?: GlossaryRoles
  /** 誤検知語をユーザー個人辞書へ登録 */
  onAddToSpellDictionary: (word: string) => void
  canMergePrevious: boolean
  canMergeNext: boolean
  onMergeWithPrevious: (id: number) => void
  onMergeWithNext: (id: number) => void
  maxCps: number
  maxCharsPerLine: number
  /** 検索ヒット位置（書きおこし=transcript用） */
  searchRangesTranscript?: SearchHighlightRange[]
  /** 検索ヒット位置（字幕=subtitle用） */
  searchRangesSubtitle?: SearchHighlightRange[]
  /** 検索バーが開いているか（編集ツールバーの🔍ボタン表示用） */
  searchOpen?: boolean
  /** 編集ツールバーの🔍ボタンクリック時 */
  onToggleSearch?: () => void
}

// ─── 警告バッジ共通コンポーネント ───────────────────────────────────────────

interface WarningBadgeProps {
  activeCount: number
  ignoredCount: number
  label: string
  accentColor: string
  textColor: string
  show: boolean
  onToggle: (e: React.MouseEvent) => void
  onClose: () => void
  cardBg: string
  textSecondary: string
  textMuted: string
  children: React.ReactNode
}

function WarningBadge({
  activeCount, ignoredCount, label, accentColor, textColor,
  show, onToggle, onClose, cardBg, textSecondary: _textSecondary, textMuted, children,
}: WarningBadgeProps) {
  const allIgnored = activeCount === 0 && ignoredCount > 0
  const badgeBg = allIgnored ? 'rgba(128,128,128,0.25)' : accentColor
  const badgeColor = allIgnored ? textMuted : textColor
  const rootRef = useRef<HTMLSpanElement>(null)
  // 開いている間、バッジ外（他カード含む）をクリックしたら自動で閉じる
  useEffect(() => {
    if (!show) return
    const onDocPointerDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', onDocPointerDown)
    return () => document.removeEventListener('mousedown', onDocPointerDown)
  }, [show, onClose])
  return (
    <span ref={rootRef} style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
      <span
        onClick={onToggle}
        style={{
          fontSize: 10,
          padding: '2px 7px',
          borderRadius: 999,
          background: badgeBg,
          color: badgeColor,
          fontWeight: 700,
          cursor: 'pointer',
          userSelect: 'none',
          opacity: allIgnored ? 0.7 : 1,
          transition: 'background 0.15s, opacity 0.15s',
        }}
        title="クリックで詳細表示"
      >
        {label} {activeCount}
        {ignoredCount > 0 && (
          <span style={{ fontWeight: 400, opacity: 0.7, marginLeft: 3 }}>
            (+{ignoredCount})
          </span>
        )}
      </span>
      {show && (
        <div
          onClick={e => e.stopPropagation()}
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            zIndex: 20,
            marginTop: 4,
            background: cardBg,
            border: `1px solid ${allIgnored ? 'rgba(128,128,128,0.4)' : accentColor}`,
            borderRadius: 6,
            padding: '6px 8px',
            minWidth: 220,
            boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
            display: 'flex',
            flexDirection: 'column',
            gap: 3,
          }}
        >
          <div style={{ fontSize: 10, color: textMuted, marginBottom: 2 }}>
            × で無視 / ↩ で復帰
          </div>
          {children}
        </div>
      )}
    </span>
  )
}

interface WarningItemProps {
  label: string
  ignored: boolean
  onToggle: (e: React.MouseEvent) => void
  textSecondary: string
  textMuted: string
  /** 任意の追加アクション（例: スペル誤検知を個人辞書へ登録） */
  extraActionLabel?: string
  extraActionTitle?: string
  onExtraAction?: (e: React.MouseEvent) => void
}

function WarningItem({
  label, ignored, onToggle, textSecondary, textMuted,
  extraActionLabel, extraActionTitle, onExtraAction,
}: WarningItemProps) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 6, fontSize: 11,
      opacity: ignored ? 0.45 : 1,
      transition: 'opacity 0.15s',
    }}>
      <span style={{ flex: 1, color: textSecondary, textDecoration: ignored ? 'line-through' : undefined }}>
        {label}
      </span>
      {extraActionLabel && onExtraAction && !ignored && (
        <button
          onClick={onExtraAction}
          style={{
            border: 'none', background: 'transparent',
            color: textMuted, cursor: 'pointer',
            fontSize: 11, lineHeight: 1, padding: '0 4px', borderRadius: 3,
          }}
          title={extraActionTitle}
        >
          {extraActionLabel}
        </button>
      )}
      <button
        onClick={onToggle}
        style={{
          border: 'none', background: 'transparent',
          color: textMuted, cursor: 'pointer',
          fontSize: ignored ? 12 : 13, lineHeight: 1, padding: '0 2px',
          borderRadius: 3,
        }}
        title={ignored ? '復帰する' : '無視する（誤検出）'}
      >
        {ignored ? '↩' : '×'}
      </button>
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────────

function cpsBadgeStyle(level: 'ok' | 'warn' | 'error', theme: Theme) {
  if (level === 'ok')   return { background: theme.cpsBadgeOk[0], color: theme.cpsBadgeOk[1] }
  if (level === 'warn') return { background: theme.cpsBadgeWarn[0], color: theme.cpsBadgeWarn[1] }
  return { background: theme.cpsBadgeError[0], color: theme.cpsBadgeError[1] }
}

// 要確認バッジは「残存する測定形式違反（＋未訳）」のみに付く（reviewDiagnostics 側で限定）。
// 提案・自動修正済みタグは廃止済み。
function reviewBadgeStyle(theme: Theme) {
  return { background: theme.cpsBadgeError[0], color: theme.cpsBadgeError[1] }
}

function reviewBadgeText(block: SubtitleBlockType): string {
  const prefix = '要確認'
  const summary = block.reviewSummary ?? ''
  return summary === prefix ? summary : `${prefix}: ${summary}`
}

function reviewBadgeTitle(block: SubtitleBlockType): string | undefined {
  return block.reviewAction
}

const splitBtnStyle: React.CSSProperties = {
  fontSize: 11,
  padding: '3px 9px',
  borderRadius: 4,
  border: '1px solid #6366f1',
  background: 'rgba(99,102,241,0.12)',
  color: '#6366f1',
  cursor: 'pointer',
  fontWeight: 600,
  whiteSpace: 'nowrap',
}

const searchToggleBtnStyle = (active: boolean): React.CSSProperties => ({
  fontSize: 12,
  padding: '3px 8px',
  borderRadius: 4,
  border: `1px solid ${active ? '#f59e0b' : '#94a3b8'}`,
  background: active ? 'rgba(245,158,11,0.18)' : 'rgba(148,163,184,0.10)',
  color: active ? '#f59e0b' : '#64748b',
  cursor: 'pointer',
  fontWeight: 600,
  whiteSpace: 'nowrap',
  lineHeight: 1,
})

function SubtitleBlockInner({
  block,
  isActive,
  isCurrentlyPlaying,
  playProgress,
  onSelect,
  onApprove,
  onFlag,
  onUpdateSubtitle,
  onUpdateTranscript,
  onUpdateTimes,
  onManualSplit,
  onSplitFromTranscript,
  onSplitAtPlayhead,
  onEqualSplit,
  onIgnoreWarning,
  onDraftChange,
  spellIssues,
  onAddToSpellDictionary,
  glossaryRoles = DEFAULT_GLOSSARY_ROLES,
  canMergePrevious,
  canMergeNext,
  onMergeWithPrevious,
  onMergeWithNext,
  maxCps,
  maxCharsPerLine,
  searchRangesTranscript,
  searchRangesSubtitle,
  searchOpen,
  onToggleSearch,
}: SubtitleBlockProps) {
  const { theme } = useTheme()
  const { strings: t } = useLocale()
  const { glossary } = useGlossary()
  const deferredGlossary = useDeferredValue(glossary)

  // ライブ用語集からマッチエントリを色付きで取得（色は日英共通）
  const matchedWithColors = useMemo(
    () => findMatchedGlossaryEntries(block.subtitle, block.transcript, deferredGlossary, glossaryRoles),
    [block.subtitle, block.transcript, deferredGlossary, glossaryRoles],
  )
  const matchedSubtitleTerms = useMemo(() => toSubtitleTerms(matchedWithColors), [matchedWithColors])
  const matchedTranscriptTerms = useMemo(() => toTranscriptTerms(matchedWithColors), [matchedWithColors])
  const shouldEvaluateMissing = isActive || (block.ignoredMissing?.length ?? 0) > 0
  const allMissingTerms = useMemo(
    () => shouldEvaluateMissing
      ? findMissingTranslations(block.transcript, block.subtitle, deferredGlossary, glossaryRoles)
      : [],
    [shouldEvaluateMissing, block.transcript, block.subtitle, deferredGlossary, glossaryRoles],
  )
  const missingTerms = useMemo(
    () => allMissingTerms.filter(m => !(block.ignoredMissing ?? []).includes(m.entry.id)),
    [allMissingTerms, block.ignoredMissing],
  )
  const ignoredMissingTerms = useMemo(
    () => allMissingTerms.filter(m => (block.ignoredMissing ?? []).includes(m.entry.id)),
    [allMissingTerms, block.ignoredMissing],
  )
  const allTypoCandidates = useMemo(
    () => isActive ? findTypoCandidates(block.subtitle, deferredGlossary, glossaryRoles.subtitle) : [],
    [isActive, block.subtitle, deferredGlossary, glossaryRoles],
  )
  const typoCandidates = useMemo(
    () => allTypoCandidates.filter(c => !(block.ignoredTypos ?? []).includes(`${c.found}::${c.entry.en}`)),
    [allTypoCandidates, block.ignoredTypos],
  )
  const ignoredTypoCandidates = useMemo(
    () => allTypoCandidates.filter(c => (block.ignoredTypos ?? []).includes(`${c.found}::${c.entry.en}`)),
    [allTypoCandidates, block.ignoredTypos],
  )
  // タイポ候補を GlossaryTerm[] に変換（bgColor で背景ハイライト）
  const typoTerms = useMemo(
    () => typoCandidates.map(c => ({
      word: c.found,
      expectedTranslation: c.entry.en,
      actualTranslation: c.found,
      isDeviated: true,
      bgColor: '#ef4444',  // red-500
    })),
    [typoCandidates],
  )
  // スペル校正結果（ignoredTypos のキー `${word}::spell` で無視を反映）
  const spellIgnoreKey = useCallback((word: string) => `${word}::spell`, [])
  const activeSpellIssues = useMemo(
    () => (spellIssues ?? []).filter(i => !(block.ignoredTypos ?? []).includes(spellIgnoreKey(i.word))),
    [spellIssues, block.ignoredTypos, spellIgnoreKey],
  )
  const spellTerms = useMemo(() => spellIssuesToTerms(activeSpellIssues), [activeSpellIssues])
  // 字幕表示用: 辞書マッチ + タイポ候補 + スペル誤り を合成（後ろに追加して重複排除）
  const subtitleTerms = useMemo(() => {
    const taken = new Set([
      ...typoCandidates.map(c => c.found.toLowerCase()),
      ...spellTerms.map(t => t.word.toLowerCase()),
    ])
    const filtered = matchedSubtitleTerms.filter(t => !taken.has(t.word.toLowerCase()))
    return [...filtered, ...typoTerms, ...spellTerms]
  }, [matchedSubtitleTerms, typoTerms, typoCandidates, spellTerms])
  const [showTypoList, setShowTypoList] = useState(false)
  const [showSpellList, setShowSpellList] = useState(false)
  const [showMissingList, setShowMissingList] = useState(false)
  const [showMergeMenu, setShowMergeMenu] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [editText, setEditText] = useState(block.subtitle)
  // 編集中のタイポ候補（editText に対してライブ計算）
  const editTypoCandidates = useMemo(
    () => isEditing ? findTypoCandidates(editText, deferredGlossary, glossaryRoles.subtitle) : [],
    [isEditing, editText, deferredGlossary, glossaryRoles],
  )
  const [isEditingTranscript, setIsEditingTranscript] = useState(false)
  const [editTranscriptText, setEditTranscriptText] = useState(block.transcript)
  const [isEditingTime, setIsEditingTime] = useState(false)
  const [editStart, setEditStart] = useState(formatTime(block.startTime))
  const [editEnd, setEditEnd] = useState(formatTime(block.endTime))
  const [timeError, setTimeError] = useState<string | null>(null)
  const startInputRef = useRef<HTMLInputElement>(null)
  const timeEditorRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const transcriptTextareaRef = useRef<HTMLTextAreaElement>(null)
  // 編集中はeditTextベースでCPS・文字数をライブ計算する
  const liveCps = isEditing
    ? Math.round((editText.length / Math.max(0.01, block.endTime - block.startTime)) * 10) / 10
    : block.cps
  const cpsLevel = getCpsLevel(liveCps, maxCps)

  // 時間編集開始時にフォーカス
  useEffect(() => {
    if (isEditingTime && startInputRef.current) {
      startInputRef.current.select()
    }
  }, [isEditingTime])

  const handleTimeEditOpen = (e: React.MouseEvent) => {
    e.stopPropagation()
    setEditStart(formatTime(block.startTime))
    setEditEnd(formatTime(block.endTime))
    setTimeError(null)
    setIsEditingTime(true)
  }

  const handleTimeEditSave = () => {
    const s = parseTime(editStart)
    const e = parseTime(editEnd)
    if (s === null || e === null) { setTimeError(t.timeErrorFormat); return }
    if (s < 0) { setTimeError(t.timeErrorStartNeg); return }
    if (s >= e) { setTimeError(t.timeErrorOrder); return }
    setTimeError(null)
    setIsEditingTime(false)
    onUpdateTimes(block.id, s, e)
  }

  const handleTimeKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') { e.preventDefault(); handleTimeEditSave() }
    if (e.key === 'Escape') { setIsEditingTime(false); setTimeError(null) }
  }

  const handleTimeEditorBlur = (e: React.FocusEvent<HTMLDivElement>) => {
    const nextFocused = e.relatedTarget
    if (nextFocused instanceof Node && e.currentTarget.contains(nextFocused)) return
    window.setTimeout(handleTimeEditSave, 0)
  }

  useEffect(() => {
    if (isEditing && textareaRef.current) {
      textareaRef.current.focus()
      textareaRef.current.selectionStart = textareaRef.current.value.length
    }
  }, [isEditing])

  useEffect(() => {
    if (isEditingTranscript && transcriptTextareaRef.current) {
      transcriptTextareaRef.current.focus()
      transcriptTextareaRef.current.selectionStart = transcriptTextareaRef.current.value.length
    }
  }, [isEditingTranscript])

  const handleTranscriptSave = () => {
    onUpdateTranscript(block.id, editTranscriptText)
    setIsEditingTranscript(false)
  }

  const handleTranscriptKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape') { setEditTranscriptText(block.transcript); setIsEditingTranscript(false) }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); handleTranscriptSave() }
    if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault()
      const cursor = transcriptTextareaRef.current?.selectionStart ?? editTranscriptText.length
      const before = editTranscriptText.slice(0, cursor).trimEnd()
      const after = editTranscriptText.slice(cursor).trimStart()
      if (before && after) {
        onSplitFromTranscript(block.id, before, after)
        setIsEditingTranscript(false)
      }
    }
  }

  const handleEditSave = () => {
    onUpdateSubtitle(block.id, editText)
    onDraftChange(block.id, null)
    setIsEditing(false)
  }

  const handleEditKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape') { setEditText(block.subtitle); onDraftChange(block.id, null); setIsEditing(false) }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleEditSave()
    if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault()
      const cursor = textareaRef.current?.selectionStart ?? editText.length
      const before = editText.slice(0, cursor).trimEnd()
      const after = editText.slice(cursor).trimStart()
      if (before && after) {
        onManualSplit(block.id, before, after)
        onDraftChange(block.id, null)
        setIsEditing(false)
      }
    }
  }

  const isApproved = block.status === 'approved'
  const isFlagged = block.status === 'flagged'

  const handleIgnoreTypo = useCallback((key: string, e: React.MouseEvent) => {
    e.stopPropagation()
    onIgnoreWarning(block.id, 'typo', key)
  }, [block.id, onIgnoreWarning])

  const handleIgnoreMissing = useCallback((key: string, e: React.MouseEvent) => {
    e.stopPropagation()
    onIgnoreWarning(block.id, 'missing', key)
  }, [block.id, onIgnoreWarning])

  const handleIgnoreSpell = useCallback((word: string, e: React.MouseEvent) => {
    e.stopPropagation()
    onIgnoreWarning(block.id, 'typo', spellIgnoreKey(word))
  }, [block.id, onIgnoreWarning, spellIgnoreKey])

  const ignoredSpellIssues = useMemo(
    () => (spellIssues ?? []).filter(i => (block.ignoredTypos ?? []).includes(spellIgnoreKey(i.word))),
    [spellIssues, block.ignoredTypos, spellIgnoreKey],
  )

  const subtitleLines = block.subtitle.split('\n')
  const liveLines = isEditing ? editText.split('\n') : subtitleLines
  const charLevel = getLineLengthLevel(liveLines.map(l => l.length), maxCharsPerLine)
  const lineLengthColor = (length: number) => {
    const level = getLineLengthLevel([length], maxCharsPerLine)
    if (level === 'error') return theme.cpsBadgeError[0]
    if (level === 'warn') return theme.cpsBadgeWarn[0]
    return theme.textMuted
  }
  // 再生位置がこのブロック内にあるときだけ「再生位置で分割」を有効化
  const canSplitAtPlayhead = !isApproved && isCurrentlyPlaying

  const blockStyle: React.CSSProperties = {
    position: 'relative',
    border: '1px solid',
    borderColor: isActive
        ? theme.cardBorderActive
        : isApproved
          ? theme.cardBorderApproved
          : isFlagged
            ? theme.cardBorderFlagged
            : theme.cardBorder,
    borderRadius: 8,
    padding: 10,
    background: isActive
        ? theme.cardBgActive
        : isApproved
          ? theme.cardBgApproved
          : isFlagged
            ? theme.cardBgFlagged
            : theme.cardBg,
    cursor: isApproved ? 'default' : 'pointer',
    opacity: 1,
    boxShadow: isActive
        ? theme.cardShadowActive
        : undefined,
    transition: 'border-color 0.15s, box-shadow 0.15s',
  }

  return (
    <div
      style={blockStyle}
      onClick={() => onSelect(block.id)}
    >
      {/* 再生進行バー（背景） */}
      <div style={{
        position: 'absolute',
        inset: '0 auto 0 0',
        width: `${playProgress}%`,
        borderRadius: playProgress >= 100 ? 8 : '8px 0 0 8px',
        background: playProgress >= 100 ? theme.progressCompleteBg : theme.progressBg,
        pointerEvents: 'none',
        transition: 'width 0.1s linear',
        zIndex: 0,
      }} />
      {/* コンテンツ（背景バーの上） */}
      <div style={{ position: 'relative', zIndex: 1 }}>
      {!isApproved && (
        <div style={{ position: 'absolute', top: -3, right: -3, zIndex: 3 }}>
          <button
            type="button"
            onClick={e => {
              e.stopPropagation()
              setShowMergeMenu(v => !v)
            }}
            onMouseDown={e => e.stopPropagation()}
            title="前後の字幕ブロックと結合"
            aria-label="前後の字幕ブロックと結合"
            aria-expanded={showMergeMenu}
            style={{
              width: 22,
              height: 22,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: 5,
              border: `1px solid ${theme.panelBorder}`,
              background: showMergeMenu ? theme.cardBg : theme.panelBg,
              color: showMergeMenu ? theme.textPrimary : theme.textMuted,
              cursor: 'pointer',
              fontSize: 14,
              lineHeight: 1,
              userSelect: 'none',
            }}
          >
            ↕
          </button>
          {showMergeMenu && (
            <div
              onClick={e => e.stopPropagation()}
              style={{
                position: 'absolute',
                top: 26,
                right: 0,
                minWidth: 124,
                display: 'grid',
                gap: 4,
                padding: 6,
                borderRadius: 6,
                border: `1px solid ${theme.panelBorder}`,
                background: theme.cardBg,
                boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
              }}
            >
              <button
                type="button"
                disabled={!canMergePrevious}
                onClick={e => {
                  e.stopPropagation()
                  if (!canMergePrevious) return
                  setShowMergeMenu(false)
                  onMergeWithPrevious(block.id)
                }}
                style={{
                  border: `1px solid ${theme.btnBorder}`,
                  background: theme.btnBg,
                  color: canMergePrevious ? theme.btnText : theme.textMuted,
                  borderRadius: 5,
                  padding: '5px 8px',
                  fontSize: 12,
                  cursor: canMergePrevious ? 'pointer' : 'not-allowed',
                  textAlign: 'left',
                }}
              >
                前と結合
              </button>
              <button
                type="button"
                disabled={!canMergeNext}
                onClick={e => {
                  e.stopPropagation()
                  if (!canMergeNext) return
                  setShowMergeMenu(false)
                  onMergeWithNext(block.id)
                }}
                style={{
                  border: `1px solid ${theme.btnBorder}`,
                  background: theme.btnBg,
                  color: canMergeNext ? theme.btnText : theme.textMuted,
                  borderRadius: 5,
                  padding: '5px 8px',
                  fontSize: 12,
                  cursor: canMergeNext ? 'pointer' : 'not-allowed',
                  textAlign: 'left',
                }}
              >
                次と結合
              </button>
            </div>
          )}
        </div>
      )}
      {/* 訳文テキスト（編集可能） */}
      {isEditingTranscript ? (
        <>
          <div style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
            <button
              onMouseDown={e => e.preventDefault()}
              onClick={() => {
                const cursor = transcriptTextareaRef.current?.selectionStart ?? editTranscriptText.length
                const before = editTranscriptText.slice(0, cursor).trimEnd()
                const after = editTranscriptText.slice(cursor).trimStart()
                if (before && after) {
                  onSplitFromTranscript(block.id, before, after)
                  setIsEditingTranscript(false)
                }
              }}
              title="カーソル位置でブロックを2分割し、文字数比でタイムコードを再割り付けします"
              style={splitBtnStyle}
            >✂ 編集位置で分割</button>
            {onToggleSearch && (
              <button
                type="button"
                onMouseDown={e => e.preventDefault()}
                onClick={onToggleSearch}
                title="検索・置換 (Ctrl+F)"
                aria-pressed={!!searchOpen}
                style={searchToggleBtnStyle(!!searchOpen)}
              >🔍</button>
            )}
          </div>
          <textarea
            ref={transcriptTextareaRef}
            value={editTranscriptText}
            onChange={e => setEditTranscriptText(e.target.value)}
            onKeyDown={handleTranscriptKeyDown}
            onBlur={handleTranscriptSave}
            onClick={e => { e.stopPropagation(); onSelect(block.id) }}
            rows={Math.max(2, editTranscriptText.split('\n').length)}
            style={{
              width: '100%',
              background: theme.inputBg,
              border: `1px solid ${theme.inputBorderFocus}`,
              borderRadius: 6,
              padding: '8px',
              fontSize: 12,
              color: theme.textJapanese,
              outline: 'none',
              resize: 'none',
              lineHeight: 1.4,
              fontFamily: 'inherit',
              marginBottom: 4,
            }}
          />
          {/* 行ごとのリアルタイム文字数プレビュー */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 2, flexWrap: 'wrap' }}>
            {editTranscriptText.split('\n').map((line, i) => (
              <span key={i} style={{
                fontSize: 10,
                fontFamily: 'monospace',
                color: lineLengthColor(line.length),
              }}>
                {i + 1}行: {line.length}字{line.length > maxCharsPerLine ? ' ⚠' : ''}
              </span>
            ))}
          </div>
          <div style={{ fontSize: 10, color: theme.textMuted, marginBottom: 4 }}>
            Enter: 改行 / Ctrl+Enter: 保存 / Shift+Enter: ここで分割 / Esc: キャンセル
          </div>
        </>
      ) : (
        <div
          onClick={e => { if (isApproved) return; e.stopPropagation(); onSelect(block.id); setEditTranscriptText(block.transcript); setIsEditingTranscript(true) }}
          style={{
            color: theme.textJapanese,
            fontSize: 12,
            marginBottom: 6,
            lineHeight: 1.4,
            padding: '4px 6px',
            borderRadius: 4,
            border: `1px solid transparent`,
            cursor: isApproved ? 'default' : 'text',
            minHeight: 20,
          }}
          title={isApproved ? undefined : 'クリックで訳文を編集'}
        >
          {block.transcript
            ? <TermHighlight text={block.transcript} terms={matchedTranscriptTerms} searchRanges={searchRangesTranscript} />
            : <span style={{ color: theme.textDisabled, fontStyle: 'italic' }}>（訳文なし）</span>
          }
        </div>
      )}

      {/* 原文テキスト */}
      {isEditing ? (
        <>
          <div style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
            <button
              onMouseDown={e => e.preventDefault()}
              onClick={() => {
                const cursor = textareaRef.current?.selectionStart ?? editText.length
                const before = editText.slice(0, cursor).trimEnd()
                const after = editText.slice(cursor).trimStart()
                if (before && after) {
                  onManualSplit(block.id, before, after)
                  onDraftChange(block.id, null)
                  setIsEditing(false)
                }
              }}
              title="カーソル位置でブロックを2分割し、文字数比でタイムコードを再割り付けします"
              style={splitBtnStyle}
            >✂ 編集位置で分割</button>
            {onToggleSearch && (
              <button
                type="button"
                onMouseDown={e => e.preventDefault()}
                onClick={onToggleSearch}
                title="検索・置換 (Ctrl+F)"
                aria-pressed={!!searchOpen}
                style={searchToggleBtnStyle(!!searchOpen)}
              >🔍</button>
            )}
          </div>
          <textarea
            ref={textareaRef}
            value={editText}
            onChange={e => { setEditText(e.target.value); onDraftChange(block.id, e.target.value) }}
            onKeyDown={handleEditKeyDown}
            onBlur={() => handleEditSave()}
            onClick={e => { e.stopPropagation(); onSelect(block.id) }}
            rows={Math.max(2, editText.split('\n').length)}
            style={{
              width: '100%',
              background: theme.inputBg,
              border: `1px solid ${theme.inputBorderFocus}`,
              borderRadius: 6,
              padding: '8px',
              fontSize: 15,
              color: theme.inputText,
              outline: 'none',
              resize: 'none',
              lineHeight: 1.45,
              fontFamily: 'inherit',
            }}
          />
          {/* 行ごとのリアルタイム文字数プレビュー */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 2, flexWrap: 'wrap' }}>
            {editText.split('\n').map((line, i) => (
              <span key={i} style={{
                fontSize: 10,
                fontFamily: 'monospace',
                color: lineLengthColor(line.length),
              }}>
                {i + 1}行: {line.length}字{line.length > maxCharsPerLine ? ' ⚠' : ''}
              </span>
            ))}
          </div>
          {editTypoCandidates.length > 0 && (
            <div style={{
              marginTop: 4,
              padding: '5px 8px',
              borderRadius: 5,
              background: '#ef444418',
              border: '1px solid #ef444466',
              fontSize: 11,
              color: '#ef4444',
              display: 'flex',
              flexWrap: 'wrap',
              gap: '4px 10px',
            }}>
              {editTypoCandidates.map(c => (
                <span key={`${c.found}::${c.entry.en}`}>
                  ⚠ <b>"{c.found}"</b> → "{c.entry.en}" ?
                </span>
              ))}
            </div>
          )}
          <div style={{ fontSize: 10, color: theme.textMuted, marginTop: 3 }}>
            {t.editHint}
          </div>
        </>
      ) : (
        <div
          onClick={e => { if (isApproved) return; e.stopPropagation(); onSelect(block.id); setEditText(block.subtitle); setIsEditing(true) }}
          style={{
            fontSize: 15,
            lineHeight: 1.45,
            padding: 8,
            borderRadius: 6,
            border: `1px solid ${theme.inputBorder}`,
            background: theme.inputBg,
            minHeight: 38,
            cursor: isApproved ? 'default' : 'text',
            color: theme.inputText,
          }}
        >
          <TermHighlight text={block.subtitle} terms={subtitleTerms} searchRanges={searchRangesSubtitle} />
        </div>
      )}

      {/* メタ情報 */}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, fontSize: 12, color: theme.textSecondary, marginTop: 8 }}>
        {/* 時間表示 / 編集 */}
        {isEditingTime ? (
          <div
            ref={timeEditorRef}
            style={{ display: 'flex', alignItems: 'center', gap: 4 }}
            onClick={e => e.stopPropagation()}
            onBlur={handleTimeEditorBlur}
          >
            <input
              ref={startInputRef}
              value={editStart}
              onChange={e => { setEditStart(e.target.value); setTimeError(null) }}
              onKeyDown={handleTimeKeyDown}
              style={{
                width: 86, background: theme.inputBg, border: `1px solid ${timeError ? theme.cpsBadgeError[0] : theme.inputBorderFocus}`,
                borderRadius: 4, padding: '2px 5px', fontSize: 12, color: theme.inputText,
                outline: 'none', fontFamily: 'monospace',
              }}
            />
            <span style={{ fontSize: 11, color: theme.textMuted }}>〜</span>
            <input
              value={editEnd}
              onChange={e => { setEditEnd(e.target.value); setTimeError(null) }}
              onKeyDown={handleTimeKeyDown}
              style={{
                width: 86, background: theme.inputBg, border: `1px solid ${timeError ? theme.cpsBadgeError[0] : theme.inputBorderFocus}`,
                borderRadius: 4, padding: '2px 5px', fontSize: 12, color: theme.inputText,
                outline: 'none', fontFamily: 'monospace',
              }}
            />
            {timeError && (
              <span style={{ fontSize: 10, color: theme.cpsBadgeError[0] }}>{timeError}</span>
            )}
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span
              onClick={isApproved ? undefined : handleTimeEditOpen}
              style={{
                cursor: isApproved ? 'default' : 'text',
                borderBottom: isApproved ? undefined : `1px dashed ${theme.handleTooltipBorder}`,
                paddingBottom: 1,
              }}
              title={isApproved ? undefined : t.timeEditTitle}
            >
              {formatTime(block.startTime)} 〜 {formatTime(block.endTime)}
            </span>
            {!isApproved && (
              <div
                style={{ display: 'flex', alignItems: 'center', gap: 1 }}
                onClick={e => e.stopPropagation()}
              >
                <button
                  title="開始 −0.1s (I キーで再生位置にセット)"
                  onClick={() => {
                    const s = Math.max(0, block.startTime - 0.1)
                    if (s < block.endTime) onUpdateTimes(block.id, s, block.endTime)
                  }}
                  style={{
                    fontSize: 10, padding: '1px 4px', borderRadius: 3,
                    border: `1px solid ${theme.btnBorder}`, background: theme.btnBg,
                    color: theme.textSecondary, cursor: 'pointer', lineHeight: 1,
                  }}
                >‹←</button>
                <button
                  title="開始 +0.1s"
                  onClick={() => {
                    const s = Math.min(block.endTime - 0.05, block.startTime + 0.1)
                    if (s < block.endTime) onUpdateTimes(block.id, s, block.endTime)
                  }}
                  style={{
                    fontSize: 10, padding: '1px 4px', borderRadius: 3,
                    border: `1px solid ${theme.btnBorder}`, background: theme.btnBg,
                    color: theme.textSecondary, cursor: 'pointer', lineHeight: 1,
                  }}
                >→›</button>
                <span style={{ color: theme.textMuted, fontSize: 10, padding: '0 2px' }}>|</span>
                <button
                  title="終了 −0.1s"
                  onClick={() => {
                    const e2 = Math.max(block.startTime + 0.05, block.endTime - 0.1)
                    if (e2 > block.startTime) onUpdateTimes(block.id, block.startTime, e2)
                  }}
                  style={{
                    fontSize: 10, padding: '1px 4px', borderRadius: 3,
                    border: `1px solid ${theme.btnBorder}`, background: theme.btnBg,
                    color: theme.textSecondary, cursor: 'pointer', lineHeight: 1,
                  }}
                >‹←</button>
                <button
                  title="終了 +0.1s (O キーで再生位置にセット)"
                  onClick={() => {
                    onUpdateTimes(block.id, block.startTime, block.endTime + 0.1)
                  }}
                  style={{
                    fontSize: 10, padding: '1px 4px', borderRadius: 3,
                    border: `1px solid ${theme.btnBorder}`, background: theme.btnBg,
                    color: theme.textSecondary, cursor: 'pointer', lineHeight: 1,
                  }}
                >→›</button>
              </div>
            )}
          </div>
        )}
        <span style={{
          ...cpsBadgeStyle(cpsLevel, theme),
          padding: '2px 8px',
          borderRadius: 999,
          fontWeight: 700,
          fontSize: 11,
        }}>
          CPS: {liveCps.toFixed(1)}
        </span>
        <span style={{
          ...cpsBadgeStyle(charLevel, theme),
          padding: '2px 8px',
          borderRadius: 999,
          fontWeight: 700,
          fontSize: 11,
        }}>
          {liveLines.map(l => l.length).join(' / ')}字
        </span>
        {(missingTerms.length > 0 || ignoredMissingTerms.length > 0) && (
          <WarningBadge
            activeCount={missingTerms.length}
            ignoredCount={ignoredMissingTerms.length}
            label="用語漏れ"
            accentColor={theme.cpsBadgeWarn[0]}
            textColor={theme.cpsBadgeWarn[1]}
            show={showMissingList}
            onToggle={e => { e.stopPropagation(); setShowMissingList(v => !v) }}
            onClose={() => setShowMissingList(false)}
            cardBg={theme.panelBg}
            textSecondary={theme.textSecondary}
            textMuted={theme.textMuted}
          >
            {missingTerms.map(m => (
              <WarningItem
                key={m.entry.id}
                label={`${m.entry.ja} → ${m.entry.en}`}
                ignored={false}
                onToggle={e => handleIgnoreMissing(m.entry.id, e)}
                textSecondary={theme.textSecondary}
                textMuted={theme.textMuted}
              />
            ))}
            {ignoredMissingTerms.length > 0 && (
              <>
                <div style={{ borderTop: `1px solid ${theme.panelBorder}`, margin: '4px 0' }} />
                {ignoredMissingTerms.map(m => (
                  <WarningItem
                    key={m.entry.id}
                    label={`${m.entry.ja} → ${m.entry.en}`}
                    ignored={true}
                    onToggle={e => handleIgnoreMissing(m.entry.id, e)}
                    textSecondary={theme.textSecondary}
                    textMuted={theme.textMuted}
                  />
                ))}
              </>
            )}
          </WarningBadge>
        )}
        {(typoCandidates.length > 0 || ignoredTypoCandidates.length > 0) && (
          <WarningBadge
            activeCount={typoCandidates.length}
            ignoredCount={ignoredTypoCandidates.length}
            label="タイポ?"
            accentColor={theme.cpsBadgeError[0]}
            textColor={theme.cpsBadgeError[1]}
            show={showTypoList}
            onToggle={e => { e.stopPropagation(); setShowTypoList(v => !v) }}
            onClose={() => setShowTypoList(false)}
            cardBg={theme.panelBg}
            textSecondary={theme.textSecondary}
            textMuted={theme.textMuted}
          >
            {typoCandidates.map(c => {
              const key = `${c.found}::${c.entry.en}`
              return (
                <WarningItem
                  key={key}
                  label={`"${c.found}" → "${c.entry.en}" ?`}
                  ignored={false}
                  onToggle={e => handleIgnoreTypo(key, e)}
                  textSecondary={theme.textSecondary}
                  textMuted={theme.textMuted}
                />
              )
            })}
            {ignoredTypoCandidates.length > 0 && (
              <>
                <div style={{ borderTop: `1px solid ${theme.panelBorder}`, margin: '4px 0' }} />
                {ignoredTypoCandidates.map(c => {
                  const key = `${c.found}::${c.entry.en}`
                  return (
                    <WarningItem
                      key={key}
                      label={`"${c.found}" → "${c.entry.en}" ?`}
                      ignored={true}
                      onToggle={e => handleIgnoreTypo(key, e)}
                      textSecondary={theme.textSecondary}
                      textMuted={theme.textMuted}
                    />
                  )
                })}
              </>
            )}
          </WarningBadge>
        )}
        {(activeSpellIssues.length > 0 || ignoredSpellIssues.length > 0) && (
          <WarningBadge
            activeCount={activeSpellIssues.length}
            ignoredCount={ignoredSpellIssues.length}
            label="スペル?"
            accentColor={theme.cpsBadgeError[0]}
            textColor={theme.cpsBadgeError[1]}
            show={showSpellList}
            onToggle={e => { e.stopPropagation(); setShowSpellList(v => !v) }}
            onClose={() => setShowSpellList(false)}
            cardBg={theme.panelBg}
            textSecondary={theme.textSecondary}
            textMuted={theme.textMuted}
          >
            {activeSpellIssues.map(i => {
              const label = i.reason === 'repeated_word'
                ? `"${i.word}" 単語の重複?`
                : i.suggestions.length > 0 ? `"${i.word}" → "${i.suggestions[0]}" ?` : `"${i.word}" 綴り?`
              return (
                <WarningItem
                  key={`${i.word}::spell`}
                  label={label}
                  ignored={false}
                  onToggle={e => handleIgnoreSpell(i.word, e)}
                  textSecondary={theme.textSecondary}
                  textMuted={theme.textMuted}
                  extraActionLabel="＋辞書"
                  extraActionTitle="この語を個人辞書に登録（今後どこでもフラグしない）"
                  onExtraAction={e => { e.stopPropagation(); onAddToSpellDictionary(i.word) }}
                />
              )
            })}
            {ignoredSpellIssues.length > 0 && (
              <>
                <div style={{ borderTop: `1px solid ${theme.panelBorder}`, margin: '4px 0' }} />
                {ignoredSpellIssues.map(i => (
                  <WarningItem
                    key={`${i.word}::spell`}
                    label={`"${i.word}" 綴り?`}
                    ignored={true}
                    onToggle={e => handleIgnoreSpell(i.word, e)}
                    textSecondary={theme.textSecondary}
                    textMuted={theme.textMuted}
                  />
                ))}
              </>
            )}
          </WarningBadge>
        )}
        {block.reviewSummary && block.reviewDisposition !== 'auto_pass' && (
          <span
            title={reviewBadgeTitle(block)}
            style={{
              ...reviewBadgeStyle(theme),
              fontSize: 10,
              padding: '2px 7px',
              borderRadius: 999,
              fontWeight: 700,
            }}
          >
            {reviewBadgeText(block)}
          </span>
        )}
      </div>

      {/* アクションボタン */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
        <button
          onClick={e => { e.stopPropagation(); onApprove(block.id) }}
          style={{
            border: '1px solid',
            borderColor: isApproved ? theme.btnBorderApproved : theme.btnBorder,
            background: isApproved ? theme.btnBgApproved : theme.btnBg,
            color: isApproved ? theme.btnTextApproved : theme.btnText,
            borderRadius: 6,
            padding: '5px 9px',
            fontSize: 12,
            cursor: 'pointer',
            fontWeight: isApproved ? 700 : undefined,
          }}
        >
          {isApproved ? t.approvedBtn : t.approve}
        </button>
        {!isApproved && (
          <button
            onClick={e => { e.stopPropagation(); onFlag(block.id) }}
            style={{
              border: '1px solid',
              borderColor: isFlagged ? theme.btnBorderFlagged : theme.btnBorder,
              background: isFlagged ? theme.btnBgFlagged : theme.btnBg,
              color: isFlagged ? theme.btnTextFlagged : theme.btnText,
              borderRadius: 6,
              padding: '5px 9px',
              fontSize: 12,
              cursor: 'pointer',
              fontWeight: isFlagged ? 700 : undefined,
            }}
          >
            {isFlagged ? t.flaggedBtn : t.flag}
          </button>
        )}
        {!isApproved && (
          <>
            {/* 再生位置で分割: 再生ヘッドがこのブロック内にあるときのみ有効 */}
            <button
              onClick={e => { e.stopPropagation(); onSplitAtPlayhead(block.id) }}
              disabled={!canSplitAtPlayhead}
              title={canSplitAtPlayhead
                ? '再生位置でカット'
                : 'ブロック内で再生中のときに有効になります'}
              style={{
                border: `1px solid ${canSplitAtPlayhead ? theme.accent : theme.btnBorder}`,
                background: canSplitAtPlayhead ? theme.accent + '22' : theme.btnBg,
                color: canSplitAtPlayhead ? theme.accent : theme.textDisabled,
                borderRadius: 6,
                padding: '5px 9px',
                fontSize: 12,
                cursor: canSplitAtPlayhead ? 'pointer' : 'not-allowed',
              }}
            >
              ✂ 再生位置
            </button>
            {/* 均等割り: 常に有効 */}
            <button
              onClick={e => { e.stopPropagation(); onEqualSplit(block.id) }}
              title="時間・テキストを2等分（単語境界に合わせる）"
              style={{
                border: `1px solid ${theme.btnBorder}`,
                background: theme.btnBg,
                color: theme.btnText,
                borderRadius: 6,
                padding: '5px 9px',
                fontSize: 12,
                cursor: 'pointer',
              }}
            >
              ÷ 均等割り
            </button>
          </>
        )}
      </div>
      </div> {/* コンテンツ終了 */}
    </div>
  )
}

export const SubtitleBlock = memo(SubtitleBlockInner)
