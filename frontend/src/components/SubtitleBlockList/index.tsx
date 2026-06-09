import { useEffect, useRef, useState, useMemo, useCallback, Fragment } from 'react'
import type { SubtitleBlock as SubtitleBlockType } from '@/types/subtitle'
import { getCpsLevel } from '@/types/subtitle'
import type { SpellIssue } from '@/lib/pipeline/spellCheck'
import { SubtitleBlock } from './SubtitleBlock'
import { SubtitleSearchBar, type SubtitleSearchState } from './SubtitleSearchBar'
import { findMatches, buildReplaceAll, buildReplaceOne, type SearchMatch } from '@/lib/search/subtitleSearch'
import { isTauri } from '@tauri-apps/api/core'
import { useTheme } from '@/context/ThemeContext'
import { useLocale } from '@/context/LocaleContext'

/** Tauri/ブラウザどちらでも動く確認ダイアログ */
async function confirmDialog(message: string, title: string): Promise<boolean> {
  if (isTauri()) {
    const { confirm } = await import('@tauri-apps/plugin-dialog')
    return await confirm(message, { title, kind: 'warning' })
  }
  return window.confirm(message)
}

interface SubtitleBlockListProps {
  blocks: SubtitleBlockType[]
  activeBlockId: number | null
  currentTime: number
  onBlockSelect: (id: number) => void
  onApprove: (id: number) => void
  onFlag: (id: number) => void
  onUpdateSubtitle: (id: number, text: string) => void
  onUpdateTranscript: (id: number, text: string) => void
  onManualSplit: (id: number, textBefore: string, textAfter: string) => void
  onSplitFromTranscript: (id: number, targetBefore: string, targetAfter: string) => void
  onSplitAtPlayhead: (id: number) => void
  onEqualSplit: (id: number) => void
  onMerge: (dragId: number, dropId: number) => void
  onAdjustBoundary: (id1: number, id2: number, newTime: number) => void
  onUpdateTimes: (id: number, startTime: number, endTime: number) => void
  onIgnoreWarning: (id: number, type: 'typo' | 'missing', key: string) => void
  onDraftChange: (id: number, text: string | null) => void
  onBulkReplace: (updates: Array<{ id: number; source?: string; target?: string }>) => void
  maxCps: number
  maxCharsPerLine: number
  spellIssuesByBlock: Record<number, SpellIssue[]>
  onAddToSpellDictionary: (word: string) => void
}

interface BoundaryDrag {
  blockId1: number
  blockId2: number
  startX: number
  startTime: number  // ドラッグ開始時点の境界時刻
}

const GAP_THRESHOLD = 0.3  // これ以上の空きを表示する（秒）

