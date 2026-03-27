import { useEffect, useRef, useState, useMemo, Fragment } from 'react'
import type { SubtitleBlock as SubtitleBlockType } from '@/types/subtitle'
import { SubtitleBlock } from './SubtitleBlock'
import { useTheme } from '@/context/ThemeContext'
import { useLocale } from '@/context/LocaleContext'

interface SubtitleBlockListProps {
  blocks: SubtitleBlockType[]
  activeBlockId: number | null
  currentTime: number
  onBlockSelect: (block: SubtitleBlockType) => void
  onApprove: (id: number) => void
  onReSplit: (id: number) => void
  onReTranslate: (id: number) => void
  onUpdateSource: (id: number, text: string) => void
  onUpdateTarget: (id: number, text: string) => void
  onManualSplit: (id: number, textBefore: string, textAfter: string) => void
  onSplitFromTarget: (id: number, targetBefore: string, targetAfter: string) => void
  onSplitAtPlayhead: (id: number) => void
  onEqualSplit: (id: number) => void
  onMerge: (dragId: number, dropId: number) => void
  onAdjustBoundary: (id1: number, id2: number, newTime: number) => void
  onUpdateTimes: (id: number, startTime: number, endTime: number) => void
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
  onReSplit,
  onReTranslate,
  onUpdateSource,
  onUpdateTarget,
  onManualSplit,
  onSplitFromTarget,
  onSplitAtPlayhead,
  onEqualSplit,
  onMerge,
  onAdjustBoundary,
  onUpdateTimes,
}: SubtitleBlockListProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const activeRef = useRef<HTMLDivElement>(null)
  const [draggingId, setDraggingId] = useState<number | null>(null)
  const [dragOverId, setDragOverId] = useState<number | null>(null)
  const [boundaryDrag, setBoundaryDrag] = useState<BoundaryDrag | null>(null)
  const [previewBoundaryTime, setPreviewBoundaryTime] = useState<number | null>(null)
  // stale closure 回避: ref で最新値を保持
  const previewTimeRef = useRef<number | null>(null)

  // アクティブブロックへの自動スクロール
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

  // プレビュー適用済みブロック（ドラッグ中のみ2ブロックを上書き）
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

  const handleDragStart = (id: number) => setDraggingId(id)
  const handleDragEnd = () => { setDraggingId(null); setDragOverId(null) }
  const handleDragOver = (id: number) => setDragOverId(id)

  const handleDrop = (dropId: number) => {
    if (draggingId !== null && draggingId !== dropId) {
      onMerge(draggingId, dropId)
    }
    setDraggingId(null)
    setDragOverId(null)
  }

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

  return (
    <div
      ref={containerRef}
      className="h-full overflow-y-auto"
      style={{ padding: 10 }}
    >
      {displayBlocks.map((block, idx) => (
        <Fragment key={block.id}>
          <div ref={activeBlockId === block.id ? activeRef : undefined}>
            <SubtitleBlock
              block={block}
              isActive={activeBlockId === block.id}
              currentTime={currentTime}
              playProgress={
                currentTime < block.startTime ? 0
                : currentTime > block.endTime ? 100
                : (currentTime - block.startTime) / (block.endTime - block.startTime) * 100
              }
              isDragging={draggingId === block.id}
              isDragOver={dragOverId === block.id && draggingId !== block.id}
              onSelect={() => onBlockSelect(block)}
              onApprove={onApprove}
              onReSplit={onReSplit}
              onReTranslate={onReTranslate}
              onUpdateSource={onUpdateSource}
              onUpdateTarget={onUpdateTarget}
              onManualSplit={onManualSplit}
              onSplitFromTarget={onSplitFromTarget}
              onSplitAtPlayhead={onSplitAtPlayhead}
              onEqualSplit={onEqualSplit}
              onUpdateTimes={onUpdateTimes}
              onDragStart={handleDragStart}
              onDragEnd={handleDragEnd}
              onDragOver={handleDragOver}
              onDrop={handleDrop}
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
  )
}
