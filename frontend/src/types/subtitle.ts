export type BlockStatus = 'pending' | 'approved' | 'flagged'

export interface GlossaryTerm {
  word: string
  expectedTranslation: string
  actualTranslation: string
  isDeviated: boolean
  /** スライドPDF等から取得した一言説明 */
  insight?: string
  /** 日英対応を色で示すためのカラーコード（アンダーライン用） */
  color?: string
  /** 背景ハイライト色。セットされている場合はアンダーラインでなく背景色で強調表示する */
  bgColor?: string
}

export interface SubtitleBlock {
  id: number
  startTime: number   // 秒
  endTime: number     // 秒
  target: string
  source: string
  cps: number
  charCount: number
  status: BlockStatus
  glossaryTerms: GlossaryTerm[]
  /** 無視するタイポ候補のキー: "${found}::${entry.en}" */
  ignoredTypos?: string[]
  /** 無視する用語漏れ候補のキー: entry.id */
  ignoredMissing?: string[]
}

export type CpsLevel = 'ok' | 'warn' | 'error'

export function getCpsLevel(cps: number): CpsLevel {
  if (cps <= 15) return 'ok'
  if (cps <= 18) return 'warn'
  return 'error'
}

/** "MM:SS.mmm" または "HH:MM:SS.mmm" → 秒数。パース失敗時は null */
export function parseTime(s: string): number | null {
  const parts = s.trim().split(':')
  if (parts.length === 2) {
    const m = parseInt(parts[0], 10)
    const sec = parseFloat(parts[1])
    if (isNaN(m) || isNaN(sec)) return null
    return m * 60 + sec
  }
  if (parts.length === 3) {
    const h = parseInt(parts[0], 10)
    const m = parseInt(parts[1], 10)
    const sec = parseFloat(parts[2])
    if (isNaN(h) || isNaN(m) || isNaN(sec)) return null
    return h * 3600 + m * 60 + sec
  }
  return null
}

export function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  const ms = Math.round((seconds % 1) * 1000)
  if (h > 0) {
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`
  }
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`
}
