import type { SubtitleBlock } from '@/types/subtitle'

const STORAGE_KEY = 'matsuo-subtitle-editor-v1'

// ─── localStorage（クラッシュ/誤リロード対策） ────────────────────────────

export function saveToLocalStorage(blocks: SubtitleBlock[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      savedAt: new Date().toISOString(),
      blocks,
    }))
  } catch {
    // QuotaExceededError 等は無視
  }
}

export function loadFromLocalStorage(): SubtitleBlock[] | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed.blocks)) return null
    // english→source / japanese→target フィールド名変更のマイグレーション
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return parsed.blocks.map((b: any) => ({
      ...b,
      source: b.source ?? b.english ?? '',
      target: b.target ?? b.japanese ?? '',
    })) as SubtitleBlock[]
  } catch {
    return null
  }
}

export function clearLocalStorage(): void {
  localStorage.removeItem(STORAGE_KEY)
}

// ─── JSON プロジェクトファイル ─────────────────────────────────────────────

export function exportProjectJson(blocks: SubtitleBlock[]): void {
  const data = JSON.stringify({ version: 1, savedAt: new Date().toISOString(), blocks }, null, 2)
  downloadFile(data, 'subtitle-project.json', 'application/json')
}

export function importProjectJson(file: File): Promise<SubtitleBlock[]> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = e => {
      try {
        const parsed = JSON.parse(e.target?.result as string)
        if (!Array.isArray(parsed.blocks)) throw new Error('blocks が見つかりません')
        resolve(parsed.blocks as SubtitleBlock[])
      } catch (err) {
        reject(err)
      }
    }
    reader.onerror = () => reject(new Error('ファイル読み込みに失敗しました'))
    reader.readAsText(file)
  })
}

// ─── SRT エクスポート ──────────────────────────────────────────────────────

export function exportSrt(blocks: SubtitleBlock[]): void {
  const lines = blocks.map((block, i) => {
    const start = secondsToSrtTime(block.startTime)
    const end   = secondsToSrtTime(block.endTime)
    return `${i + 1}\n${start} --> ${end}\n${block.source}`
  })
  downloadFile(lines.join('\n\n') + '\n', 'subtitles.srt', 'text/plain')
}

// ─── 内部ユーティリティ ────────────────────────────────────────────────────

function secondsToSrtTime(seconds: number): string {
  const h  = Math.floor(seconds / 3600)
  const m  = Math.floor((seconds % 3600) / 60)
  const s  = Math.floor(seconds % 60)
  const ms = Math.round((seconds % 1) * 1000)
  return `${p2(h)}:${p2(m)}:${p2(s)},${p3(ms)}`
}

function p2(n: number) { return String(n).padStart(2, '0') }
function p3(n: number) { return String(n).padStart(3, '0') }

function downloadFile(content: string, filename: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  a.href     = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
