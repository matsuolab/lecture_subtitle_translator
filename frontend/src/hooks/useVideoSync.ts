import { useState, useRef, useCallback, useEffect } from 'react'
import type { SubtitleBlock } from '@/types/subtitle'

interface UseVideoSyncReturn {
  videoRef: React.RefObject<HTMLVideoElement | null>
  currentTime: number
  duration: number
  isPlaying: boolean
  activeBlockId: number | null
  seekTo: (seconds: number) => void
  togglePlay: () => void
  onTimeUpdate: () => void
  onPlay: () => void
  onPause: () => void
  onLoadedMetadata: () => void
}

export function useVideoSync(blocks: SubtitleBlock[], videoUrl: string | null): UseVideoSyncReturn {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [activeBlockId, setActiveBlockId] = useState<number | null>(null)

  // 動画URL変更時にステートをリセット
  useEffect(() => {
    setCurrentTime(0)
    setDuration(0)
    setIsPlaying(false)
  }, [videoUrl])

  const seekTo = useCallback((seconds: number) => {
    if (videoRef.current) {
      videoRef.current.currentTime = seconds
    }
    setCurrentTime(seconds)
  }, [])

  const togglePlay = useCallback(() => {
    if (!videoRef.current) return
    if (isPlaying) {
      videoRef.current.pause()
    } else {
      videoRef.current.play()
    }
  }, [isPlaying])

  // VideoPlayer の <video> 要素に直接渡す React イベントハンドラー
  const onTimeUpdate = useCallback(() => {
    if (videoRef.current) setCurrentTime(videoRef.current.currentTime)
  }, [])

  const onPlay = useCallback(() => setIsPlaying(true), [])
  const onPause = useCallback(() => setIsPlaying(false), [])

  const onLoadedMetadata = useCallback(() => {
    if (videoRef.current) setDuration(videoRef.current.duration)
  }, [])

  useEffect(() => {
    const active = blocks.find(b => currentTime >= b.startTime && currentTime < b.endTime)
    setActiveBlockId(active?.id ?? null)
  }, [currentTime, blocks])

  return { videoRef, currentTime, duration, isPlaying, activeBlockId, seekTo, togglePlay, onTimeUpdate, onPlay, onPause, onLoadedMetadata }
}
