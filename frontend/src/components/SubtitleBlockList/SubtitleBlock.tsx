import { useState, useRef, useEffect, useMemo, useCallback, useDeferredValue, memo } from 'react'
import { getCpsLevel, formatTime, parseTime, type SubtitleBlock as SubtitleBlockType } from '@/types/subtitle'
import { TermHighlight } from './TermHighlight'
import { useTheme } from '@/context/ThemeContext'
import { useLocale } from '@/context/LocaleContext'
import { useGlossary } from '@/context/GlossaryContext'
import { findMissingTranslations, findMatchedGlossaryEntries, toSourceTerms, toTargetTerms, findTypoCandidates } from '@/utils/glossaryApply'
import type { Theme } from '@/themes'

interface SubtitleBlockProps {
  block: SubtitleBlockType
  isActive: boolean
  isCurrentlyPlaying: boolean
  isDragging: boolean
  isDragOver: boolean
  playProgress: number // 0-100
  onSelect: (id: number) => void
  onApprove: (id: number) => void
  onFlag: (id: number) => void
  onReSplit: (id: number) => void
  onReTranslate: (id: number) => void
  onUpdateSource: (id: number, text: string) => void
  onUpdateTarget: (id: number, text: string) => void
  onUpdateTimes: (id: number, startTime: number, endTime: number) => void
  onManualSplit: (id: number, textBefore: string, textAfter: string) => void
  onSplitFromTarget: (id: number, targetBefore: string, targetAfter: string) => void
  onSplitAtPlayhead: (id: number) => void
  onEqualSplit: (id: number) => void
  onIgnoreWarning: (id: number, type: 'typo' | 'missing', key: string) => void
  onDraftChange: (id: number, text: string | null) => void
  onDragStart: (id: number) => void
  onDragEnd: () => void
  onDragOver: (id: number) => void
  onDrop: (id: number) => void
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
  cardBg: string
  textSecondary: string
  textMuted: string
  children: React.ReactNode
}

function WarningBadge({
  activeCount, ignoredCount, label, accentColor, textColor,
  show, onToggle, cardBg, textSecondary: _textSecondary, textMuted, children,
}: WarningBadgeProps) {
  const allIgnored = activeCount === 0 && ignoredCount > 0
  const badgeBg = allIgnored ? 'rgba(128,128,128,0.25)' : accentColor
  const badgeColor = allIgnored ? textMuted : textColor
  return (
    <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
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
}

function WarningItem({ label, ignored, onToggle, textSecondary, textMuted }: WarningItemProps) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 6, fontSize: 11,
      opacity: ignored ? 0.45 : 1,
      transition: 'opacity 0.15s',
    }}>
      <span style={{ flex: 1, color: textSecondary, textDecoration: ignored ? 'line-through' : undefined }}>
        {label}
      </span>
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

function getCharLevel(lineLengths: number[]): 'ok' | 'warn' | 'error' {
  const max = Math.max(...lineLengths, 0)
  if (max > 42) return 'error'
  if (max > 36) return 'warn'
  return 'ok'
}

