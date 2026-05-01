const FILLERS = ['えー', 'ええ', 'あの', 'あのー', 'えーと', 'そのー', 'まあ']

export function normalizeSpaces(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

export function removeFillers(text: string): string {
  let out = text
  for (const filler of FILLERS) {
    out = out.split(filler).join('')
  }
  return normalizeSpaces(out)
}

export function splitJaIntoSentences(text: string): string[] {
  const normalized = normalizeSpaces(text)
  if (!normalized) return []

  const sentences = normalized
    .split(/(?<=[。！？!?])/)
    .map((sentence) => normalizeSpaces(sentence))
    .filter(Boolean)

  return sentences.length > 0 ? sentences : [normalized]
}

export function splitEnLines42(text: string, maxChars = 42): string {
  const normalized = normalizeSpaces(text)
  if (normalized.length <= maxChars) return normalized

  const words = normalized.split(' ')
  if (words.length <= 1) {
    return normalized.slice(0, maxChars) + '\n' + normalized.slice(maxChars, maxChars * 2)
  }

  const half = normalized.length / 2
  let best = half
  let bestDist = Infinity
  let pos = 0
  for (let i = 0; i < words.length - 1; i++) {
    pos += words[i].length
    const dist = Math.abs(pos - half)
    if (dist < bestDist && pos <= maxChars) {
      bestDist = dist
      best = pos
    }
    pos += 1
  }

  const left = normalized.slice(0, best).trimEnd()
  const right = normalized.slice(best).trimStart()
  return right ? `${left}\n${right}` : left
}
