import type { SubtitleBlock } from '@/types/subtitle'
import type { AdminSettings } from '@/types/adminSettings'
import type { PipelineRunResult } from '@/types/pipeline'
import { normalizeSubtitleText, parseTextNormalizationConfig } from '@/lib/pipeline/textNormalization'

const STORAGE_KEY = 'matsuo-subtitle-editor-v1'

export interface SessionExportData {
  version: number
  savedAt: string
  blocks: SubtitleBlock[]
  session?: {
    videoSource?: {
      name: string
      path?: string
    } | null
    adminSettings?: Partial<AdminSettings>
    pipelineRun?: PipelineRunResult
    pipelineHistory?: PipelineRunResult[]
  }
}

interface StoredLocalSession {
  savedAt: string
  blocks: SubtitleBlock[]
  session?: SessionExportData['session']
}

// ─── localStorage（クラッシュ/誤リロード対策） ────────────────────────────

export function saveToLocalStorage(blocks: SubtitleBlock[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      savedAt: new Date().toISOString(),
      blocks,
    } satisfies StoredLocalSession))
  } catch {
    // QuotaExceededError 等は無視
  }
}

export function saveSessionSnapshotToLocalStorage(data: SessionExportData): void {
  try {
    const payload: StoredLocalSession = {
      savedAt: data.savedAt,
      blocks: data.blocks,
      session: data.session,
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
  } catch {
    // QuotaExceededError 等は無視
  }
}

export function loadFromLocalStorage(): SubtitleBlock[] | null {
  const session = loadSessionSnapshotFromLocalStorage()
  return session?.blocks ?? null
}

export function loadSessionSnapshotFromLocalStorage(): SessionExportData | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed.blocks)) return null
    // english→source / japanese→target フィールド名変更のマイグレーション
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const blocks = parsed.blocks.map((b: any) => ({
      ...b,
      source: b.source ?? b.english ?? '',
      target: b.target ?? b.japanese ?? '',
    })) as SubtitleBlock[]
    return {
      version: Number(parsed.version ?? 2),
      savedAt: String(parsed.savedAt ?? new Date(0).toISOString()),
      blocks,
      session: parsed.session,
    }
  } catch {
    return null
  }
}

export function clearLocalStorage(): void {
  localStorage.removeItem(STORAGE_KEY)
}

// ─── JSON プロジェクトファイル ─────────────────────────────────────────────

export function exportProjectJson(data: SessionExportData | SubtitleBlock[]): void {
  const payload: SessionExportData = Array.isArray(data)
    ? { version: 1, savedAt: new Date().toISOString(), blocks: data }
    : data
  const json = JSON.stringify(payload, null, 2)
  downloadFile(json, 'subtitle-project.json', 'application/json')
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
  // パターン: 現在行が数字のみ && 次行がタイムスタンプ
  if (/^\d+$/.test(cur) && TIMESTAMP_RE.test(next)) return true
  // パターン: 現在行がタイムスタンプ（インデックスなし形式）
  if (TIMESTAMP_RE.test(cur)) return true
  return false
}

function parseSrt(text: string): SubtitleBlock[] {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  const blocks: SubtitleBlock[] = []
  let idCounter = 1
  let i = 0

  while (i < lines.length) {
    // 空行をスキップ
    while (i < lines.length && !lines[i].trim()) i++
    if (i >= lines.length) break

    // インデックス行をスキップ（数字のみ）
    if (/^\d+$/.test(lines[i].trim())) i++
    if (i >= lines.length) break

    // タイムスタンプ行を探す
    const timeMatch = lines[i].trim().match(TIMESTAMP_RE)
    if (!timeMatch) { i++; continue }

    const startTime = srtTimeToSeconds(timeMatch[1])
    const endTime   = srtTimeToSeconds(timeMatch[2])
    i++

    // テキスト行を収集：空行 OR 次ブロックの始まりで停止
    const textLines: string[] = []
    while (i < lines.length) {
      const line = lines[i].trim()
      if (!line) break  // 空行 → ブロック終端
      if (isNextBlockStart(lines, i)) break  // 空行なしで次ブロックが始まる場合
      textLines.push(line)
      i++
    }

    if (textLines.length === 0) continue

    // canonical:
    // - source: subtitle text shown/exported by the app (usually English)
    // - target: reference/source-language text (usually Japanese)
    // 2行SRT は 1行目=source, 2行目以降=target として読む
    const source = textLines[0]
    const target = textLines.length >= 2 ? textLines.slice(1).join('\n') : ''

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

export function exportSrt(blocks: SubtitleBlock[], settings: AdminSettings): void {
  let normalizeSource = (text: string) => text
  if (settings.textNormalizationEnabled) {
    try {
      const config = parseTextNormalizationConfig(settings.textNormalizationRulesJson)
      normalizeSource = (text: string) => normalizeSubtitleText(text, config)
    } catch {
      const proceed = window.confirm(
        '正規化ルールが不正です\n\n' +
        '正規化ルールJSONを読み込めないため、字幕テキストを正規化できません。正規化せずにSRTを出力しますか？',
      )
      if (!proceed) return
    }
  }

  const lines = blocks.map((block, i) => {
    const start = secondsToSrtTime(block.startTime)
    const end   = secondsToSrtTime(block.endTime)
    return `${i + 1}\n${start} --> ${end}\n${normalizeSource(block.source)}`
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
