import { useEffect, useState } from 'react'

const REPO = 'matsuolab/lecture_subtitle_translator'
const CACHE_DATE_KEY = 'update_check_last_date'
const DISMISSED_KEY = 'update_dismissed_version'

export interface UpdateCheckResult {
  available: boolean
  latestVersion: string
  releaseUrl: string
  downloadUrl: string | null
  assetName: string | null
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

export function useUpdateCheck(): UpdateCheckResult | null {
  const [result, setResult] = useState<UpdateCheckResult | null>(null)

  useEffect(() => {
    const currentVersion = import.meta.env.VITE_APP_VERSION as string | undefined
    // 開発ビルド（バージョン未設定）はチェックしない
    if (!currentVersion || currentVersion === '0.0.0') return

    const dismissedVersion = localStorage.getItem(DISMISSED_KEY)
    const lastCheckDate = localStorage.getItem(CACHE_DATE_KEY)

    // 同日は再チェックしない
    if (lastCheckDate === todayString()) return

    const controller = new AbortController()

    fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: controller.signal,
    })
      .then(res => {
        if (!res.ok) return null
        return res.json() as Promise<GitHubRelease>
      })
      .then(data => {
        if (!data) return
        localStorage.setItem(CACHE_DATE_KEY, todayString())
        const latestVersion = data.tag_name
        if (!isNewer(latestVersion, currentVersion)) return
        if (dismissedVersion === latestVersion) return

        const targetName = detectAssetName()
        const asset = targetName
          ? data.assets.find(a => a.name === targetName) ?? null
          : null

        setResult({
          available: true,
          latestVersion,
          releaseUrl: data.html_url,
          downloadUrl: asset?.browser_download_url ?? null,
          assetName: asset?.name ?? null,
        })
      })
      .catch(() => {
        // ネットワークエラー・レートリミットは無視
      })

    return () => controller.abort()
  }, [])

  return result
}