function TimeBoundaryHandle({
  gap,
  isDragging,
  locked,
  onMouseDown,
}: {
  gap: number
  isDragging: boolean
  locked: boolean
  onMouseDown: (e: React.MouseEvent) => void
}) {
  const { theme } = useTheme()
  const { strings: t } = useLocale()
  const [hovered, setHovered] = useState(false)
  const active = !locked && (hovered || isDragging)
  const hasGap = gap > GAP_THRESHOLD

  // ギャップの長さに応じて高さを変える（最大40px）
  const gapHeight = hasGap ? Math.min(40, 20 + gap * 2) : 16

  const lineColor = isDragging
    ? theme.handleLineDragging
    : active
      ? theme.handleLineActive
      : hasGap
        ? theme.handleLine
        : theme.handleLine

  return (
    <div
      style={{
        height: gapHeight,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'stretch',
        cursor: locked ? 'not-allowed' : 'ew-resize',
        userSelect: 'none',
        position: 'relative',
        justifyContent: 'center',
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onMouseDown={onMouseDown}
    >
      {/* 区切り線 */}
      <div style={{
        flex: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        position: 'relative',
      }}>
        {/* 背景線 */}
        <div style={{
          position: 'absolute',
          left: 0, right: 0,
          height: active ? 2 : 1,
          background: lineColor,
          transition: 'height 0.1s, background 0.1s',
        }} />

        {/* ギャップ表示バッジ */}
        {hasGap && !isDragging && (
          <span style={{
            position: 'relative',
            background: theme.handleTooltipBg,
            border: `1px solid ${active ? theme.handleLineActive : theme.handleTooltipBorder}`,
            borderRadius: 4,
            padding: '1px 8px',
            fontSize: 10,
            color: active ? theme.gapLabelActiveColor : theme.gapLabelColor,
            whiteSpace: 'nowrap',
            pointerEvents: 'none',
            transition: 'color 0.1s, border-color 0.1s',
          }}>
            {t.gapLabel(gap)}
            {active && <span style={{ marginLeft: 6, color: theme.handleTooltipText }}>{t.gapDragHint}</span>}
          </span>
        )}

        {/* ドラッグ中ラベル */}
        {isDragging && (
          <span style={{
            position: 'relative',
            background: theme.handleTooltipBg,
            border: `1px solid ${theme.handleLineDragging}`,
            borderRadius: 4,
            padding: '1px 8px',
            fontSize: 10,
            color: theme.handleTooltipDraggingColor,
            whiteSpace: 'nowrap',
            pointerEvents: 'none',
          }}>
            {t.boundaryDragging}
          </span>
        )}

        {/* ギャップなし・非ドラッグのホバー時 */}
        {!hasGap && !isDragging && active && (
          <span style={{
            position: 'relative',
            background: theme.handleTooltipBg,
            border: `1px solid ${theme.handleTooltipBorder}`,
            borderRadius: 4,
            padding: '1px 8px',
            fontSize: 10,
            color: theme.handleTooltipText,
            whiteSpace: 'nowrap',
            pointerEvents: 'none',
          }}>
            {t.boundaryHover}
          </span>
        )}
      </div>
    </div>
  )
}

export function SubtitleBlockList({
  blocks,
  activeBlockId,
  currentTime,
  onBlockSelect,
  onApprove,
  onFlag,
  onUpdateSubtitle,
  onUpdateTranscript,
  onManualSplit,
  onSplitFromTranscript,
  onSplitAtPlayhead,
  onEqualSplit,
  onMerge,
  onAdjustBoundary,
  onUpdateTimes,
  onIgnoreWarning,
  onDraftChange,
  onBulkReplace,
  maxCps,
  maxCharsPerLine,
  spellIssuesByBlock,
  onAddToSpellDictionary,
}: SubtitleBlockListProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const activeRef = useRef<HTMLDivElement>(null)
  const minimapRef = useRef<HTMLDivElement>(null)
  // ─── 検索・置換ステート ───
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchAutoFocus, setSearchAutoFocus] = useState(false)
  const [searchState, setSearchState] = useState<SubtitleSearchState>({
    query: '',
    replaceWith: '',
    scope: 'all',
    caseSensitive: false,
    wholeWord: false,
    includeApproved: false,
  })
  const [currentMatchIdx, setCurrentMatchIdx] = useState(0)
  const [sliderIndex, setSliderIndex] = useState(0)
  const [scrollRatio, setScrollRatio] = useState(0)
  const [viewportRatio, setViewportRatio] = useState(1)
  const [thumbDragging, setThumbDragging] = useState(false)
  const [boundaryDrag, setBoundaryDrag] = useState<BoundaryDrag | null>(null)
  const [previewBoundaryTime, setPreviewBoundaryTime] = useState<number | null>(null)
  // stale closure 回避: ref で最新値を保持
  const previewTimeRef = useRef<number | null>(null)

  // プレビュー適用済みブロック（境界ドラッグ中のみ2ブロックを上書き）
  const displayBlocks = useMemo(() => {
    if (!boundaryDrag || previewBoundaryTime === null) return blocks
    return blocks.map(b => {
      if (b.id === boundaryDrag.blockId1) {
        const dur = Math.max(0.01, previewBoundaryTime - b.startTime)
        return { ...b, endTime: previewBoundaryTime, cps: Math.round(b.charCount / dur * 10) / 10 }
      }
      if (b.id === boundaryDrag.blockId2) {
        const dur = Math.max(0.01, b.endTime - previewBoundaryTime)
        return { ...b, startTime: previewBoundaryTime, cps: Math.round(b.charCount / dur * 10) / 10 }
      }
      return b
    })
  }, [blocks, boundaryDrag, previewBoundaryTime])

  // ビューポートつまみのドラッグ
  const handleThumbPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation()  // ミニマップのクリックジャンプを防ぐ
    e.currentTarget.setPointerCapture(e.pointerId)
    setThumbDragging(true)
    const startY = e.clientY
    const startScrollRatio = scrollRatio
    const onMove = (ev: PointerEvent) => {
      const el = minimapRef.current
      const container = containerRef.current
      if (!el || !container) return
      const dy = ev.clientY - startY
      const mapHeight = el.clientHeight
      const newRatio = Math.max(0, Math.min(1 - viewportRatio, startScrollRatio + dy / mapHeight))
      container.scrollTop = newRatio * (container.scrollHeight - container.clientHeight)
    }
    const onUp = () => {
      setThumbDragging(false)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [scrollRatio, viewportRatio])

  // スクロール位置をミニマップに同期
  const handleScroll = useCallback(() => {
    const el = containerRef.current
    if (!el) return
    const maxScroll = el.scrollHeight - el.clientHeight
    setScrollRatio(maxScroll > 0 ? el.scrollTop / maxScroll : 0)
    setViewportRatio(el.scrollHeight > 0 ? el.clientHeight / el.scrollHeight : 1)
  }, [])

  // スライダーをアクティブブロックに同期
  useEffect(() => {
    if (activeBlockId === null) return
    const idx = displayBlocks.findIndex(b => b.id === activeBlockId)
    if (idx !== -1) setSliderIndex(idx)
  }, [activeBlockId, displayBlocks])

  // スライダー操作: 対象ブロックにスクロール
  const scrollToIndex = useCallback((idx: number) => {
    setSliderIndex(idx)
    const block = displayBlocks[idx]
    if (!block) return
    const el = containerRef.current?.querySelector(`[data-block-id="${block.id}"]`)
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [displayBlocks])

  // ミニマップのクリック/ドラッグ: 縦位置比率 → ブロックインデックスに変換
  const handleMinimapPointer = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const el = minimapRef.current
    if (!el || displayBlocks.length === 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    const rect = el.getBoundingClientRect()
    const ratio = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height))
    scrollToIndex(Math.round(ratio * (displayBlocks.length - 1)))
  }, [displayBlocks, scrollToIndex])

  const handleMinimapPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.buttons !== 1) return
    const el = minimapRef.current
    if (!el || displayBlocks.length === 0) return
    const rect = el.getBoundingClientRect()
    const ratio = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height))
    scrollToIndex(Math.round(ratio * (displayBlocks.length - 1)))
  }, [displayBlocks, scrollToIndex])

  // アクティブブロックへの自動スクロール（再生中に位置がずれたとき）
  useEffect(() => {
    if (activeRef.current && containerRef.current) {
      const container = containerRef.current
      const el = activeRef.current
      const containerTop = container.scrollTop
      const containerBottom = containerTop + container.clientHeight
      const elTop = el.offsetTop
      const elBottom = elTop + el.clientHeight
      if (elTop < containerTop + 60 || elBottom > containerBottom - 60) {
        el.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
      }
    }
  }, [activeBlockId])

  // タブ切り替えで戻った時（マウント時）にアクティブブロックを先頭へ
  useEffect(() => {
    if (!activeBlockId || !containerRef.current) return
    const container = containerRef.current
    const el = container.querySelector(`[data-block-id="${activeBlockId}"]`) as HTMLElement | null
    if (!el) return
    const containerRect = container.getBoundingClientRect()
    const elRect = el.getBoundingClientRect()
    container.scrollTop = Math.max(0, container.scrollTop + (elRect.top - containerRect.top) - 6)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ─── 検索マッチ計算 ───
  const matches: SearchMatch[] = useMemo(
    () => findMatches(blocks, {
      query: searchOpen ? searchState.query : '',
      scope: searchState.scope,
      caseSensitive: searchState.caseSensitive,
      wholeWord: searchState.wholeWord,
      includeApproved: searchState.includeApproved,
    }),
    [blocks, searchOpen, searchState.query, searchState.scope, searchState.caseSensitive, searchState.wholeWord, searchState.includeApproved],
  )

  // マッチ数変化に追従してインデックスを範囲内に収める
  useEffect(() => {
    if (matches.length === 0) {
      if (currentMatchIdx !== 0) setCurrentMatchIdx(0)
      return
    }
    if (currentMatchIdx >= matches.length) setCurrentMatchIdx(0)
  }, [matches.length, currentMatchIdx])

  // 現在マッチのブロックへスクロール
  const scrollToBlock = useCallback((blockId: number) => {
    const el = containerRef.current?.querySelector(`[data-block-id="${blockId}"]`)
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [])

  useEffect(() => {
    if (!searchOpen || matches.length === 0) return
    const m = matches[currentMatchIdx]
    if (m) scrollToBlock(m.blockId)
  }, [searchOpen, currentMatchIdx, matches, scrollToBlock])

  const handleToggleSearch = useCallback(() => {
    setSearchOpen(open => {
      const next = !open
      if (next) {
        setSearchAutoFocus(true)
        setTimeout(() => setSearchAutoFocus(false), 50)
      }
      return next
    })
  }, [])

  const gotoNext = useCallback(() => {
    if (matches.length === 0) return
    setCurrentMatchIdx(i => (i + 1) % matches.length)
  }, [matches.length])
  const gotoPrev = useCallback(() => {
    if (matches.length === 0) return
    setCurrentMatchIdx(i => (i - 1 + matches.length) % matches.length)
  }, [matches.length])

  const handleReplaceCurrent = useCallback(() => {
    if (matches.length === 0) return
    const m = matches[currentMatchIdx]
    const block = blocks.find(b => b.id === m.blockId)
    if (!block) return
    const upd = buildReplaceOne(block, m, searchState.replaceWith)
    onBulkReplace([{ id: block.id, ...upd }])
    // インデックスは据え置き：マッチが1つ減るので、次のマッチが自動的にこの位置に来る
  }, [matches, currentMatchIdx, blocks, searchState.replaceWith, onBulkReplace])

  const handleReplaceAll = useCallback(async () => {
    if (matches.length === 0) return
    const result = buildReplaceAll(blocks, {
      query: searchState.query,
      scope: searchState.scope,
      caseSensitive: searchState.caseSensitive,
      wholeWord: searchState.wholeWord,
      includeApproved: searchState.includeApproved,
    }, searchState.replaceWith)
    if (result.replacedCount === 0) return
    const ok = await confirmDialog(
      `${result.replacedCount} 件を「${searchState.replaceWith}」に置換します。よろしいですか？`,
      'すべて置換',
    )
    if (!ok) return
    onBulkReplace(result.updates)
  }, [blocks, matches.length, searchState, onBulkReplace])

  // Ctrl+F / Cmd+F で検索バーをトグル
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const isFind = (e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')
      if (!isFind) return
      // 字幕タブ内のテキストエリア中でも有効にしたい→デフォルトのブラウザ検索を上書き
      e.preventDefault()
      setSearchOpen(true)
      setSearchAutoFocus(true)
      // 直後にフラグを下ろす
      setTimeout(() => setSearchAutoFocus(false), 50)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  // ブロックごとの searchRanges を事前計算（メモ化）
  const searchRangesByBlock = useMemo(() => {
    const map = new Map<number, { transcript: { start: number; end: number; current?: boolean }[]; subtitle: { start: number; end: number; current?: boolean }[] }>()
    if (!searchOpen || matches.length === 0) return map
    const currentMatch = matches[currentMatchIdx]
    for (const m of matches) {
      const entry = map.get(m.blockId) ?? { transcript: [], subtitle: [] }
      const range = {
        start: m.start,
        end: m.end,
        current: currentMatch && currentMatch.blockId === m.blockId && currentMatch.field === m.field
          && currentMatch.start === m.start && currentMatch.end === m.end,
      }
      if (m.field === 'transcript') entry.transcript.push(range)
      else entry.subtitle.push(range)
      map.set(m.blockId, entry)
    }
    return map
  }, [matches, currentMatchIdx, searchOpen])

  // 境界ドラッグ中のカーソル変更
  useEffect(() => {
    if (boundaryDrag) {
      document.body.style.cursor = 'ew-resize'
      return () => { document.body.style.cursor = '' }
    }
  }, [boundaryDrag])

  // 境界ドラッグの mousemove / mouseup
  useEffect(() => {
    if (!boundaryDrag) return

    const handleMouseMove = (e: MouseEvent) => {
      // Ctrl を離したらキャンセル
      if (!e.ctrlKey) {
        previewTimeRef.current = null
        setPreviewBoundaryTime(null)
        setBoundaryDrag(null)
        return
      }
      const dx = e.clientX - boundaryDrag.startX
      const dtSeconds = dx / 50  // 50px = 1秒
      const block1 = blocks.find(b => b.id === boundaryDrag.blockId1)
      const block2 = blocks.find(b => b.id === boundaryDrag.blockId2)
      if (!block1 || !block2) return
      const minTime = block1.startTime + 0.1
      const maxTime = block2.endTime - 0.1
      const newTime = Math.max(minTime, Math.min(maxTime, boundaryDrag.startTime + dtSeconds))
      previewTimeRef.current = newTime
      setPreviewBoundaryTime(newTime)
    }

    const handleMouseUp = () => {
      if (previewTimeRef.current !== null) {
        onAdjustBoundary(boundaryDrag.blockId1, boundaryDrag.blockId2, previewTimeRef.current)
      }
      previewTimeRef.current = null
      setPreviewBoundaryTime(null)
      setBoundaryDrag(null)
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [boundaryDrag, blocks, onAdjustBoundary])

  const handleApprove = useCallback((id: number) => {
    // 承認解除（approved → pending）の場合はスクロールしない
    const isUnapproving = displayBlocks.find(b => b.id === id)?.status === 'approved'
    onApprove(id)
    if (isUnapproving) return
    // 承認したブロックがリスト先頭なら次のブロックを先頭にスライド
    requestAnimationFrame(() => {
      const idx = displayBlocks.findIndex(b => b.id === id)
      if (idx < 0 || idx >= displayBlocks.length - 1) return
      const container = containerRef.current
      const approvedEl = container?.querySelector(`[data-block-id="${id}"]`) as HTMLElement | null
      if (!container || !approvedEl) return
      // getBoundingClientRect でコンテナからの相対位置を正確に取得
      const containerRect = container.getBoundingClientRect()
      const approvedRect = approvedEl.getBoundingClientRect()
      const relativeTop = approvedRect.top - containerRect.top
      if (relativeTop >= -10 && relativeTop < approvedEl.clientHeight) {
        const nextEl = container.querySelector(`[data-block-id="${displayBlocks[idx + 1].id}"]`) as HTMLElement | null
        if (nextEl) {
          const nextRect = nextEl.getBoundingClientRect()
          const targetScrollTop = container.scrollTop + (nextRect.top - containerRect.top) - 6
          container.scrollTo({ top: targetScrollTop, behavior: 'smooth' })
          onBlockSelect(displayBlocks[idx + 1].id)
        }
      }
    })
  }, [onApprove, onBlockSelect, displayBlocks])

  const handleBoundaryMouseDown = (
    e: React.MouseEvent,
    id1: number,
    id2: number,
    block1EndTime: number,
    block2StartTime: number,
    isLocked: boolean,
  ) => {
    if (!e.ctrlKey || isLocked) return
    e.preventDefault()
    e.stopPropagation()
    // ギャップがある場合は中点をドラッグ基準にすることで左右対称の奪い合いになる
    const startTime = (block1EndTime + block2StartTime) / 2
    setBoundaryDrag({ blockId1: id1, blockId2: id2, startX: e.clientX, startTime })
  }

  const { theme } = useTheme()

  // ミニマップのアクティブブロック位置（%）
  const minimapActiveRatio = displayBlocks.length > 1
    ? sliderIndex / (displayBlocks.length - 1)
    : 0

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {searchOpen && (
        <SubtitleSearchBar
          state={searchState}
          onChange={s => {
            setSearchState(s)
            setCurrentMatchIdx(0)
          }}
          matchCount={matches.length}
          currentIndex={matches.length > 0 ? currentMatchIdx : -1}
          onPrev={gotoPrev}
          onNext={gotoNext}
          onReplaceCurrent={handleReplaceCurrent}
          onReplaceAll={handleReplaceAll}
          onClose={() => setSearchOpen(false)}
          autoFocus={searchAutoFocus}
        />
      )}
      <div className="flex-1 flex overflow-hidden min-h-0">

      {/* メインスクロール領域 */}
      <div
        ref={containerRef}
        className="flex-1 overflow-y-auto"
        style={{ padding: 10 }}
        onScroll={handleScroll}
      >
      {displayBlocks.map((block, idx) => (
        <Fragment key={block.id}>
          <div
            ref={activeBlockId === block.id ? activeRef : undefined}
            data-block-id={block.id}
          >
            <SubtitleBlock
              block={block}
              isActive={activeBlockId === block.id}
              isCurrentlyPlaying={currentTime >= block.startTime && currentTime <= block.endTime}
              playProgress={
                currentTime < block.startTime ? 0
                : currentTime > block.endTime ? 100
                : (currentTime - block.startTime) / (block.endTime - block.startTime) * 100
              }
              onSelect={onBlockSelect}
              onApprove={handleApprove}
              onFlag={onFlag}
              onUpdateSubtitle={onUpdateSubtitle}
              onUpdateTranscript={onUpdateTranscript}
              onManualSplit={onManualSplit}
              onSplitFromTranscript={onSplitFromTranscript}
              onSplitAtPlayhead={onSplitAtPlayhead}
              onEqualSplit={onEqualSplit}
              onUpdateTimes={onUpdateTimes}
              onIgnoreWarning={onIgnoreWarning}
              onDraftChange={onDraftChange}
              canMergePrevious={idx > 0 && displayBlocks[idx - 1].status !== 'approved'}
              canMergeNext={idx < displayBlocks.length - 1 && displayBlocks[idx + 1].status !== 'approved'}
              onMergeWithPrevious={id => {
                const currentIdx = displayBlocks.findIndex(b => b.id === id)
                const prev = currentIdx > 0 ? displayBlocks[currentIdx - 1] : undefined
                if (prev && prev.status !== 'approved') onMerge(prev.id, id)
              }}
              onMergeWithNext={id => {
                const currentIdx = displayBlocks.findIndex(b => b.id === id)
                const next = currentIdx >= 0 ? displayBlocks[currentIdx + 1] : undefined
                if (next && next.status !== 'approved') onMerge(id, next.id)
              }}
              maxCps={maxCps}
              maxCharsPerLine={maxCharsPerLine}
              spellIssues={spellIssuesByBlock[block.id]}
              onAddToSpellDictionary={onAddToSpellDictionary}
              searchRangesTranscript={searchRangesByBlock.get(block.id)?.transcript}
              searchRangesSubtitle={searchRangesByBlock.get(block.id)?.subtitle}
              searchOpen={searchOpen}
              onToggleSearch={handleToggleSearch}
            />
          </div>
          {idx < displayBlocks.length - 1 && (() => {
            const next = displayBlocks[idx + 1]
            const locked = block.status === 'approved' || next.status === 'approved'
            return (
              <TimeBoundaryHandle
                gap={next.startTime - block.endTime}
                isDragging={
                  boundaryDrag !== null &&
                  boundaryDrag.blockId1 === block.id
                }
                locked={locked}
                onMouseDown={e =>
                  handleBoundaryMouseDown(
                    e,
                    block.id,
                    next.id,
                    block.endTime,
                    next.startTime,
                    locked,
                  )
                }
              />
            )
          })()}
        </Fragment>
      ))}
      </div>

      {/* 右サイドバー：ミニマップ＋スライダー */}
      {displayBlocks.length > 0 && (
        <div style={{
          width: 28,
          flexShrink: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          padding: '6px 0',
          borderLeft: `1px solid ${theme.panelBorder}`,
          background: theme.headerBg,
          gap: 4,
          userSelect: 'none',
        }}>
          {/* 現在ブロック番号 */}
          <span style={{ fontSize: 9, color: theme.textMuted, lineHeight: 1.2, textAlign: 'center' }}>
            {sliderIndex + 1}
          </span>

          {/* ミニマップ本体 */}
          <div
            ref={minimapRef}
            style={{
              flex: 1,
              width: 14,
              borderRadius: 3,
              background: theme.panelBg,
              border: `1px solid ${theme.panelBorder}`,
              position: 'relative',
              cursor: 'pointer',
              overflow: 'hidden',
            }}
            onPointerDown={handleMinimapPointer}
            onPointerMove={handleMinimapPointerMove}
          >
            {/* 各ブロックをCPS色でストライプ表示：問題あるほど目立つ */}
            {displayBlocks.map((b, i) => {
              const level = getCpsLevel(b.cps, maxCps)
              const color = level === 'ok'
                ? theme.cpsBadgeOk[0]
                : level === 'warn'
                  ? theme.cpsBadgeWarn[0]
                  : theme.cpsBadgeError[0]
              const opacity = b.status === 'approved'
                ? 0.15
                : level === 'ok'   ? 0.22
                : level === 'warn' ? 0.65
                : 0.9   // error
              const top = (i / displayBlocks.length) * 100
              const height = Math.max(1, 100 / displayBlocks.length)
              return (
                <div key={b.id} style={{
                  position: 'absolute',
                  left: 0, right: 0,
                  top: `${top}%`,
                  height: `${height}%`,
                  minHeight: 1,
                  background: b.status === 'approved' ? theme.cardBorderApproved : color,
                  opacity,
                }} />
              )
            })}

            {/* ビューポートつまみ（ドラッグでスクロール） */}
            <div
              onPointerDown={handleThumbPointerDown}
              style={{
                position: 'absolute',
                left: 0, right: 0,
                top: `${scrollRatio * (1 - viewportRatio) * 100}%`,
                height: `${viewportRatio * 100}%`,
                background: thumbDragging
                  ? 'rgba(255,255,255,0.22)'
                  : 'rgba(255,255,255,0.13)',
                border: thumbDragging
                  ? '1.5px solid rgba(255,255,255,0.75)'
                  : '1.5px solid rgba(255,255,255,0.45)',
                borderRadius: 2,
                cursor: thumbDragging ? 'grabbing' : 'grab',
                boxSizing: 'border-box',
                transition: thumbDragging ? 'none' : 'background 0.15s, border-color 0.15s',
              }}
            >
              {/* 中央のグリップライン */}
              <div style={{
                position: 'absolute',
                left: '25%', right: '25%',
                top: '50%',
                transform: 'translateY(-50%)',
                display: 'flex',
                flexDirection: 'column',
                gap: 2,
                pointerEvents: 'none',
              }}>
                {[0, 1, 2].map(i => (
                  <div key={i} style={{
                    height: 1,
                    background: 'rgba(255,255,255,0.5)',
                    borderRadius: 1,
                  }} />
                ))}
              </div>
            </div>

            {/* カーソル（アクティブブロック位置）: 白＋黒アウトラインでどの背景でも視認できる */}
            <div style={{
              position: 'absolute',
              left: 0, right: 0,
              top: `${minimapActiveRatio * 100}%`,
              height: 2,
              background: '#ffffff',
              transform: 'translateY(-50%)',
              borderRadius: 1,
              pointerEvents: 'none',
              boxShadow: '0 1px 0 rgba(0,0,0,0.7), 0 -1px 0 rgba(0,0,0,0.7)',
            }} />
          </div>

          {/* 総ブロック数 */}
          <span style={{ fontSize: 9, color: theme.textMuted, lineHeight: 1.2, textAlign: 'center' }}>
            {displayBlocks.length}
          </span>
        </div>
      )}

      </div>
    </div>
  )
}
