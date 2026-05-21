import { useRef, useCallback, useState, useEffect } from 'react'
import { Play, Pause, Volume2, Film } from 'lucide-react'
import { formatTime, type SubtitleBlock } from '@/types/subtitle'
import { useTheme } from '@/context/ThemeContext'

interface SubtitleOverlay {
  text: string
  progress: number // 0-100
}

interface VideoLoadDiagnostic {
  sourceKind: 'file' | 'path'
  name: string
  originalPath?: string
  generatedUrl: string
  convertedUrl?: string
  assetSegments?: string[]
  userAgent: string
  hasEncodedSlash: boolean
  hasNonAsciiPath: boolean
  hasWhitespacePath: boolean
  hasUrlSpecialPath: boolean
  assetReachable: 'ok' | 'denied' | 'error' | 'skipped'
  assetHeadStatus: number | null
  assetHeadError: string | null
  fallbackUrl?: string
  fallbackRegistered: boolean
  fallbackHeadStatus: number | null
  fallbackHeadContentType: string | null
  fallbackHeadContentLength: string | null
  fallbackHeadAcceptRanges: string | null
  fallbackRangeStatus: number | null
  fallbackRangeContentRange: string | null
  fallbackRangeContentLength: string | null
  fallbackHeadError: string | null
  fallbackAttempted: boolean
  file?: {
    exists: boolean
    isFile: boolean
    sizeBytes: number | null
    openOk: boolean
    openError: string | null
  } | null
}

interface VideoPlayerProps {
  videoRef: React.RefObject<HTMLVideoElement | null>
  videoUrl: string | null
  currentTime: number
  isPlaying: boolean
  totalDuration: number
  onTogglePlay: () => void
  onSeek: (seconds: number) => void
  onLoadVideo: (file: File) => void
  subtitleOverlay: SubtitleOverlay | null
  blocks?: SubtitleBlock[]
  onTimeUpdate: () => void
  onPlay: () => void
  onPause: () => void
  onLoadedMetadata: () => void
  onError: () => void
  videoDiagnostic?: VideoLoadDiagnostic | null
  preferNativeVideoDrop?: boolean
}

function classifyVideoError(detail: string, src: string, diagnostic?: VideoLoadDiagnostic | null): string {
  if (diagnostic?.hasEncodedSlash || /asset:\/\/localhost\/%2F/i.test(src)) {
    return 'asset URL生成エラー候補: パス区切りが%2Fに変換されています'
  }
  if (diagnostic?.file && (!diagnostic.file.exists || !diagnostic.file.isFile || !diagnostic.file.openOk)) {
    return `ファイルアクセス候補: ${diagnostic.file.openError ?? 'ファイルを開けません'}`
  }
  if (diagnostic?.assetReachable === 'denied') {
    return `asset scope候補: Tauri asset protocolが ${diagnostic.assetHeadStatus ?? 'unknown'} を返しURL未解決`
  }
  if (diagnostic?.assetReachable === 'error') {
    return `asset fetch候補: HEADリクエスト失敗 (${diagnostic.assetHeadError ?? 'unknown'})`
  }
  if (src.startsWith('http://127.0.0.1:') && detail.includes('MEDIA_ERR_SRC_NOT_SUPPORTED')) {
    return 'localhost fallback候補: HTTP Range経路でも動画ソースとして受け付けられていません'
  }
  if (diagnostic?.assetReachable === 'ok' && src.startsWith('asset://') && detail.includes('MEDIA_ERR_SRC_NOT_SUPPORTED')) {
    return 'WKWebView候補: asset HEADは成功したが<video>要素がメディアとして受け付けていません'
  }
  if (src.startsWith('asset://') && detail.includes('MEDIA_ERR_SRC_NOT_SUPPORTED')) {
    return 'asset protocol候補: Mac WebViewがこのasset URLを動画ソースとして読めていません'
  }
  if (detail.includes('MEDIA_ERR_DECODE')) {
    return 'メディア形式候補: コンテナまたはコーデックのデコードに失敗しています'
  }
  return 'メディア読み込み候補: URL・ファイルアクセス・形式の診断ログを確認してください'
}

