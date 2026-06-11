export function normalizeSpaces(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

export function splitEnLines42(text: string, maxChars = 42): string {
  const normalized = normalizeSpaces(text)
  if (normalized.length <= maxChars) return normalized

  const words = normalized.split(' ')
  if (words.length <= 1) {
    const mid = Math.floor(normalized.length / 2)
    return normalized.slice(0, mid) + '\n' + normalized.slice(mid)
  }

  const half = normalized.length / 2
  let bestPos = 0
  let bestDist = Infinity
  let pos = 0
  for (let i = 0; i < words.length - 1; i++) {
    pos += words[i].length
    const dist = Math.abs(pos - half)
    if (dist < bestDist) {
      bestDist = dist
      bestPos = pos
    }
    pos += 1
  }

  const left = normalized.slice(0, bestPos).trimEnd()
  const right = normalized.slice(bestPos).trimStart()
  return right ? `${left}\n${right}` : left
}
