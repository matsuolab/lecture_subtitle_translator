import type { GlossaryEntry } from '@/context/GlossaryContext'

const HEADER = 'ja,en,abbreviation,domain,note'

/**
 * カノニカルCSV形式をパースして GlossaryEntry[] を返す
 *
 * 対応ヘッダー: ja, en, abbreviation (or abbr), domain, note
 * 1行目はヘッダーとして扱い、空行・jaまたはenが空の行はスキップする
 */
export function parseGlossaryCsv(text: string): GlossaryEntry[] {
  const lines = text.split(/\r?\n/)
  if (lines.length < 2) return []

  const header = lines[0].split(',').map(h => h.trim().toLowerCase())
  const idxJa   = header.indexOf('ja')
  const idxEn   = header.indexOf('en')
  const idxAbbr = header.findIndex(h => h === 'abbreviation' || h === 'abbr')
  const idxDomain = header.indexOf('domain')
  const idxNote   = header.indexOf('note')

  if (idxJa === -1 || idxEn === -1) {
    throw new Error('CSVヘッダーに "ja" と "en" が必要です')
  }

  const entries: GlossaryEntry[] = []

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue

    const cols = parseCsvLine(line)
    const ja = cols[idxJa]?.trim() ?? ''
    const en = cols[idxEn]?.trim() ?? ''
    if (!ja || !en) continue

    entries.push({
      id: crypto.randomUUID(),
      ja,
      en,
      abbr:   idxAbbr   >= 0 ? (cols[idxAbbr]?.trim()   || undefined) : undefined,
      domain: idxDomain >= 0 ? (cols[idxDomain]?.trim()  || undefined) : undefined,
      note:   idxNote   >= 0 ? (cols[idxNote]?.trim()    || undefined) : undefined,
      confirmed: true,
    })
  }

  return entries
}

/**
 * GlossaryEntry[] をカノニカルCSV文字列にエクスポートする
 */
export function exportGlossaryCsv(entries: GlossaryEntry[]): string {
  const rows = [HEADER]
  for (const e of entries) {
    rows.push([
      escapeCsv(e.ja),
      escapeCsv(e.en),
      escapeCsv(e.abbr ?? ''),
      escapeCsv(e.domain ?? ''),
      escapeCsv(e.note ?? ''),
    ].join(','))
  }
  return rows.join('\n')
}

/** RFC4180 準拠のシングル行パーサー（ダブルクォート対応） */
function parseCsvLine(line: string): string[] {
  const cols: string[] = []
  let cur = ''
  let inQuote = false

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuote) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++ }
      else if (ch === '"') inQuote = false
      else cur += ch
    } else {
      if (ch === '"') inQuote = true
      else if (ch === ',') { cols.push(cur); cur = '' }
      else cur += ch
    }
  }
  cols.push(cur)
  return cols
}

function escapeCsv(val: string): string {
  if (/[,"\n\r]/.test(val)) return `"${val.replace(/"/g, '""')}"`
  return val
}
