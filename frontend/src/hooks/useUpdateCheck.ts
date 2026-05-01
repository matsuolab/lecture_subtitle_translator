import { useCallback, useEffect, useState } from 'react'

const REPO = 'matsuolab/lecture_subtitle_translator'
const CACHE_DATE_KEY = 'update_check_last_date'
const DISMISSED_KEY = 'update_dismissed_version'
const UPDATE_CHECK_ENABLED = false

export interface UpdateCheckResult {
  available: boolean
  latestVersion: string
  releaseUrl: string
  downloadUrl: string | null
  assetName: string | null
}

export interface ManualCheckState {
  status: 'idle' | 'checking' | 'up_to_date' | 'available' | 'error' | 'disabled'
  latestVersion: string | null
  releaseUrl: string | null
  downloadUrl: string | null
  errorMessage: string | null
  checkedAt: string | null
}

export interface UseUpdateCheckReturn {
  updateInfo: UpdateCheckResult | null
  manualCheck: ManualCheckState
  lastAutoCheckDate: string | null
  triggerManualCheck: () => void
}

interface GitHubAsset {
  name: string
  browser_download_url: string
}

interface GitHubRelease {
  tag_name: string
  html_url: string
  assets: GitHubAsset[]
}

function parseVersion(v: string): [number, number, number] {
  const parts = v.replace(/^v/, '').split('.').map(Number)
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0]
}

function isNewer(latest: string, current: string): boolean {
  const [lMaj, lMin, lPat] = parseVersion(latest)
  const [cMaj, cMin, cPat] = parseVersion(current)
  if (lMaj !== cMaj) return lMaj > cMaj
  if (lMin !== cMin) return lMin > cMin
  return lPat > cPat
}

function todayString(): string {
  return new Date().toISOString().slice(0, 10)
}

function detectAssetName(): string | null {
  const ua = navigator.userAgent.toLowerCase()
  if (ua.includes('win')) return 'subtitle-editor-windows-x64.exe'
  if (ua.includes('mac')) return 'subtitle-editor-macos-arm64'
  if (ua.includes('linux')) return 'subtitle-editor-linux-x64'
  return null
}

interface FetchReleaseError {
  httpStatus: number
}

class FetchReleaseHttpError extends Error {
  readonly httpStatus: number
  constructor({ httpStatus }: FetchReleaseError) {
    const label = httpStatus === 404
      ? '404（リリース未作成またはリポジトリ非公開）'
      : httpStatus === 403
        ? '403（APIレート制限）'
        : `HTTP ${httpStatus}`
    super(label)
    this.httpStatus = httpStatus
  }
}

async function fetchLatestRelease(): Promise<GitHubRelease> {
  const token = import.meta.env.VITE_GITHUB_TOKEN as string | undefined
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json' }
  if (token) headers['Authorization'] = `Bearer ${token}`
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers })
  if (!res.ok) throw new FetchReleaseHttpError({ httpStatus: res.status })
  return res.json() as Promise<GitHubRelease>
}

export function useUpdateCheck(): UseUpdateCheckReturn {
  const [updateInfo, setUpdateInfo] = useState<UpdateCheckResult | null>(null)
  const [manualCheck, setManualCheck] = useState<ManualCheckState>({
    status: UPDATE_CHECK_ENABLED ? 'idle' : 'disabled',
    latestVersion: null,
    releaseUrl: null,
    downloadUrl: null,
    errorMessage: UPDATE_CHECK_ENABLED ? null : '自動更新チェックは一時停止中です',
    checkedAt: null,
  })
  const [lastAutoCheckDate, setLastAutoCheckDate] = useState<string | null>(
    () => localStorage.getItem(CACHE_DATE_KEY)
  )

  useEffect(() => {
    if (!UPDATE_CHECK_ENABLED) return
    const currentVersion = import.meta.env.VITE_APP_VERSION as string | undefined
    if (!currentVersion || currentVersion === '0.0.0') return

    const dismissedVersion = localStorage.getItem(DISMISSED_KEY)
    const lastCheckDate = localStorage.getItem(CACHE_DATE_KEY)
    if (lastCheckDate === todayString()) return

    const controller = new AbortController()

    fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: controller.signal,
    })
      .then(res => {
        if (!res.ok) throw new FetchReleaseHttpError({ httpStatus: res.status })
        return res.json() as Promise<GitHubRelease>
      })
      .then(data => {
        const today = todayString()
        localStorage.setItem(CACHE_DATE_KEY, today)
        setLastAutoCheckDate(today)
        const latestVersion = data.tag_name
        if (!isNewer(latestVersion, currentVersion)) return
        if (dismissedVersion === latestVersion) return

        const targetName = detectAssetName()
        const asset = targetName
          ? data.assets.find(a => a.name === targetName) ?? null
          : null

        setUpdateInfo({
          available: true,
          latestVersion,
          releaseUrl: data.html_url,
          downloadUrl: asset?.browser_download_url ?? null,
          assetName: asset?.name ?? null,
        })
      })
      .catch(() => {})

    return () => controller.abort()
  }, [])

  const triggerManualCheck = useCallback(() => {
    if (!UPDATE_CHECK_ENABLED) {
      setManualCheck({
        status: 'disabled',
        latestVersion: null,
        releaseUrl: null,
        downloadUrl: null,
        errorMessage: '自動更新チェックは一時停止中です',
        checkedAt: null,
      })
      return
    }

    const currentVersion = import.meta.env.VITE_APP_VERSION as string | undefined
    setManualCheck({
      status: 'checking',
      latestVersion: null,
      releaseUrl: null,
      downloadUrl: null,
      errorMessage: null,
      checkedAt: null,
    })

    fetchLatestRelease()
      .then(data => {
        const checkedAt = new Date().toLocaleString('ja-JP', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
        const latestVersion = data.tag_name
        const targetName = detectAssetName()
        const asset = targetName
          ? data.assets.find(a => a.name === targetName) ?? null
          : null
        const downloadUrl = asset?.browser_download_url ?? null

        if (!currentVersion || currentVersion === '0.0.0' || !isNewer(latestVersion, currentVersion)) {
          setManualCheck({
            status: 'up_to_date',
            latestVersion,
            releaseUrl: data.html_url,
            downloadUrl,
            errorMessage: null,
            checkedAt,
          })
        } else {
          setManualCheck({
            status: 'available',
            latestVersion,
            releaseUrl: data.html_url,
            downloadUrl,
            errorMessage: null,
            checkedAt,
          })
          setUpdateInfo({
            available: true,
            latestVersion,
            releaseUrl: data.html_url,
            downloadUrl,
            assetName: asset?.name ?? null,
          })
        }
      })
      .catch((err: unknown) => {
        const checkedAt = new Date().toLocaleString('ja-JP', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
        const errorMessage = err instanceof Error ? err.message : 'ネットワークエラー'
        setManualCheck({
          status: 'error',
          latestVersion: null,
          releaseUrl: null,
          downloadUrl: null,
          errorMessage,
          checkedAt,
        })
      })
  }, [])

  return { updateInfo, manualCheck, lastAutoCheckDate, triggerManualCheck }
}
