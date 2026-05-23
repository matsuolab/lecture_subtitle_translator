import { useEffect, useRef } from 'react'
import { useTheme } from '@/context/ThemeContext'
import type { SearchScope } from '@/lib/search/subtitleSearch'
import { SUBTITLE_FIELD_LABELS } from '@/types/subtitle'

export interface SubtitleSearchState {
  query: string
  replaceWith: string
  scope: SearchScope
  caseSensitive: boolean
  wholeWord: boolean
  includeApproved: boolean
}

interface SubtitleSearchBarProps {
  state: SubtitleSearchState
  onChange: (next: SubtitleSearchState) => void
  matchCount: number
  currentIndex: number  // 0-based, -1 if none
  onPrev: () => void
  onNext: () => void
  onReplaceCurrent: () => void
  onReplaceAll: () => void
  onClose: () => void
  /** マウント時に入力欄へフォーカス */
  autoFocus?: boolean
}

const SCOPE_OPTIONS: Array<{ value: SearchScope; label: string }> = [
  { value: 'all', label: 'すべて' },
  { value: 'source', label: `${SUBTITLE_FIELD_LABELS.source}のみ` },
  { value: 'target', label: `${SUBTITLE_FIELD_LABELS.target}のみ` },
]

export function SubtitleSearchBar({
  state,
  onChange,
  matchCount,
  currentIndex,
  onPrev,
  onNext,
  onReplaceCurrent,
  onReplaceAll,
  onClose,
  autoFocus,
}: SubtitleSearchBarProps) {
  const { theme } = useTheme()
  const queryRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (autoFocus && queryRef.current) {
      queryRef.current.focus()
      queryRef.current.select()
    }
  }, [autoFocus])

  const update = <K extends keyof SubtitleSearchState>(key: K, value: SubtitleSearchState[K]) => {
    onChange({ ...state, [key]: value })
  }

  const hasMatches = matchCount > 0
  const hasQuery = state.query.length > 0

  const baseBtn: React.CSSProperties = {
    padding: '3px 8px',
    fontSize: 11,
    background: theme.cardBg,
    color: theme.textPrimary,
    border: `1px solid ${theme.panelBorder}`,
    borderRadius: 4,
    cursor: 'pointer',
  }
  const disabledBtn: React.CSSProperties = {
    ...baseBtn,
    opacity: 0.4,
    cursor: 'not-allowed',
  }
  const inputStyle: React.CSSProperties = {
    flex: 1,
    minWidth: 0,
    padding: '4px 8px',
    fontSize: 12,
    background: theme.panelBg,
    color: theme.textPrimary,
    border: `1px solid ${theme.panelBorder}`,
    borderRadius: 4,
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: '8px 10px',
        background: theme.headerBg,
        borderBottom: `1px solid ${theme.panelBorder}`,
      }}
    >
      {/* 検索行 */}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <span style={{ fontSize: 11, color: theme.textMuted, minWidth: 40 }}>検索</span>
        <input
          ref={queryRef}
          type="text"
          value={state.query}
          onChange={e => update('query', e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') {
              e.preventDefault()
              if (e.shiftKey) onPrev()
              else onNext()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              onClose()
            }
          }}
          placeholder="検索する文字列"
          style={inputStyle}
        />
        <span style={{ fontSize: 11, color: theme.textMuted, minWidth: 60, textAlign: 'right' }}>
          {hasQuery ? (hasMatches ? `${currentIndex + 1} / ${matchCount}` : '一致なし') : ''}
        </span>
        <button
          type="button"
          onClick={onPrev}
          disabled={!hasMatches}
          style={hasMatches ? baseBtn : disabledBtn}
          title="前のマッチ (Shift+Enter)"
        >
          ▲
        </button>
        <button
          type="button"
          onClick={onNext}
          disabled={!hasMatches}
          style={hasMatches ? baseBtn : disabledBtn}
          title="次のマッチ (Enter)"
        >
          ▼
        </button>
        <button type="button" onClick={onClose} style={baseBtn} title="閉じる (Esc)">
          ✕
        </button>
      </div>

      {/* 置換行 */}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <span style={{ fontSize: 11, color: theme.textMuted, minWidth: 40 }}>置換</span>
        <input
          type="text"
          value={state.replaceWith}
          onChange={e => update('replaceWith', e.target.value)}
          placeholder="置換後の文字列（空で削除）"
          style={inputStyle}
        />
        <button
          type="button"
          onClick={onReplaceCurrent}
          disabled={!hasMatches}
          style={hasMatches ? baseBtn : disabledBtn}
          title="このマッチを置換"
        >
          置換
        </button>
        <button
          type="button"
          onClick={onReplaceAll}
          disabled={!hasMatches}
          style={hasMatches ? baseBtn : disabledBtn}
          title="すべて置換（確認あり）"
        >
          すべて置換
        </button>
      </div>

      {/* スコープ + オプション */}
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', border: `1px solid ${theme.panelBorder}`, borderRadius: 4, overflow: 'hidden' }}>
          {SCOPE_OPTIONS.map(opt => {
            const active = state.scope === opt.value
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => update('scope', opt.value)}
                style={{
                  padding: '3px 10px',
                  fontSize: 11,
                  background: active ? theme.textAccentLink : 'transparent',
                  color: active ? '#fff' : theme.textPrimary,
                  border: 'none',
                  cursor: 'pointer',
                }}
              >
                {opt.label}
              </button>
            )
          })}
        </div>

        <label style={{ fontSize: 11, color: theme.textPrimary, display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={state.caseSensitive}
            onChange={e => update('caseSensitive', e.target.checked)}
          />
          大文字/小文字区別
        </label>
        <label style={{ fontSize: 11, color: theme.textPrimary, display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={state.wholeWord}
            onChange={e => update('wholeWord', e.target.checked)}
          />
          単語単位
        </label>
        <label style={{ fontSize: 11, color: theme.textPrimary, display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={state.includeApproved}
            onChange={e => update('includeApproved', e.target.checked)}
          />
          承認済みも対象
        </label>
      </div>
    </div>
  )
}
