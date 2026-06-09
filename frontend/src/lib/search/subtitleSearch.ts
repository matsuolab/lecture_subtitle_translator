import type { SubtitleBlock } from '@/types/subtitle'

export type SearchScope = 'all' | 'transcript' | 'subtitle'
export type SearchField = 'transcript' | 'subtitle'

export interface SearchOptions {
  query: string
  scope: SearchScope
  caseSensitive: boolean
  wholeWord: boolean
  includeApproved: boolean
}

export interface SearchMatch {
  blockId: number
  field: SearchField
  start: number
  end: number
}

/** 文字が単語構成文字かどうか（ASCII単語＋日本語/漢字） */
function isWordChar(ch: string): boolean {
  return /[\p{L}\p{N}_]/u.test(ch)
}

function findMatchesInText(
  text: string,
  query: string,
  caseSensitive: boolean,
  wholeWord: boolean,
): Array<{ start: number; end: number }> {
  if (!query) return []
  const hay = caseSensitive ? text : text.toLowerCase()
  const needle = caseSensitive ? query : query.toLowerCase()
  const out: Array<{ start: number; end: number }> = []
  let from = 0
  while (from <= hay.length - needle.length) {
    const idx = hay.indexOf(needle, from)
    if (idx === -1) break
    const end = idx + needle.length
    if (wholeWord) {
      const before = idx > 0 ? text[idx - 1] : ''
      const after = end < text.length ? text[end] : ''
      const leftOk = !before || !isWordChar(before)
      const rightOk = !after || !isWordChar(after)
      if (!leftOk || !rightOk) {
        from = idx + 1
        continue
      }
    }
    out.push({ start: idx, end })
    from = end > idx ? end : idx + 1
  }
  return out
}

export function findMatches(blocks: SubtitleBlock[], opts: SearchOptions): SearchMatch[] {
  const out: SearchMatch[] = []
  if (!opts.query) return out
  for (const block of blocks) {
    if (!opts.includeApproved && block.status === 'approved') continue
    if (opts.scope === 'all' || opts.scope === 'transcript') {
      for (const r of findMatchesInText(block.transcript, opts.query, opts.caseSensitive, opts.wholeWord)) {
        out.push({ blockId: block.id, field: 'transcript', start: r.start, end: r.end })
      }
    }
    if (opts.scope === 'all' || opts.scope === 'subtitle') {
      for (const r of findMatchesInText(block.subtitle, opts.query, opts.caseSensitive, opts.wholeWord)) {
        out.push({ blockId: block.id, field: 'subtitle', start: r.start, end: r.end })
      }
    }
  }
  return out
}

/** あるブロックの特定フィールドにおけるマッチ範囲を抽出（ハイライト用） */
export function matchesForField(
  matches: SearchMatch[],
  blockId: number,
  field: SearchField,
): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = []
  for (const m of matches) {
    if (m.blockId === blockId && m.field === field) {
      ranges.push({ start: m.start, end: m.end })
    }
  }
  return ranges
}

export interface ReplaceResult {
  /** ブロックID → 更新後の subtitle/transcript */
  updates: Array<{ id: number; subtitle?: string; transcript?: string }>
  replacedCount: number
}

/** すべてのマッチを置換した結果を計算（実際の更新は呼び出し側で行う） */
export function buildReplaceAll(
  blocks: SubtitleBlock[],
  opts: SearchOptions,
  replacement: string,
): ReplaceResult {
  const updates: Array<{ id: number; subtitle?: string; transcript?: string }> = []
  let total = 0
  for (const block of blocks) {
    if (!opts.includeApproved && block.status === 'approved') continue
    let nextSubtitle: string | undefined
    let nextTranscript: string | undefined
    if (opts.scope === 'all' || opts.scope === 'transcript') {
      const ranges = findMatchesInText(block.transcript, opts.query, opts.caseSensitive, opts.wholeWord)
      if (ranges.length > 0) {
        nextTranscript = applyReplacements(block.transcript, ranges, replacement)
        total += ranges.length
      }
    }
    if (opts.scope === 'all' || opts.scope === 'subtitle') {
      const ranges = findMatchesInText(block.subtitle, opts.query, opts.caseSensitive, opts.wholeWord)
      if (ranges.length > 0) {
        nextSubtitle = applyReplacements(block.subtitle, ranges, replacement)
        total += ranges.length
      }
    }
    if (nextSubtitle !== undefined || nextTranscript !== undefined) {
      updates.push({ id: block.id, subtitle: nextSubtitle, transcript: nextTranscript })
    }
  }
  return { updates, replacedCount: total }
}

/** 単一マッチを置換した結果（subtitle/transcript どちらか） */
export function buildReplaceOne(
  block: SubtitleBlock,
  match: SearchMatch,
  replacement: string,
): { subtitle?: string; transcript?: string } {
  if (match.field === 'transcript') {
    return { transcript: replaceRange(block.transcript, match.start, match.end, replacement) }
  }
  return { subtitle: replaceRange(block.subtitle, match.start, match.end, replacement) }
}

function applyReplacements(
  text: string,
  ranges: Array<{ start: number; end: number }>,
  replacement: string,
): string {
  if (ranges.length === 0) return text
  const sorted = [...ranges].sort((a, b) => a.start - b.start)
  let out = ''
  let cursor = 0
  for (const r of sorted) {
    out += text.slice(cursor, r.start) + replacement
    cursor = r.end
  }
  out += text.slice(cursor)
  return out
}

function replaceRange(text: string, start: number, end: number, replacement: string): string {
  return text.slice(0, start) + replacement + text.slice(end)
}