function SubtitleBlockInner({
  block,
  isActive,
  isCurrentlyPlaying,
  isDragging,
  isDragOver,
  playProgress,
  onSelect,
  onApprove,
  onFlag,
  onReSplit,
  onReTranslate,
  onUpdateSource,
  onUpdateTarget,
  onUpdateTimes,
  onManualSplit,
  onSplitFromTarget,
  onSplitAtPlayhead,
  onEqualSplit,
  onIgnoreWarning,
  onDraftChange,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
}: SubtitleBlockProps) {
  const { theme } = useTheme()
  const { strings: t } = useLocale()
  const { glossary } = useGlossary()
  const deferredGlossary = useDeferredValue(glossary)

  // ライブ用語集からマッチエントリを色付きで取得（色は日英共通）
  const matchedWithColors = useMemo(
    () => findMatchedGlossaryEntries(block.source, block.target, deferredGlossary),
    [block.source, block.target, deferredGlossary],
  )
  const matchedTermsEn = useMemo(() => toSourceTerms(matchedWithColors), [matchedWithColors])
  const matchedTermsJa = useMemo(() => toTargetTerms(matchedWithColors), [matchedWithColors])
  const shouldEvaluateMissing = isActive || (block.ignoredMissing?.length ?? 0) > 0
  const allMissingTerms = useMemo(
    () => shouldEvaluateMissing
      ? findMissingTranslations(block.target, block.source, deferredGlossary)
      : [],
    [shouldEvaluateMissing, block.target, block.source, deferredGlossary],
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
    () => isActive ? findTypoCandidates(block.source, deferredGlossary) : [],
    [isActive, block.source, deferredGlossary],
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
  // 英語ソース表示用: 辞書マッチ + タイポ候補を合成（タイポを後ろに追加して重複排除）
  const sourceTerms = useMemo(() => {
    const typoWords = new Set(typoCandidates.map(c => c.found.toLowerCase()))
    const filtered = matchedTermsEn.filter(t => !typoWords.has(t.word.toLowerCase()))
    return [...filtered, ...typoTerms]
  }, [matchedTermsEn, typoTerms, typoCandidates])
  const [showTypoList, setShowTypoList] = useState(false)
  const [showMissingList, setShowMissingList] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [editText, setEditText] = useState(block.source)
  // 編集中のタイポ候補（editText に対してライブ計算）
  const editTypoCandidates = useMemo(
    () => isEditing ? findTypoCandidates(editText, deferredGlossary) : [],
    [isEditing, editText, deferredGlossary],
  )
  const [isEditingTarget, setIsEditingTarget] = useState(false)
  const [editTargetText, setEditTargetText] = useState(block.target)
  const [isEditingTime, setIsEditingTime] = useState(false)
  const [editStart, setEditStart] = useState(formatTime(block.startTime))
  const [editEnd, setEditEnd] = useState(formatTime(block.endTime))
  const [timeError, setTimeError] = useState<string | null>(null)
  const startInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const targetTextareaRef = useRef<HTMLTextAreaElement>(null)
  // 編集中はeditTextベースでCPS・文字数をライブ計算する
  const liveCps = isEditing
    ? Math.round((editText.length / Math.max(0.01, block.endTime - block.startTime)) * 10) / 10
    : block.cps
  const cpsLevel = getCpsLevel(liveCps)

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

  useEffect(() => {
    if (isEditing && textareaRef.current) {
      textareaRef.current.focus()
      textareaRef.current.selectionStart = textareaRef.current.value.length
    }
  }, [isEditing])

  useEffect(() => {
    if (isEditingTarget && targetTextareaRef.current) {
      targetTextareaRef.current.focus()
      targetTextareaRef.current.selectionStart = targetTextareaRef.current.value.length
    }
  }, [isEditingTarget])

  const handleTargetSave = () => {
    onUpdateTarget(block.id, editTargetText)
    setIsEditingTarget(false)
  }

  const handleTargetKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape') { setEditTargetText(block.target); setIsEditingTarget(false) }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); handleTargetSave() }
    if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault()
      const cursor = targetTextareaRef.current?.selectionStart ?? editTargetText.length
      const before = editTargetText.slice(0, cursor).trimEnd()
      const after = editTargetText.slice(cursor).trimStart()
      if (before && after) {
        onSplitFromTarget(block.id, before, after)
        setIsEditingTarget(false)
      }
    }
  }

  const handleEditSave = () => {
    onUpdateSource(block.id, editText)
    onDraftChange(block.id, null)
    setIsEditing(false)
  }

  const handleEditKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape') { setEditText(block.source); onDraftChange(block.id, null); setIsEditing(false) }
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

  const sourceLines = block.source.split('\n')
  const liveLines = isEditing ? editText.split('\n') : sourceLines
  const charLevel = getCharLevel(liveLines.map(l => l.length))
  // 再生位置がこのブロック内にあるときだけ「再生位置で分割」を有効化
  const canSplitAtPlayhead = !isApproved && isCurrentlyPlaying

  const blockStyle: React.CSSProperties = {
    position: 'relative',
    border: '1px solid',
    borderColor: isDragOver
      ? theme.cardBorderDragOver
      : isActive
        ? theme.cardBorderActive
        : isApproved
          ? theme.cardBorderApproved
          : isFlagged
            ? theme.cardBorderFlagged
            : theme.cardBorder,
    borderRadius: 8,
    padding: 10,
    background: isDragOver
      ? theme.cardBgDragOver
      : isActive
        ? theme.cardBgActive
        : isApproved
          ? theme.cardBgApproved
          : isFlagged
            ? theme.cardBgFlagged
            : theme.cardBg,
    cursor: isApproved ? 'default' : 'pointer',
    opacity: isDragging ? 0.4 : 1,
    boxShadow: isDragOver
      ? theme.cardShadowDragOver
      : isActive
        ? theme.cardShadowActive
        : undefined,
    transition: 'border-color 0.15s, box-shadow 0.15s',
  }

  return (
    <div
      style={blockStyle}
      onClick={() => onSelect(block.id)}
      draggable={!isApproved}
      onDragStart={e => { if (isApproved) { e.preventDefault(); return }; e.dataTransfer.effectAllowed = 'move'; onDragStart(block.id) }}
      onDragEnd={onDragEnd}
      onDragOver={e => { e.preventDefault(); if (!isApproved) { e.dataTransfer.dropEffect = 'move'; onDragOver(block.id) } else { e.dataTransfer.dropEffect = 'none' } }}
      onDrop={e => { e.preventDefault(); if (!isApproved) onDrop(block.id) }}
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
      {/* 訳文テキスト（編集可能） */}
      {isEditingTarget ? (
        <>
          <textarea
            ref={targetTextareaRef}
            value={editTargetText}
            onChange={e => setEditTargetText(e.target.value)}
            onKeyDown={handleTargetKeyDown}
            onBlur={handleTargetSave}
            onClick={e => { e.stopPropagation(); onSelect(block.id) }}
            rows={Math.max(2, editTargetText.split('\n').length)}
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
            {editTargetText.split('\n').map((line, i) => (
              <span key={i} style={{
                fontSize: 10,
                fontFamily: 'monospace',
                color: line.length > 42 ? '#ef4444' : line.length > 36 ? '#f59e0b' : theme.textMuted,
              }}>
                {i + 1}行: {line.length}字{line.length > 42 ? ' ⚠' : ''}
              </span>
            ))}
          </div>
          <div style={{ fontSize: 10, color: theme.textMuted, marginBottom: 4 }}>
            Enter: 改行 / Ctrl+Enter: 保存 / Shift+Enter: ここで分割 / Esc: キャンセル
          </div>
        </>
      ) : (
        <div
          onClick={e => { if (isApproved) return; e.stopPropagation(); onSelect(block.id); setEditTargetText(block.target); setIsEditingTarget(true) }}
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
          {block.target
            ? <TermHighlight text={block.target} terms={matchedTermsJa} />
            : <span style={{ color: theme.textDisabled, fontStyle: 'italic' }}>（訳文なし）</span>
          }
        </div>
      )}

      {/* 原文テキスト */}
      {isEditing ? (
        <>
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
                color: line.length > 42 ? '#ef4444' : line.length > 36 ? '#f59e0b' : theme.textMuted,
              }}>
                {i + 1}行: {line.length}字{line.length > 42 ? ' ⚠' : ''}
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
          onClick={e => { if (isApproved) return; e.stopPropagation(); onSelect(block.id); setEditText(block.source); setIsEditing(true) }}
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
          <TermHighlight text={block.source} terms={sourceTerms} />
        </div>
      )}

      {/* メタ情報 */}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, fontSize: 12, color: theme.textSecondary, marginTop: 8 }}>
        {/* 時間表示 / 編集 */}
        {isEditingTime ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }} onClick={e => e.stopPropagation()}>
            <input
              ref={startInputRef}
              value={editStart}
              onChange={e => { setEditStart(e.target.value); setTimeError(null) }}
              onKeyDown={handleTimeKeyDown}
              onBlur={handleTimeEditSave}
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
              onBlur={handleTimeEditSave}
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
            cardBg={theme.cardBg}
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
            cardBg={theme.cardBg}
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
            <button
              onClick={e => { e.stopPropagation(); onReSplit(block.id) }}
              style={{ border: `1px solid ${theme.btnBorder}`, background: theme.btnBg, color: theme.btnText, borderRadius: 6, padding: '5px 9px', fontSize: 12, cursor: 'pointer' }}
            >
              {t.reSplit}
            </button>
            <button
              onClick={e => { e.stopPropagation(); onReTranslate(block.id) }}
              style={{ border: `1px solid ${theme.btnBorder}`, background: theme.btnBg, color: theme.btnText, borderRadius: 6, padding: '5px 9px', fontSize: 12, cursor: 'pointer' }}
            >
              {t.reTranslate}
            </button>
          </>
        )}
      </div>
      </div> {/* コンテンツ終了 */}
    </div>
  )
}

export const SubtitleBlock = memo(SubtitleBlockInner)
