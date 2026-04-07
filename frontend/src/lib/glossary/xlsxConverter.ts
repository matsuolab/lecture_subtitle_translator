import * as XLSX from 'xlsx'
import type { GlossaryEntry } from '@/context/GlossaryContext'

/**
 * 松尾研形式 XLSX を GlossaryEntry[] に変換する
 *
 * 列構造（確認済み・2026-03-29）:
 *   col 0: 講義番号
 *   col 1: ページ番号
 *   col 2: 日本語（ja）
 *   col 3: 英語（en）
 *   col 4: 略語（abbr）
 *   col 5+: メモ等（無視）
 *
 * 1行目はヘッダーとして扱う。
 * jaまたはenが空の行はスキップする。
 */
export async function convertMatsuoLabXlsx(file: File): Promise<GlossaryEntry[]> {
  const buffer = await file.arrayBuffer()
  const wb = XLSX.read(buffer, { type: 'array' })
  const ws = wb.Sheets[wb.SheetNames[0]]
  const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1 })

  const entries: GlossaryEntry[] = []

  // 行0はヘッダー、行1以降がデータ
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] as unknown[]
    const ja = toString(row[2])
    const en = toString(row[3])
    if (!ja || !en) continue

    entries.push({
      id: crypto.randomUUID(),
      ja,
      en,
      abbr:   toString(row[4]) || undefined,
      confirmed: true,
    })
  }

  return entries
}

/**
 * 汎用XLSX変換：カラムマッピングを指定して変換する
 *
 * colJa / colEn は0始まりの列インデックス
 * headerRows: スキップするヘッダー行数（デフォルト1）
 */
export async function convertXlsxWithMapping(
  file: File,
  colJa: number,
  colEn: number,
  colAbbr?: number,
  colDomain?: number,
  headerRows = 1,
): Promise<GlossaryEntry[]> {
  const buffer = await file.arrayBuffer()
  const wb = XLSX.read(buffer, { type: 'array' })
  const ws = wb.Sheets[wb.SheetNames[0]]
  const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1 })

  const entries: GlossaryEntry[] = []

  for (let i = headerRows; i < rows.length; i++) {
    const row = rows[i] as unknown[]
    const ja = toString(row[colJa])
    const en = toString(row[colEn])
    if (!ja || !en) continue

    entries.push({
      id: crypto.randomUUID(),
      ja,
      en,
      abbr:   colAbbr   !== undefined ? (toString(row[colAbbr]) || undefined) : undefined,
      domain: colDomain !== undefined ? (toString(row[colDomain]) || undefined) : undefined,
      confirmed: true,
    })
  }

  return entries
}

function toString(val: unknown): string {
  if (val === null || val === undefined) return ''
  return String(val).trim()
}
