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
  let output = ''

  for (const char of candidate) {
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      output += char
      continue
    }

    if (char === '"') {
      inString = true
    } else if (char === '{') {
      stack.push('}')
    } else if (char === '[') {
      stack.push(']')
    } else if (char === '}' || char === ']') {
      // LLMが "]}" を "}" と略すなど閉じ括弧を飛ばすことがあるため、
      // 期待される閉じ括弧を補ってから現在の閉じ括弧を消化する
      while (stack.length > 0 && stack[stack.length - 1] !== char) {
        output += stack.pop()
      }
      if (stack.pop() !== char) return null
    }
    output += char
  }

  if (inString) return null
  return output + stack.reverse().join('')
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

/**
 * 文字列要素の間にカンマが無い `["a" "b"]` を `["a","b"]` に修復する。
 * LLMが配列要素の区切りカンマを落とすことがあるため（温度0で決定的に再現する）。
 * 文字列の外側で、閉じクオートの後に空白を挟んで開きクオートが続く箇所のみ補う。
 */
function insertMissingCommasBetweenStrings(candidate: string): string {
  let output = ''
  let inString = false
  let escaped = false
  let pendingGap = ''
  let lastMeaningful = ''

  for (const char of candidate) {
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
        lastMeaningful = '"'
      }
      output += char
      continue
    }

    if (/\s/.test(char)) {
      pendingGap += char
      continue
    }

    if (char === '"' && lastMeaningful === '"') {
      output += ','
    }
    output += pendingGap + char
    pendingGap = ''
    lastMeaningful = char
    if (char === '"') inString = true
  }

  return output + pendingGap
}

/**
 * 文字列中のエスケープされていない引用符を `\"` に修復する。
 * LLMが訳文中の引用部分をエスケープせずに出力することがあるため。
 * ヒューリスティック: 文字列中の `"` は、直後（空白を除く）が構造文字
 * （`,` `}` `]` `:` または入力末尾）なら閉じクオート、それ以外は内側の引用符とみなす。
 */
function escapeUnescapedInnerQuotes(candidate: string): string {
  let output = ''
  let inString = false
  for (let i = 0; i < candidate.length; i += 1) {
    const char = candidate[i]
    if (!inString) {
      output += char
      if (char === '"') inString = true
      continue
    }
    if (char === '\\') {
      output += char + (candidate[i + 1] ?? '')
      i += 1
      continue
    }
    if (char === '"') {
      let j = i + 1
      while (j < candidate.length && /\s/.test(candidate[j])) j += 1
      const next = candidate[j]
      if (next === undefined || next === ',' || next === '}' || next === ']' || next === ':') {
        inString = false
        output += char
      } else {
        output += '\\"'
      }
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
  const commaFixed = insertMissingCommasBetweenStrings(candidate)
  if (commaFixed !== candidate) {
    attempts.push(commaFixed)
    const commaFixedClosed = closeJsonCandidate(commaFixed)
    if (commaFixedClosed && commaFixedClosed !== commaFixed) attempts.push(commaFixedClosed)
  }
  const quoteEscaped = escapeUnescapedInnerQuotes(candidate)
  if (quoteEscaped !== candidate) {
    attempts.push(quoteEscaped)
    const quoteEscapedClosed = closeJsonCandidate(quoteEscaped)
    if (quoteEscapedClosed && quoteEscapedClosed !== quoteEscaped) attempts.push(quoteEscapedClosed)
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
