import { useState, useRef, useCallback, useEffect } from 'react'
import { isTauri } from '@tauri-apps/api/core'
import type { SubtitleBlock } from '@/types/subtitle'
import { logDiagnosticEvent } from '@/lib/diagnostics/logger'
import { collectEnvironmentSnapshot } from '@/lib/diagnostics/environment'

/** timeupdate が途絶したとみなすまでの猶予（再生中のみ判定） */
const TIMEUPDATE_STALL_THRESHOLD_MS = 2000
/** 再生中の途絶チェック間隔 */
const TIMEUPDATE_STALL_CHECK_INTERVAL_MS = 1000

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
  onError: () => void
}

/** video要素の実プロパティ + Reactステートのズレ調査用スナップショット */
function snapshotVideoState(video: HTMLVideoElement | null, isPlayingState: boolean) {
  if (!video) return { hasVideoElement: false, isPlayingState }
  return {
    hasVideoElement: true,
    isPlayingState,
    paused: video.paused,
    currentTime: video.currentTime,
    readyState: video.readyState,
    networkState: video.networkState,
    videoWidth: video.videoWidth,
    videoHeight: video.videoHeight,
    clientWidth: video.clientWidth,
    clientHeight: video.clientHeight,
  }
}

export function useVideoSync(blocks: SubtitleBlock[], videoUrl: string | null): UseVideoSyncReturn {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [activeBlockId, setActiveBlockId] = useState<number | null>(null)
  const isPlayingRef = useRef(isPlaying)
  useEffect(() => {
    isPlayingRef.current = isPlaying
  }, [isPlaying])
  const lastTimeUpdateAtRef = useRef<number>(0)

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

  // isPlaying(Reactステート)はvideoのplay/pauseイベント経由でしか更新されず、
  // WebViewの実装差異等でイベントが取りこぼされるとDOMの実際の再生状態とズレる。
  // ズレたまま isPlaying を判定に使うと、押しても意図と逆の操作（例: 再生中に
  // さらにplay()を呼ぶだけで実質何も起きない）になり「効かない」ように見える。
  // video.paused（DOMの実プロパティ）を基準にすることでズレの影響を受けない。
  const togglePlay = useCallback(() => {
    if (!videoRef.current) return
    // isPlayingとvideo.pausedが実際にズレていたかを操作のたびに記録する。
    // togglePlay自体はvideo.paused基準に修正済みで症状は改善するはずだが、
    // 「ズレが本当に発生していたか」を裏付けるログが無いと、この対症療法が
    // 的を射ていたかの検証も、再発時の切り分けもできない。
    // isPlaying=trueならvideo.pausedはfalseのはず（逆も同様）。一致しない
    // 場合のみ記録し、一致時はノイズになるため記録しない。
    const expectedPaused = !isPlayingRef.current
    if (videoRef.current.paused !== expectedPaused) {
      logDiagnosticEvent('video_state_snapshot', 'togglePlay: isPlaying/paused mismatch', {
        ...snapshotVideoState(videoRef.current, isPlayingRef.current),
      })
    }
    if (videoRef.current.paused) {
      videoRef.current.play()
    } else {
      videoRef.current.pause()
    }
  }, [])

  // VideoPlayer の <video> 要素に直接渡す React イベントハンドラー
  const onTimeUpdate = useCallback(() => {
    lastTimeUpdateAtRef.current = Date.now()
    if (videoRef.current) setCurrentTime(videoRef.current.currentTime)
  }, [])

  const onPlay = useCallback(() => {
    // 再生開始時点を基準にしないと、pause中に経過した時間がそのまま
    // 「timeupdate途絶」として誤検知されてしまう。
    lastTimeUpdateAtRef.current = Date.now()
    setIsPlaying(true)
  }, [])
  const onPause = useCallback(() => setIsPlaying(false), [])

  const onLoadedMetadata = useCallback(() => {
    if (videoRef.current) setDuration(videoRef.current.duration)
  }, [])

  const onError = useCallback(() => {
    setDuration(0)
    setCurrentTime(0)
    setIsPlaying(false)
  }, [])

  useEffect(() => {
    const active = blocks.find(b => currentTime >= b.startTime && currentTime < b.endTime)
    setActiveBlockId(active?.id ?? null)
  }, [currentTime, blocks])

  // 「全画面から戻すと字幕が消える」調査用: リサイズ発生時にvideoの実状態を
  // 記録する。リサイズ自体がonTimeUpdateの途絶やisPlayingとpausedのズレを
  // 引き起こしているかを、リサイズ直前直後のスナップショット差分から追える
  // ようにする。deviceの性能限界かアプリ側ロジックかの切り分けが目的なので、
  // detailに実行環境スナップショットも付与する。
  //
  // DOM の window 'resize' イベントに加え、Tauriネイティブの
  // getCurrentWindow().onResized（Rust側 WindowEvent::Resized 由来）も併せて
  // 監視する。WebView2/WKWebView/WebKitGTKがOSのウィンドウ最大化解除を
  // DOM resizeとして伝播するタイミング・確実性はランタイム実装依存であり
  // 保証されていないため、片方しか発火しない場合にそれ自体が重要な手がかりに
  // なりうる。ただし onResized はウィンドウ移動等サイズ変化を伴わない場合にも
  // 発火することがあるため、「発火の有無」だけでは実際にリサイズされたかを
  // 断定できない。windowSize（onResizedのPhysicalSizeペイロード）を
  // start/settledそれぞれに記録し、実サイズが変化したかを直接確認できる
  // ようにしている。
  useEffect(() => {
    if (!videoUrl) return
    // dom/tauri_native はほぼ同時に発火しうるため、settledのデバウンスタイマーを
    // sourceごとに独立させる。共有タイマーだと後発イベントが先発イベントの
    // settled記録を握りつぶし、実際は両方発火していても片方しか記録されない
    // （＝「片方しか発火しない」という誤った手がかりを残す）ことになる。
    const debounceTimers: Record<'dom' | 'tauri_native', ReturnType<typeof setTimeout> | null> = {
      dom: null,
      tauri_native: null,
    }
    // 実際にサイズが変わったのか（ウィンドウ移動等サイズ変化を伴わない発火では
    // ないか）を確認できるよう、イベントが運んできたウィンドウ実サイズも記録する。
    // これが無いと、onResizedが発火した事実だけでは「本当にリサイズされたのか」
    // 「サイズは変わらずイベントだけ発火したのか」を区別できない。
    const handleResize = (source: 'dom' | 'tauri_native', windowSize?: { width: number; height: number }) => {
      logDiagnosticEvent('video_state_snapshot', `resize start (${source})`, {
        source,
        windowSize,
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        ...snapshotVideoState(videoRef.current, isPlayingRef.current),
        env: collectEnvironmentSnapshot(),
      })
      if (debounceTimers[source]) clearTimeout(debounceTimers[source])
      debounceTimers[source] = setTimeout(() => {
        logDiagnosticEvent('video_state_snapshot', `resize settled (${source})`, {
          source,
          windowSize,
          innerWidth: window.innerWidth,
          innerHeight: window.innerHeight,
          ...snapshotVideoState(videoRef.current, isPlayingRef.current),
          env: collectEnvironmentSnapshot(),
        })
      }, 500)
    }
    const handleDomResize = () => handleResize('dom')
    window.addEventListener('resize', handleDomResize)

    // onResizedの購読はPromiseベースで非同期に確立するため、確立前に
    // effectがクリーンアップされる（videoUrlの連続変更等）競合がありうる。
    // その場合、確立後に登録してもすぐ解除できるよう cancelled で判定する。
    let unlistenNative: (() => void) | null = null
    let cancelled = false
    if (isTauri()) {
      import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
        return getCurrentWindow().onResized((event) => {
          handleResize('tauri_native', { width: event.payload.width, height: event.payload.height })
        })
      }).then((unlisten) => {
        if (cancelled) {
          unlisten()
        } else {
          unlistenNative = unlisten
        }
      }).catch(() => {
        // Tauriネイティブのイベント購読に失敗してもDOM resize側の監視は継続する
      })
    }

    return () => {
      cancelled = true
      window.removeEventListener('resize', handleDomResize)
      if (debounceTimers.dom) clearTimeout(debounceTimers.dom)
      if (debounceTimers.tauri_native) clearTimeout(debounceTimers.tauri_native)
      unlistenNative?.()
    }
  }, [videoUrl])

  // video.paused===false（DOM上は再生中）のはずなのにtimeupdateが一定時間
  // 発火しない状態を検知する。判定基準を isPlaying（Reactステート）ではなく
  // video.paused（DOM実値）にしているのは、
  // 1. isPlaying自体がズレている可能性があるため、判定基準として信頼できない
  // 2. isPlaying基準だと一時停止中は監視自体が止まり、「一時停止中にリサイズ
  //    した結果、復帰後も再生状態に戻らず字幕が出ない」ようなケースを拾えない
  // ため。発火が止まるとcurrentTimeが更新されず字幕オーバーレイの元になる
  // currentBlockが見つからなくなる（=字幕が消える）ため、その裏付けとして使う。
  useEffect(() => {
    // 途絶中は1秒間隔で記録し続けずログを埋めないよう、途絶検知済みかを覚えておき
    // 復帰（timeupdate再開、またはpause）まで再記録しない。
    let stallLogged = false
    const timer = setInterval(() => {
      const video = videoRef.current
      if (!video || video.paused) {
        stallLogged = false
        return
      }
      const elapsed = Date.now() - lastTimeUpdateAtRef.current
      if (elapsed >= TIMEUPDATE_STALL_THRESHOLD_MS) {
        if (!stallLogged) {
          stallLogged = true
          logDiagnosticEvent('timeupdate_stalled', `${elapsed}ms elapsed since last timeupdate`, {
            ...snapshotVideoState(video, isPlayingRef.current),
            env: collectEnvironmentSnapshot(),
          })
        }
      } else {
        stallLogged = false
      }
    }, TIMEUPDATE_STALL_CHECK_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [])

  return { videoRef, currentTime, duration, isPlaying, activeBlockId, seekTo, togglePlay, onTimeUpdate, onPlay, onPause, onLoadedMetadata, onError }
}
