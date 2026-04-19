import type { SubtitleBlock } from '@/types/subtitle'
import type { SessionLog } from '@/hooks/useActionLog'

const STORAGE_KEY = 'matsuo-subtitle-editor-v1'
const VIDEO_SOURCE_KEY = 'matsuo-video-source-v1'

// ─── Tauri 環境判定 ────────────────────────────────────────────────────────

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

// ─── ネイティブ保存（Tauri）/ blob フォールバック ─────────────────────────

/**
 * Tauri 環境ではネイティブ保存ダイアログを使ってファイルを保存し、
 * 保存先パスを返す。キャンセルされた場合は null を返す。
 * ブラウザ環境では blob ダウンロードに落ちる（パスは null）。
 */
async function saveFileNative(
  content: string,
  defaultFilename: string,
  filters: Array<{ name: string; extensions: string[] }>,
): Promise<string | null> {
  if (!isTauri()) {
    downloadFile(content, defaultFilename, 'text/plain')
    return null
  }

  try {
    const { save } = await import('@tauri-apps/plugin-dialog')
    const { writeTextFile } = await import('@tauri-apps/plugin-fs')

    const path = await save({
      defaultPath: defaultFilename,
      filters,
    })
    if (!path) return null

    await writeTextFile(path, content)
    return path
  } catch {
    // ダイアログが使えない場合は blob フォールバック
    downloadFile(content, defaultFilename, 'text/plain')
    return null
  }
}

// ─── videoSource の永続化 ───────────────────────────────────────────────────

export interface VideoSourceState {
  name: string
  path?: string
  fileId?: string
}

export function saveVideoSource(vs: VideoSourceState | null): void {
  try {
    if (vs === null) {
      localStorage.removeItem(VIDEO_SOURCE_KEY)
    } else {
      localStorage.setItem(VIDEO_SOURCE_KEY, JSON.stringify(vs))
    }
  } catch {
    // QuotaExceededError 等は無視
  }
}

export function loadVideoSource(): VideoSourceState | null {
  try {
    const raw = localStorage.getItem(VIDEO_SOURCE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (typeof parsed.name !== 'string') return null
    return parsed as VideoSourceState
  } catch {
    return null
  }
}

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

/**
 * プロジェクトを JSON で保存する。
 * Tauri ではネイティブダイアログ、ブラウザでは blob ダウンロード。
 * アクションログがある場合は JSON に埋め込む。
 * @returns 保存先パス（ブラウザ/キャンセル時は null）
 */
export async function exportProjectJson(
  blocks: SubtitleBlock[],
  actionLog?: SessionLog,
): Promise<string | null> {
  const payload: Record<string, unknown> = {
    version: 1,
    savedAt: new Date().toISOString(),
    blocks,
  }
  if (actionLog) payload.actionLog = actionLog

  const data = JSON.stringify(payload, null, 2)
  return saveFileNative(data, 'subtitle-project.json', [
    { name: 'JSON', extensions: ['json'] },
  ])
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

// ─── SRT インポート ────────────────────────────────────────────────────────

export function importSrt(file: File): Promise<SubtitleBlock[]> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = e => {
      try {
        const blocks = parseSrt(e.target?.result as string)
        resolve(blocks)
      } catch (err) {
        reject(err)
      }
    }
    reader.onerror = () => reject(new Error('ファイル読み込みに失敗しました'))
    reader.readAsText(file, 'utf-8')
  })
}

function srtTimeToSeconds(time: string): number {
  const normalized = time.replace(',', '.')
  const parts = normalized.split(':')
  const h = parseInt(parts[0], 10)
  const m = parseInt(parts[1], 10)
  const s = parseFloat(parts[2])
  return h * 3600 + m * 60 + s
}

const TIMESTAMP_RE = /^(\d{2}:\d{2}:\d{2}[,\.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,\.]\d{3})/

/** 次の行がタイムスタンプ行かどうか（= 新ブロックの開始） */
function isNextBlockStart(lines: string[], i: number): boolean {
  const cur = lines[i]?.trim() ?? ''
  const next = lines[i + 1]?.trim() ?? ''
  if (/^\d+$/.test(cur) && TIMESTAMP_RE.test(next)) return true
  if (TIMESTAMP_RE.test(cur)) return true
  return false
}

function parseSrt(text: string): SubtitleBlock[] {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  const blocks: SubtitleBlock[] = []
  let idCounter = 1
  let i = 0

  while (i < lines.length) {
    while (i < lines.length && !lines[i].trim()) i++
    if (i >= lines.length) break

    if (/^\d+$/.test(lines[i].trim())) i++
    if (i >= lines.length) break

    const timeMatch = lines[i].trim().match(TIMESTAMP_RE)
    if (!timeMatch) { i++; continue }

    const startTime = srtTimeToSeconds(timeMatch[1])
    const endTime   = srtTimeToSeconds(timeMatch[2])
    i++

    const textLines: string[] = []
    while (i < lines.length) {
      const line = lines[i].trim()
      if (!line) break
      if (isNextBlockStart(lines, i)) break
      textLines.push(line)
      i++
    }

    if (textLines.length === 0) continue

    // 2行SRT（日本語+英語）: 1行目→target、2行目以降→source
    // 1行SRT（英語のみ）:     1行目→source、target は空
    const source = textLines.length >= 2 ? textLines.slice(1).join('\n') : textLines[0]
    const target = textLines.length >= 2 ? textLines[0] : ''

    const duration = Math.max(0.01, endTime - startTime)
    blocks.push({
      id: idCounter++,
      startTime,
      endTime,
      source,
      target,
      cps: Math.round(source.length / duration * 10) / 10,
      charCount: source.length,
      status: 'pending',
      glossaryTerms: [],
    })
  }

  if (blocks.length === 0) throw new Error('有効な字幕ブロックが見つかりません')
  return blocks
}

// ─── SRT エクスポート ──────────────────────────────────────────────────────

/**
 * SRT をネイティブダイアログで保存する。
 * アクションログがある場合、同じフォルダに <name>.actions.json を自動書き出しする。
 * @returns 保存先パス（ブラウザ/キャンセル時は null）
 */
export async function exportSrt(
  blocks: SubtitleBlock[],
  actionLog?: SessionLog,
): Promise<string | null> {
  const lines = blocks.map((block, i) => {
    const start = secondsToSrtTime(block.startTime)
    const end   = secondsToSrtTime(block.endTime)
    return `${i + 1}\n${start} --> ${end}\n${block.source}`
  })
  const srtContent = lines.join('\n\n') + '\n'

  const srtPath = await saveFileNative(srtContent, 'subtitles.srt', [
    { name: 'SRT', extensions: ['srt'] },
  ])

  // アクションログをサイドカーとして書き出す（Tauri のみ）
  if (srtPath && actionLog) {
    try {
      const { writeTextFile } = await import('@tauri-apps/plugin-fs')
      const logPath = srtPath.replace(/\.srt$/i, '.actions.json')
      await writeTextFile(logPath, JSON.stringify(actionLog, null, 2))
    } catch {
      // ログ書き出し失敗は無視（メインの SRT は保存済み）
    }
  }

  return srtPath
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
