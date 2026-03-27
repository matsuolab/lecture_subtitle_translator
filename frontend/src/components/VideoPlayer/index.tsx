import { useRef, useCallback, useState } from 'react'
import { Play, Pause, Volume2 } from 'lucide-react'
import { formatTime, type SubtitleBlock } from '@/types/subtitle'
import { useTheme } from '@/context/ThemeContext'

// Big Buck Bunny (CC BY 3.0) — Blender Foundation
// 自然の森を舞台にした約9分のアニメ短編。権利クリア。
const SAMPLE_VIDEO_URL = 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4'

interface SubtitleOverlay {
  text: string
  progress: number // 0-100
}

interface VideoPlayerProps {
  videoRef: React.RefObject<HTMLVideoElement | null>
  currentTime: number
  isPlaying: boolean
  totalDuration: number
  onTogglePlay: () => void
  onSeek: (seconds: number) => void
  subtitleOverlay: SubtitleOverlay | null
  blocks?: SubtitleBlock[]
}

export function VideoPlayer({
  videoRef,
  currentTime,
  isPlaying,
  totalDuration,
  onTogglePlay,
  onSeek,
  subtitleOverlay,
  blocks,
}: VideoPlayerProps) {
  const { theme } = useTheme()
  const seekBarRef = useRef<HTMLDivElement>(null)
  const [hoverPct, setHoverPct] = useState<number | null>(null)
  const progress = totalDuration > 0 ? (currentTime / totalDuration) * 100 : 0

  const handleSeekMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    const el = seekBarRef.current
    if (!el) return

    const getSeekTime = (clientX: number) => {
      const rect = el.getBoundingClientRect()
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
      return ratio * totalDuration
    }

    onSeek(getSeekTime(e.clientX))

    const onMove = (mv: MouseEvent) => onSeek(getSeekTime(mv.clientX))
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [totalDuration, onSeek])

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* 動画エリア */}
      <div className="relative flex-1 min-h-0" style={{ background: '#000', overflow: 'hidden' }}>
        <video
          ref={videoRef}
          className="w-full h-full"
          style={{ objectFit: 'cover', cursor: 'pointer' }}
          preload="metadata"
          onClick={onTogglePlay}
        >
          <source src={SAMPLE_VIDEO_URL} type="video/mp4" />
        </video>

        {/* 字幕オーバーレイ */}
        {subtitleOverlay && (
          <div style={{
            position: 'absolute',
            bottom: 40,
            left: '50%',
            transform: 'translateX(-50%)',
            background: 'rgba(0,0,0,0.75)',
            color: '#fff',
            fontSize: 15,
            fontWeight: 600,
            lineHeight: 1.5,
            padding: '6px 14px 10px',
            borderRadius: 6,
            textAlign: 'center',
            maxWidth: '90%',
            pointerEvents: 'none',
            whiteSpace: 'pre-wrap',
            overflow: 'hidden',
          }}>
            <span>{subtitleOverlay.text}</span>
            <div style={{
              position: 'absolute',
              bottom: 0,
              left: 0,
              height: 3,
              width: `${subtitleOverlay.progress}%`,
              background: theme.videoSubtitleProgressColor,
              borderRadius: '0 0 6px 6px',
              transition: 'width 0.1s linear',
            }} />
          </div>
        )}
      </div>

      {/* コントロールバー */}
      <div className="px-3 pt-2 pb-3 space-y-2 shrink-0" style={{ background: theme.videoControlsBg }}>
        {/* シークバー（ツールチップ用ラッパー） */}
        <div style={{ position: 'relative' }}>
          {/* ホバー時刻ツールチップ */}
          {hoverPct !== null && totalDuration > 0 && (
            <div style={{
              position: 'absolute',
              bottom: 'calc(100% + 4px)',
              left: `${hoverPct * 100}%`,
              transform: 'translateX(-50%)',
              background: 'rgba(0,0,0,0.85)',
              color: '#fff', fontSize: 10,
              padding: '2px 6px', borderRadius: 3,
              whiteSpace: 'nowrap', pointerEvents: 'none', zIndex: 20,
            }}>
              {formatTime(hoverPct * totalDuration)}
            </div>
          )}
          <div
            ref={seekBarRef}
            className="h-2 rounded-full cursor-pointer group"
            style={{ background: theme.videoProgressTrack, position: 'relative' }}
            onMouseDown={handleSeekMouseDown}
            onMouseMove={e => {
              if (!seekBarRef.current) return
              const rect = seekBarRef.current.getBoundingClientRect()
              setHoverPct(Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)))
            }}
            onMouseLeave={() => setHoverPct(null)}
          >
            {/* ブロック位置マーカー */}
            {blocks && totalDuration > 0 && blocks.map(b => (
              <div key={b.id} style={{
                position: 'absolute', top: 0, bottom: 0,
                left: `${(b.startTime / totalDuration) * 100}%`,
                width: 1,
                background: b.status === 'approved'
                  ? 'rgba(34,197,94,0.5)'
                  : 'rgba(255,255,255,0.2)',
                pointerEvents: 'none',
              }} />
            ))}
            <div
              className="h-full rounded-full relative transition-all"
              style={{ width: `${progress}%`, background: theme.videoProgressFill }}
            >
              <div className="absolute right-0 top-1/2 -translate-y-1/2 w-2.5 h-2.5 rounded-full bg-white opacity-0 group-hover:opacity-100 transition-opacity shadow" />
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={onTogglePlay}
            className="w-7 h-7 rounded-full flex items-center justify-center"
            style={{ background: theme.videoBtnBg, border: `1px solid ${theme.videoBtnBorder}` }}
          >
            {isPlaying
              ? <Pause size={12} style={{ color: theme.videoIconColor }} />
              : <Play size={12} style={{ color: theme.videoIconColor, transform: 'translateX(1px)' }} />
            }
          </button>
          <Volume2 size={13} style={{ color: theme.videoTimeColor }} />
          <span className="font-mono ml-auto tabular-nums" style={{ fontSize: 11, color: theme.videoTimeColor }}>
            {formatTime(currentTime)} / {formatTime(totalDuration)}
          </span>
        </div>
      </div>
    </div>
  )
}
