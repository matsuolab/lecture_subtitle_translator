import { useState, useRef, useEffect } from 'react'
import { getCpsLevel, formatTime, parseTime, type SubtitleBlock as SubtitleBlockType } from '@/types/subtitle'
import { TermHighlight } from './TermHighlight'
import { useTheme } from '@/context/ThemeContext'
import { useLocale } from '@/context/LocaleContext'
import { useGlossary } from '@/context/GlossaryContext'
import { findMissingTranslations } from '@/utils/glossaryApply'
import type { Theme } from '@/themes'

interface SubtitleBlockProps {
  block: SubtitleBlockType
  isActive: boolean
  currentTime: number
  isDragging: boolean
  isDragOver: boolean
  playProgress: number // 0-100
  onSelect: () => void
  onApprove: (id: number) => void
  onReSplit: (id: number) => void
  onReTranslate: (id: number) => void
  onUpdateSource: (id: number, text: string) => void
  onUpdateTarget: (id: number, text: string) => void
  onUpdateTimes: (id: number, startTime: number, endTime: number) => void
  onManualSplit: (id: number, textBefore: string, textAfter: string) => void
  onSplitFromTarget: (id: number, targetBefore: string, targetAfter: string) => void
  onSplitAtPlayhead: (id: number) => void
  onEqualSplit: (id: number) => void
  onDragStart: (id: number) => void
  onDragEnd: () => void
  onDragOver: (id: number) => void
  onDrop: (id: number) => void
}

function cpsBadgeStyle(level: 'ok' | 'warn' | 'error', theme: Theme) {
  if (level === 'ok')   return { background: theme.cpsBadgeOk[0], color: theme.cpsBadgeOk[1] }
  if (level === 'warn') return { background: theme.cpsBadgeWarn[0], color: theme.cpsBadgeWarn[1] }
  return { background: theme.cpsBadgeError[0], color: theme.cpsBadgeError[1] }
}

export function SubtitleBlock({
  block,
  isActive,
  currentTime,
  isDragging,
  isDragOver,
  playProgress,
  onSelect,
  onApprove,
  onReSplit,
  onReTranslate,
  onUpdateSource,
  onUpdateTarget,
  onUpdateTimes,
  onManualSplit,
  onSplitFromTarget,
  onSplitAtPlayhead,
  onEqualSplit,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
}: SubtitleBlockProps) {
  const { theme } = useTheme()
  const { strings: t } = useLocale()
  const { glossary } = useGlossary()
  const missingTerms = findMissingTranslations(block.target, block.source, glossary)
  const [isEditing, setIsEditing] = useState(false)
  const [editText, setEditText] = useState(block.source)
  const [isEditingTarget, setIsEditingTarget] = useState(false)
  const [editTargetText, setEditTargetText] = useState(block.target)
  const [isEditingTime, setIsEditingTime] = useState(false)
  const [editStart, setEditStart] = useState(formatTime(block.startTime))
  const [editEnd, setEditEnd] = useState(formatTime(block.endTime))
  const [timeError, setTimeError] = useState<string | null>(null)
  const startInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const targetTextareaRef = useRef<HTMLTextAreaElement>(null)
  const cpsLevel = getCpsLevel(block.cps)

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
    setIsEditing(false)
  }

  const handleEditKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape') { setEditText(block.source); setIsEditing(false) }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleEditSave()
    if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault()
      const cursor = textareaRef.current?.selectionStart ?? editText.length
      const before = editText.slice(0, cursor).trimEnd()
      const after = editText.slice(cursor).trimStart()
      if (before && after) {
        onManualSplit(block.id, before, after)
        setIsEditing(false)
      }
    }
  }

  const isApproved = block.status === 'approved'
  const sourceLines = block.source.split('\n')
  const isOver = sourceLines.some(l => l.length > 42)
  // 再生位置がこのブロック内にあるときだけ「再生位置で分割」を有効化
  const canSplitAtPlayhead = !isApproved
    && currentTime > block.startTime
    && currentTime < block.endTime

  const blockStyle: React.CSSProperties = {
    position: 'relative',
    border: '1px solid',
    borderColor: isDragOver
      ? theme.cardBorderDragOver
      : isActive
        ? theme.cardBorderActive
        : isApproved
          ? theme.cardBorderApproved
          : theme.cardBorder,
    borderRadius: 8,
    padding: 10,
    background: isDragOver
      ? theme.cardBgDragOver
      : isActive
        ? theme.cardBgActive
        : isApproved
          ? theme.cardBgApproved
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
      onClick={onSelect}
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
            onClick={e => e.stopPropagation()}
            rows={2}
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
          <div style={{ fontSize: 10, color: theme.textMuted, marginBottom: 4 }}>
            Enter: 改行 / Ctrl+Enter: 保存 / Shift+Enter: ここで分割 / Esc: キャンセル
          </div>
        </>
      ) : (
        <div
          onClick={e => { if (isApproved) return; e.stopPropagation(); setEditTargetText(block.target); setIsEditingTarget(true) }}
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
          {block.target || <span style={{ color: theme.textDisabled, fontStyle: 'italic' }}>（訳文なし）</span>}
        </div>
      )}

      {/* 原文テキスト */}
      {isEditing ? (
        <>
          <textarea
            ref={textareaRef}
            value={editText}
            onChange={e => setEditText(e.target.value)}
            onKeyDown={handleEditKeyDown}
            onBlur={() => handleEditSave()}
            onClick={e => e.stopPropagation()}
            rows={2}
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
          <div style={{ fontSize: 10, color: theme.textMuted, marginTop: 3 }}>
            {t.editHint}
          </div>
        </>
      ) : (
        <div
          onClick={e => { if (isApproved) return; e.stopPropagation(); setIsEditing(true) }}
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
          <TermHighlight text={block.source} terms={block.glossaryTerms} />
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
          CPS: {block.cps.toFixed(1)}
        </span>
        <span style={{ color: isOver ? theme.overCountColor : undefined, fontWeight: isOver ? 700 : undefined }}>
          {t.charCount(sourceLines.map(l => l.length), isOver)}
        </span>
        {missingTerms.length > 0 && (
          <span
            title={`訳語漏れの可能性: ${missingTerms.map(m => `${m.entry.ja} → ${m.entry.en}`).join(', ')}`}
            style={{
              fontSize: 10,
              padding: '2px 7px',
              borderRadius: 999,
              background: theme.cpsBadgeWarn[0],
              color: theme.cpsBadgeWarn[1],
              fontWeight: 700,
              cursor: 'default',
            }}
          >
            用語漏れ {missingTerms.length}
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
          <>
            {/* 再生位置で分割: 再生ヘッドがこのブロック内にあるときのみ有効 */}
            <button
              onClick={e => { e.stopPropagation(); onSplitAtPlayhead(block.id) }}
              disabled={!canSplitAtPlayhead}
              title={canSplitAtPlayhead
                ? `再生位置 (${block.startTime < currentTime && currentTime < block.endTime ? currentTime.toFixed(2) + 's' : '—'}) でカット`
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
