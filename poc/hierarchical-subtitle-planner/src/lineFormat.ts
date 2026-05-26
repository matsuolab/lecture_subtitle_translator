export function normalizeSpaces(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

export function stripTags(text: string): string {
  return text.replace(/<[^>]+>/g, '')
}

export function visibleLength(text: string): number {
  return stripTags(text).replace(/\s/g, '').length
}

export function formatSubtitleLines(text: string, maxLineChars: number, maxLines: number): string {
  const normalized = normalizeSpaces(text)
  if (!normalized) return ''
  const words = normalized.split(' ')
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    const next = current ? `${current} ${word}` : word
    if (next.length <= maxLineChars || !current) {
      current = next
    } else {
      lines.push(current)
      current = word
    }
  }
  if (current) lines.push(current)
  if (lines.length <= maxLines) return lines.join('\n')

  const compact = normalized
  const targetLines = Math.max(1, maxLines)
  const targetLen = Math.ceil(compact.length / targetLines)
  const forced: string[] = []
  let cursor = 0
  for (let i = 0; i < targetLines; i += 1) {
    const remaining = compact.slice(cursor)
    if (i === targetLines - 1) {
      forced.push(remaining)
      break
    }
    let cut = Math.min(compact.length, cursor + targetLen)
    const space = compact.lastIndexOf(' ', cut)
    if (space > cursor + 8) cut = space
    forced.push(compact.slice(cursor, cut).trim())
    cursor = cut
    while (compact[cursor] === ' ') cursor += 1
  }
  return forced.filter(Boolean).join('\n')
}