export function VideoPlayer({
  videoRef,
  videoUrl,
  currentTime,
  isPlaying,
  totalDuration,
  onTogglePlay,
  onSeek,
  onLoadVideo,
  subtitleOverlay,
  blocks,
  onTimeUpdate,
  onPlay,
  onPause,
  onLoadedMetadata,
  onError,
  videoDiagnostic,
  preferNativeVideoDrop = false,
}: VideoPlayerProps) {
  const { theme } = useTheme()
  const seekBarRef = useRef<HTMLDivElement>(null)
  const [hoverPct, setHoverPct] = useState<number | null>(null)
  const [isDragOver, setIsDragOver] = useState(false)
  const [dropError, setDropError] = useState<string | null>(null)

  // エラーメッセージを3秒後に消す
  useEffect(() => {
    if (!dropError) return
    const t = setTimeout(() => setDropError(null), 3000)
    return () => clearTimeout(t)
  }, [dropError])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    if (e.dataTransfer.types.includes('Files')) setIsDragOver(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node)) return
    setIsDragOver(false)
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(false)
    if (preferNativeVideoDrop) return
    const file = e.dataTransfer.files[0]
    if (file) onLoadVideo(file)
  }, [onLoadVideo, preferNativeVideoDrop])
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
      <div
        className="relative flex-1 min-h-0"
        style={{ background: '#000', overflow: 'hidden' }}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {videoUrl ? (
          <video
            ref={videoRef}
            src={videoUrl ?? undefined}
            className="w-full h-full"
            style={{ objectFit: 'contain', cursor: 'pointer' }}
            preload="metadata"
            onClick={onTogglePlay}
            onTimeUpdate={onTimeUpdate}
            onPlay={onPlay}
            onPause={onPause}
            onLoadedMetadata={onLoadedMetadata}
            onError={(e) => {
              const target = e.currentTarget as HTMLVideoElement
              const err = target.error
              const codeMap: Record<number, string> = {
                1: 'MEDIA_ERR_ABORTED',
                2: 'MEDIA_ERR_NETWORK',
                3: 'MEDIA_ERR_DECODE',
                4: 'MEDIA_ERR_SRC_NOT_SUPPORTED',
              }
              const detail = err ? `${codeMap[err.code] ?? `code=${err.code}`}: ${err.message}` : 'unknown'
              const src = target.src
              const mediaState = {
                currentSrc: target.currentSrc,
                networkState: target.networkState,
                readyState: target.readyState,
                duration: Number.isFinite(target.duration) ? target.duration : null,
                src,
              }
              const cause = classifyVideoError(detail, src, videoDiagnostic)
              console.error('[video] onError:', detail, cause, mediaState, videoDiagnostic)
              onError()
              setDropError(`動画再生失敗: ${cause} / ${detail} (src=${src.slice(0, 80)}...)`)
            }}
          />
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center gap-3"
            style={{ color: '#4a5568' }}>
            <Film size={40} strokeWidth={1.2} />
            <span style={{ fontSize: 13 }}>動画ファイルを読み込んでください</span>
          </div>
        )}

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
            maxWidth: '95%',
            pointerEvents: 'none',
            whiteSpace: 'pre',
            overflow: 'visible',
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

        {/* ドロップエラー通知 */}
        {dropError && (
          <div style={{
            position: 'absolute', top: 16, left: '50%', transform: 'translateX(-50%)',
            background: 'rgba(239,68,68,0.92)', color: '#fff',
            fontSize: 12, fontWeight: 600, padding: '8px 16px', borderRadius: 8,
            whiteSpace: 'pre-wrap', textAlign: 'center', pointerEvents: 'none',
            zIndex: 20, maxWidth: '90%',
          }}>
            {dropError}
          </div>
        )}

        {/* ドラッグ中オーバーレイ */}
        {isDragOver && (
          <div style={{
            position: 'absolute', inset: 0,
            background: 'rgba(74,144,255,0.18)',
            border: '2px dashed rgba(74,144,255,0.8)',
            borderRadius: 6,
            display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center',
            gap: 8, pointerEvents: 'none',
          }}>
            <Film size={36} color="rgba(74,144,255,0.9)" strokeWidth={1.2} />
            <span style={{ color: 'rgba(74,144,255,0.9)', fontSize: 13, fontWeight: 600 }}>
              ドロップして動画を読み込む
            </span>
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
