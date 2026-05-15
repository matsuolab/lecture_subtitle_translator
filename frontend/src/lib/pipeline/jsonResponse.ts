function stripCodeFence(content: string): string {
  const trimmed = content.trim()
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  return match ? match[1].trim() : trimmed
}

function extractJsonCandidate(content: string): string | null {
  const stripped = stripCodeFence(content)
  const start = stripped.indexOf('{')
  if (start === -1) return null

  let inString = false
  let escaped = false
  let depth = 0

  for (let i = start; i < stripped.length; i += 1) {
    const char = stripped[i]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }

    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{') depth += 1
    if (char === '}') {
      depth -= 1
      if (depth === 0) return stripped.slice(start, i + 1)
    }
  }

  return stripped.slice(start)
}

function closeJsonCandidate(candidate: string): string | null {
  const stack: string[] = []
  let inString = false
  let escaped = false

  for (const char of candidate) {
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }

    if (char === '"') {
      inString = true
    } else if (char === '{') {
      stack.push('}')
    } else if (char === '[') {
      stack.push(']')
    } else if (char === '}' || char === ']') {
      if (stack.pop() !== char) return null
    }
  }

  if (inString) return null
  return candidate + stack.reverse().join('')
}

function hasFourHexDigits(value: string, start: number): boolean {
  for (let i = start; i < start + 4; i += 1) {
    if (!/[0-9a-fA-F]/.test(value[i] ?? '')) return false
  }
  return true
}

function escapeInvalidJsonBackslashes(candidate: string): string {
  let output = ''
  let inString = false
  let escaped = false

  for (let i = 0; i < candidate.length; i += 1) {
    const char = candidate[i]
    if (!inString) {
      output += char
      if (char === '"') inString = true
      continue
    }

    if (escaped) {
      escaped = false
      output += char
      continue
    }

    if (char === '"') {
      inString = false
      output += char
      continue
    }

    if (char === '\\') {
      const next = candidate[i + 1] ?? ''
      if (/["\\/bfnrt]/.test(next)) {
        escaped = true
        output += char
        continue
      }
      if (next === 'u' && hasFourHexDigits(candidate, i + 2)) {
        escaped = true
        output += char
        continue
      }
      output += '\\\\'
      continue
    }

    output += char
  }

  return output
}

export function parseJsonObjectFromLlmContent(content: string, label: string): Record<string, unknown> {
  const candidate = extractJsonCandidate(content)
  if (!candidate) throw new Error(`${label} response was not valid JSON`)

  const attempts = [candidate]
  const escaped = escapeInvalidJsonBackslashes(candidate)
  if (escaped !== candidate) attempts.push(escaped)
  const closed = closeJsonCandidate(candidate)
  if (closed && closed !== candidate) attempts.push(closed)
  const closedEscaped = closeJsonCandidate(escaped)
  if (closedEscaped && closedEscaped !== candidate && closedEscaped !== escaped && closedEscaped !== closed) {
    attempts.push(closedEscaped)
  }

  for (const attempt of attempts) {
    try {
      const parsed = JSON.parse(attempt)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      // Try the next repair candidate.
    }
  }

  throw new Error(`${label} response was not valid JSON`)
}
