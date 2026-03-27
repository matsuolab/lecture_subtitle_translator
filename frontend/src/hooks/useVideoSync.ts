import { useState, useRef, useCallback, useEffect } from 'react'
import type { SubtitleBlock } from '@/types/subtitle'

interface UseVideoSyncReturn {
  videoRef: React.RefObject<HTMLVideoElement | null>
  currentTime: number
  isPlaying: boolean
  activeBlockId: number | null
  seekTo: (seconds: number) => void
  togglePlay: () => void
}

export function useVideoSync(blocks: SubtitleBlock[]): UseVideoSyncReturn {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [currentTime, setCurrentTime] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [activeBlockId, setActiveBlockId] = useState<number | null>(null)

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

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const onTimeUpdate = () => setCurrentTime(video.currentTime)
    const onPlay = () => setIsPlaying(true)
    const onPause = () => setIsPlaying(false)
    video.addEventListener('timeupdate', onTimeUpdate)
    video.addEventListener('play', onPlay)
    video.addEventListener('pause', onPause)
    return () => {
      video.removeEventListener('timeupdate', onTimeUpdate)
      video.removeEventListener('play', onPlay)
      video.removeEventListener('pause', onPause)
    }
  }, [])

  useEffect(() => {
    const active = blocks.find(b => currentTime >= b.startTime && currentTime < b.endTime)
    setActiveBlockId(active?.id ?? null)
  }, [currentTime, blocks])

  return { videoRef, currentTime, isPlaying, activeBlockId, seekTo, togglePlay }
}
