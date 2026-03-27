import { useRef, useState, useEffect, useCallback, useMemo } from 'react'
import type { SubtitleBlock } from '@/types/subtitle'
import { formatTime } from '@/types/subtitle'
import { TimelineBlock } from './TimelineBlock'
import { useTheme } from '@/context/ThemeContext'

interface TimelineBarProps {
  blocks: SubtitleBlock[]
  currentTime: number
  totalDuration: number
  activeBlockId: number | null
  onSeek: (seconds: number) => void
  onBlockSelect: (block: SubtitleBlock) => void
  onAdjustBoundary: (id1: number, id2: number, newTime: number) => void
  trackHeight?: number
}

const BOUNDARY_SNAP_PX = 8

type DragKind = 'seek' | 'boundary'

function getNiceTickInterval(visibleDuration: number): number {
  const candidates = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600]
  const ideal = visibleDuration / 8
  return candidates.find(t => t >= ideal) ?? 3600
}

export function TimelineBar({
  blocks,
  currentTime,
  totalDuration,
  activeBlockId,
  onSeek,
  onBlockSelect,
  onAdjustBoundary,
  trackHeight = 32,
}: TimelineBarProps) {
  const { theme } = useTheme()
  const containerRef = useRef<HTMLDivElement>(null)
  const [containerWidth, setContainerWidth] = useState(0)
  const [dragKind, setDragKind] = useState<DragKind | null>(null)
  const [hoverX, setHoverX] = useState<number | null>(null)
  const [ctrlHeld, setCtrlHeld] = useState(false)

  // ズーム / パン
  const [zoomLevel, setZoomLevel] = useState(1)
  const [viewStart, setViewStart] = useState(0)
  const zoomRef = useRef(zoomLevel)
  const viewStartRef = useRef(viewStart)
  useEffect(() => { zoomRef.current = zoomLevel }, [zoomLevel])
  useEffect(() => { viewStartRef.current = viewStart }, [viewStart])

  const visibleDuration = totalDuration > 0 ? totalDuration / zoomLevel : 0

  // 境界ドラッグのプレビュー
  const [previewBoundary, setPreviewBoundary] = useState<{
    id1: number; id2: number; time: number
  } | null>(null)
  const previewBoundaryRef = useRef<{ id1: number; id2: number; time: number } | null>(null)

  // コンテナ幅の監視
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const observer = new ResizeObserver(entries => {
      setContainerWidth(entries[0].contentRect.width)
    })
    observer.observe(el)
    setContainerWidth(el.clientWidth)
    return () => observer.disconnect()
  }, [])

  // Ctrl キー追跡
  useEffect(() => {
    const onDown = (e: KeyboardEvent) => { if (e.key === 'Control') setCtrlHeld(true) }
    const onUp   = (e: KeyboardEvent) => { if (e.key === 'Control') setCtrlHeld(false) }
    const onBlur = () => setCtrlHeld(false)
    window.addEventListener('keydown', onDown)
    window.addEventListener('keyup', onUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onDown)
      window.removeEventListener('keyup', onUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [])

  // 再生ヘッドが画面外に出たら自動追従（ズーム時のみ）
  useEffect(() => {
    if (zoomLevel <= 1 || visibleDuration === 0) return
    const vs = viewStartRef.current
    const vd = visibleDuration
    if (currentTime < vs || currentTime > vs + vd) {
      const newVS = Math.max(0, Math.min(totalDuration - vd, currentTime - vd * 0.3))
      setViewStart(newVS)
    }
  // currentTime の変化のみ追従トリガー（viewStart/visibleDuration を含めると無限ループ）
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTime])

  // スクロールホイールでズーム（containerRef のネイティブイベント）
  const handleWheel = useCallback((e: WheelEvent) => {
    if (totalDuration === 0 || containerWidth === 0) return
    e.preventDefault()

    const rect = containerRef.current!.getBoundingClientRect()
    const cursorX = Math.max(0, Math.min(rect.width, e.clientX - rect.left))
    const cursorTime = viewStartRef.current + (cursorX / containerWidth) * (totalDuration / zoomRef.current)

    const factor = e.deltaY < 0 ? 1.25 : 0.8
    const newZoom = Math.max(1, Math.min(20, zoomRef.current * factor))
    const newVD = totalDuration / newZoom
    const newVS = Math.max(0, Math.min(totalDuration - newVD, cursorTime - (cursorX / containerWidth) * newVD))

    setZoomLevel(newZoom)
    setViewStart(newVS)
  }, [totalDuration, containerWidth])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    el.addEventListener('wheel', handleWheel, { passive: false })
    return () => el.removeEventListener('wheel', handleWheel)
  }, [handleWheel])

  const resetZoom = useCallback(() => {
    setZoomLevel(1)
    setViewStart(0)
  }, [])

  // --- 座標変換 ---
  const playheadLeft = visibleDuration > 0
    ? ((currentTime - viewStart) / visibleDuration) * containerWidth
    : 0

  const detectBoundary = useCallback((x: number): { kind: 'boundary'; id1: number; id2: number } | null => {
    for (let i = 0; i < blocks.length - 1; i++) {
      const b1 = blocks[i]
      const b2 = blocks[i + 1]
      if (b1.status === 'approved' || b2.status === 'approved') continue
      const bx = visibleDuration > 0 ? ((b1.endTime - viewStart) / visibleDuration) * containerWidth : 0
      if (Math.abs(x - bx) <= BOUNDARY_SNAP_PX) {
        return { kind: 'boundary', id1: b1.id, id2: b2.id }
      }
    }
    return null
  }, [blocks, viewStart, visibleDuration, containerWidth])

  const getCursor = useCallback((): string => {
    if (dragKind === 'boundary') return 'col-resize'
    if (dragKind === 'seek') return 'crosshair'
    if (hoverX !== null && ctrlHeld && detectBoundary(hoverX)) return 'col-resize'
    return 'crosshair'
  }, [dragKind, hoverX, ctrlHeld, detectBoundary])

  const getTime = useCallback((clientX: number): number => {
    if (!containerRef.current) return 0
    const r = containerRef.current.getBoundingClientRect()
    const px = Math.max(0, Math.min(r.width, clientX - r.left))
    return Math.max(0, Math.min(totalDuration, viewStart + (px / r.width) * visibleDuration))
  }, [totalDuration, viewStart, visibleDuration])

  const cancelBoundaryDrag = useCallback((
    onMove: (mv: MouseEvent) => void,
    onUp: (mu: MouseEvent) => void,
  ) => {
    previewBoundaryRef.current = null
    setPreviewBoundary(null)
    setDragKind(null)
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
  }, [])

  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    if (!containerRef.current) return
    e.preventDefault()

    const rect = containerRef.current.getBoundingClientRect()
    const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left))
    const boundary = e.ctrlKey ? detectBoundary(x) : null

    if (boundary) {
      setDragKind('boundary')
      const initTime = getTime(e.clientX)
      const pb = { id1: boundary.id1, id2: boundary.id2, time: initTime }
      previewBoundaryRef.current = pb
      setPreviewBoundary(pb)

      const onMove = (mv: MouseEvent) => {
        if (!mv.ctrlKey) { cancelBoundaryDrag(onMove, onUp); return }
        const t = getTime(mv.clientX)
        const updated = { id1: boundary.id1, id2: boundary.id2, time: t }
        previewBoundaryRef.current = updated
        setPreviewBoundary(updated)
      }
      const onUp = (mu: MouseEvent) => {
        if (mu.ctrlKey && previewBoundaryRef.current !== null) {
          onAdjustBoundary(boundary.id1, boundary.id2, previewBoundaryRef.current.time)
        }
        previewBoundaryRef.current = null
        setPreviewBoundary(null)
        setDragKind(null)
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    } else {
      setDragKind('seek')
      onSeek(getTime(e.clientX))
      const onMove = (mv: MouseEvent) => { onSeek(getTime(mv.clientX)) }
      const onUp = () => {
        setDragKind(null)
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    }
  }, [detectBoundary, getTime, onSeek, onAdjustBoundary, cancelBoundaryDrag])

  // 境界ドラッグ中はブロック位置をプレビュー値で上書き
  const displayBlocks = useMemo(() => {
    if (!previewBoundary) return blocks
    return blocks.map(b => {
      if (b.id === previewBoundary.id1) return { ...b, endTime: previewBoundary.time }
      if (b.id === previewBoundary.id2) return { ...b, startTime: previewBoundary.time }
      return b
    })
  }, [blocks, previewBoundary])

  // ズームレベルに応じたスマートティック
  const ticks = useMemo(() => {
    if (totalDuration === 0 || visibleDuration === 0) return []
    const interval = getNiceTickInterval(visibleDuration)
    const firstTick = Math.ceil(viewStart / interval) * interval
    const result: { time: number; left: number }[] = []
    for (let t = firstTick; t <= viewStart + visibleDuration + 0.001; t += interval) {
      const left = ((t - viewStart) / visibleDuration) * 100
      if (left >= -1 && left <= 101) result.push({ time: t, left })
    }
    return result
  }, [visibleDuration, viewStart, totalDuration])

  // Ctrl+ホバー中の境界ハイライト位置
  const hoveredBoundaryX: number | null = (() => {
    if (hoverX === null || dragKind !== null || !ctrlHeld) return null
    const found = detectBoundary(hoverX)
    if (!found) return null
    const b1 = blocks.find(b => b.id === found.id1)
    if (!b1 || visibleDuration === 0) return null
    return ((b1.endTime - viewStart) / visibleDuration) * containerWidth
  })()

  // プレビュー中の境界ライン位置
  const draggingBoundaryX: number | null = previewBoundary && visibleDuration > 0
    ? ((previewBoundary.time - viewStart) / visibleDuration) * containerWidth
    : null

  // ホバー時刻（ツールチップ用）
  const hoverTime: number | null = hoverX !== null && visibleDuration > 0
    ? Math.max(0, Math.min(totalDuration, viewStart + (hoverX / containerWidth) * visibleDuration))
    : null

  // ミニマップクリック/ドラッグでパン
  const handleMinimapMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0 || totalDuration === 0) return
    e.preventDefault()
    e.stopPropagation()
    const el = e.currentTarget
    const updateView = (clientX: number) => {
      const rect = el.getBoundingClientRect()
      const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
      const targetTime = pct * totalDuration
      const vd = totalDuration / zoomRef.current
      const newVS = Math.max(0, Math.min(totalDuration - vd, targetTime - vd / 2))
      setViewStart(newVS)
    }
    updateView(e.clientX)
    const onMove = (mv: MouseEvent) => updateView(mv.clientX)
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [totalDuration])

  return (
    <div
      style={{
        background: theme.videoControlsBg,
        borderTop: `1px solid ${theme.panelBorder}`,
        padding: '4px 8px 6px',
        flexShrink: 0,
      }}
    >
      {/* ミニマップ（ズーム時のみ） */}
      {zoomLevel > 1 && totalDuration > 0 && (
        <div
          style={{
            position: 'relative', height: 14, marginBottom: 4,
            cursor: 'pointer', borderRadius: 3, overflow: 'hidden',
            background: '#111', border: `1px solid ${theme.panelBorder}`,
          }}
          onMouseDown={handleMinimapMouseDown}
        >
          {/* 字幕ブロック */}
          {blocks.map(b => (
            <div key={b.id} style={{
              position: 'absolute', top: 2, bottom: 2,
              left: `${(b.startTime / totalDuration) * 100}%`,
              width: `${Math.max((b.endTime - b.startTime) / totalDuration * 100, 0.15)}%`,
              background: b.status === 'approved' ? '#22c55e' : '#3b82f6',
              opacity: 0.75,
            }} />
          ))}
          {/* 再生ヘッド */}
          <div style={{
            position: 'absolute', top: 0, bottom: 0,
            left: `${(currentTime / totalDuration) * 100}%`,
            width: 1, background: theme.accent, pointerEvents: 'none',
          }} />
          {/* 可視範囲インジケーター */}
          <div style={{
            position: 'absolute', top: 0, bottom: 0,
            left: `${(viewStart / totalDuration) * 100}%`,
            width: `${(visibleDuration / totalDuration) * 100}%`,
            background: 'rgba(255,255,255,0.12)',
            border: '1px solid rgba(255,255,255,0.4)',
            borderRadius: 2, pointerEvents: 'none',
          }} />
        </div>
      )}

      {/* 時間ラベル行 */}
      <div style={{ position: 'relative', height: 14, marginBottom: 2 }}>
        {ticks.map(tick => (
          <span
            key={tick.time}
            style={{
              position: 'absolute', left: `${tick.left}%`,
              transform: 'translateX(-50%)',
              fontFamily: 'monospace', fontSize: 9,
              color: theme.videoTimeColor, whiteSpace: 'nowrap', userSelect: 'none',
            }}
          >
            {formatTime(tick.time)}
          </span>
        ))}
      </div>

      {/* メイントラック（ツールチップ用ラッパー） */}
      <div style={{ position: 'relative' }}>
        {/* ホバー時刻ツールチップ */}
        {hoverTime !== null && hoverX !== null && dragKind === null && (
          <div style={{
            position: 'absolute',
            bottom: 'calc(100% + 3px)',
            left: hoverX,
            transform: 'translateX(-50%)',
            background: 'rgba(0,0,0,0.85)',
            color: '#fff', fontSize: 10,
            padding: '2px 6px', borderRadius: 3,
            whiteSpace: 'nowrap', pointerEvents: 'none', zIndex: 20,
          }}>
            {formatTime(hoverTime)}
          </div>
        )}

        <div
          ref={containerRef}
          style={{
            position: 'relative', height: trackHeight,
            background: '#0A0A0A', borderRadius: 4,
            cursor: getCursor(), overflow: 'hidden',
            userSelect: 'none', border: `1px solid ${theme.panelBorder}`,
          }}
          onMouseDown={handleMouseDown}
          onMouseMove={e => {
            if (!containerRef.current) return
            const rect = containerRef.current.getBoundingClientRect()
            setHoverX(Math.max(0, Math.min(rect.width, e.clientX - rect.left)))
          }}
          onMouseLeave={() => setHoverX(null)}
        >
          {containerWidth > 0 && displayBlocks.map(block => (
            <TimelineBlock
              key={block.id}
              block={block}
              viewStart={viewStart}
              visibleDuration={visibleDuration > 0 ? visibleDuration : totalDuration}
              containerWidth={containerWidth}
              currentTime={currentTime}
              isActive={block.id === activeBlockId}
              onClick={(e?: React.MouseEvent) => {
                e?.stopPropagation()
                onBlockSelect(block)
              }}
            />
          ))}

          {/* Ctrl+ホバー中の境界ハイライト */}
          {hoveredBoundaryX !== null && (
            <div style={{
              position: 'absolute', left: hoveredBoundaryX, top: 0, bottom: 0,
              width: 3, background: theme.handleLineDragging,
              transform: 'translateX(-50%)', pointerEvents: 'none', zIndex: 8, opacity: 0.6,
            }} />
          )}

          {/* ドラッグ中の境界ライン */}
          {draggingBoundaryX !== null && (
            <div style={{
              position: 'absolute', left: draggingBoundaryX, top: 0, bottom: 0,
              width: 2, background: theme.handleLineDragging,
              transform: 'translateX(-50%)', pointerEvents: 'none', zIndex: 9,
            }} />
          )}

          {/* 再生ヘッド */}
          {totalDuration > 0 && (
            <div style={{
              position: 'absolute', top: 0, bottom: 0, left: playheadLeft,
              width: 2, background: theme.accent,
              transform: 'translateX(-50%)', pointerEvents: 'none', zIndex: 10,
            }}>
              <div style={{
                position: 'absolute', top: 0, left: '50%',
                transform: 'translateX(-50%)',
                width: 8, height: 8, borderRadius: '50%', background: theme.accent,
              }} />
            </div>
          )}
        </div>
      </div>

      {/* 操作ヒント + ズームインジケーター */}
      <div style={{
        display: 'flex', gap: 10, marginTop: 3,
        fontSize: 9, color: theme.videoTimeColor, opacity: 0.7,
      }}>
        <span>クリック/ドラッグ: シーク</span>
        <span>Ctrl+境界ドラッグ: 時間調整</span>
        <span>ホイール: ズーム</span>
        <span style={{ marginLeft: 'auto' }}>
          {zoomLevel > 1.05 && (
            <span
              style={{ cursor: 'pointer', marginRight: 8, textDecoration: 'underline dotted' }}
              onClick={resetZoom}
              title="クリックでズームリセット"
            >
              {zoomLevel.toFixed(1)}× リセット
            </span>
          )}
          I = 開始点 / O = 終了点
        </span>
      </div>
    </div>
  )
}
