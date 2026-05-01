import { X, Download } from 'lucide-react'
import type { UpdateCheckResult } from '@/hooks/useUpdateCheck'

const DISMISSED_KEY = 'update_dismissed_version'

interface Props {
  update: UpdateCheckResult
  onDismiss: () => void
}

function triggerDownload(url: string, filename: string) {
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
}

export function UpdateBanner({ update, onDismiss }: Props) {
  const handleDismiss = () => {
    localStorage.setItem(DISMISSED_KEY, update.latestVersion)
    onDismiss()
  }

  const handleDownload = () => {
    if (update.downloadUrl && update.assetName) {
      triggerDownload(update.downloadUrl, update.assetName)
    } else {
      window.open(update.releaseUrl, '_blank', 'noopener,noreferrer')
    }
  }

  const btnStyle: React.CSSProperties = {
    background: 'rgba(255,255,255,0.2)',
    border: '1px solid rgba(255,255,255,0.4)',
    borderRadius: 4,
    color: '#fff',
    padding: '2px 10px',
    fontSize: 12,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    display: 'flex',
    alignItems: 'center',
    gap: 4,
  }

  return (
    <div style={{
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      zIndex: 10000,
      background: '#1d4ed8',
      color: '#fff',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 12,
      padding: '6px 48px 6px 16px',
      fontSize: 13,
      lineHeight: 1.4,
    }}>
      <span>
        新しいバージョン <strong>{update.latestVersion}</strong> が利用可能です
      </span>
      <button onClick={handleDownload} style={btnStyle}>
        <Download size={12} />
        {update.downloadUrl ? 'ダウンロード' : 'ダウンロードページを開く'}
      </button>
      {update.downloadUrl && (
        <button
          onClick={() => window.open(update.releaseUrl, '_blank', 'noopener,noreferrer')}
          style={{ ...btnStyle, background: 'transparent', border: 'none', fontSize: 11, opacity: 0.75 }}
        >
          リリースページ
        </button>
      )}
      <button
        onClick={handleDismiss}
        aria-label="閉じる"
        style={{
          position: 'absolute',
          right: 12,
          top: '50%',
          transform: 'translateY(-50%)',
          background: 'none',
          border: 'none',
          color: 'rgba(255,255,255,0.8)',
          cursor: 'pointer',
          padding: 4,
          display: 'flex',
          alignItems: 'center',
        }}
      >
        <X size={14} />
      </button>
    </div>
  )
}
