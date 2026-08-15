const CARDINAL_ATOMS: Readonly<Record<string, bigint>> = {
  zero: 0n,
  one: 1n,
  two: 2n,
  three: 3n,
  four: 4n,
  five: 5n,
  six: 6n,
  seven: 7n,
  eight: 8n,
  nine: 9n,
  ten: 10n,
  eleven: 11n,
  twelve: 12n,
  thirteen: 13n,
  fourteen: 14n,
  fifteen: 15n,
  sixteen: 16n,
  seventeen: 17n,
  eighteen: 18n,
  nineteen: 19n,
  twenty: 20n,
  thirty: 30n,
  forty: 40n,
  fifty: 50n,
  sixty: 60n,
  seventy: 70n,
  eighty: 80n,
  ninety: 90n,
}

const ORDINAL_ATOMS: Readonly<Record<string, bigint>> = {
  first: 1n,
  second: 2n,
  third: 3n,
  fourth: 4n,
  fifth: 5n,
  sixth: 6n,
  seventh: 7n,
  eighth: 8n,
  ninth: 9n,
  tenth: 10n,
  eleventh: 11n,
  twelfth: 12n,
  thirteenth: 13n,
  fourteenth: 14n,
  fifteenth: 15n,
  sixteenth: 16n,
  seventeenth: 17n,
  eighteenth: 18n,
  nineteenth: 19n,
  twentieth: 20n,
  thirtieth: 30n,
  fortieth: 40n,
  fiftieth: 50n,
  sixtieth: 60n,
  seventieth: 70n,
  eightieth: 80n,
  ninetieth: 90n,
}

const LARGE_SCALES: Readonly<Record<string, bigint>> = {
  thousand: 1_000n,
  million: 1_000_000n,
  billion: 1_000_000_000n,
  trillion: 1_000_000_000_000n,
}

const ORDINAL_SCALES: Readonly<Record<string, bigint>> = {
  hundredth: 100n,
  thousandth: 1_000n,
  millionth: 1_000_000n,
  billionth: 1_000_000_000n,
  trillionth: 1_000_000_000_000n,
}

interface ParsedEnglishInteger {
  value: bigint
  nextIndex: number
  negative: boolean
  form: 'cardinal' | 'ordinal'
}

function parseEnglishInteger(tokens: readonly string[], startIndex: number): ParsedEnglishInteger | null {
  type GroupState = 'empty' | 'unit' | 'tens' | 'tens_unit' | 'hundred' | 'hundred_tens' | 'hundred_unit'
  let total = 0n
  let group = 0n
  let index = startIndex
  let sign = 1n
  let sawNumber = false
  let sawScale = false
  let lastLargeScale: bigint | null = null
  let groupState: GroupState = 'empty'
  let form: 'cardinal' | 'ordinal' = 'cardinal'

  if (tokens[index] === 'minus' || tokens[index] === 'negative') {
    sign = -1n
    index += 1
  }

  while (index < tokens.length) {
    const token = tokens[index]
    if (token === 'a' && !sawNumber) {
      const nextToken = tokens[index + 1]
      if (nextToken === 'hundred' || LARGE_SCALES[nextToken] !== undefined) {
        group = 1n
        sawNumber = true
        groupState = 'unit'
        index += 1
        continue
      }
    }
    const cardinal = CARDINAL_ATOMS[token]
    if (cardinal !== undefined) {
      const canAppend = groupState === 'empty'
        || groupState === 'hundred'
        || ((groupState === 'tens' || groupState === 'hundred_tens') && cardinal > 0n && cardinal < 10n)
      if (!canAppend) break
      group += cardinal
      sawNumber = true
      if (groupState === 'empty') groupState = cardinal >= 20n ? 'tens' : 'unit'
      else if (groupState === 'tens') groupState = 'tens_unit'
      else if (groupState === 'hundred') groupState = cardinal >= 20n ? 'hundred_tens' : 'hundred_unit'
      else if (groupState === 'hundred_tens') groupState = 'hundred_unit'
      index += 1
      continue
    }

    const ordinal = ORDINAL_ATOMS[token]
    if (ordinal !== undefined) {
      const canAppend = groupState === 'empty'
        || groupState === 'hundred'
        || ((groupState === 'tens' || groupState === 'hundred_tens') && ordinal > 0n && ordinal < 10n)
      if (!canAppend) break
      group += ordinal
      sawNumber = true
      form = 'ordinal'
      index += 1
      break
    }

    const ordinalScale = ORDINAL_SCALES[token]
    if (ordinalScale === 100n && groupState === 'unit' && group > 0n && group < 10n) {
      group *= ordinalScale
      form = 'ordinal'
      index += 1
      break
    }
    if (ordinalScale !== undefined && ordinalScale > 100n && groupState !== 'empty'
      && (lastLargeScale === null || ordinalScale < lastLargeScale)) {
      total += group * ordinalScale
      group = 0n
      form = 'ordinal'
      index += 1
      break
    }

    if (token === 'hundred' && groupState === 'unit' && group > 0n && group < 10n) {
      group *= 100n
      sawScale = true
      groupState = 'hundred'
      index += 1
      continue
    }

    const scale = LARGE_SCALES[token]
    if (scale !== undefined && groupState !== 'empty' && (lastLargeScale === null || scale < lastLargeScale)) {
      total += group * scale
      group = 0n
      sawScale = true
      lastLargeScale = scale
      groupState = 'empty'
      index += 1
      continue
    }

    if (token === 'and' && sawScale && (groupState === 'hundred' || groupState === 'empty') && index + 1 < tokens.length) {
      index += 1
      continue
    }

    break
  }

  return sawNumber ? { value: sign * (total + group), nextIndex: index, negative: sign < 0n, form } : null
}

function parseDecimalDigits(tokens: readonly string[], startIndex: number): { digits: string; nextIndex: number } | null {
  let digits = ''
  let index = startIndex
  while (index < tokens.length) {
    const value = CARDINAL_ATOMS[tokens[index]]
    if (value === undefined || value < 0n || value > 9n) break
    digits += value.toString()
    index += 1
  }
  return digits ? { digits, nextIndex: index } : null
}

function tokenizeEnglishNumberWords(text: string): string[] {
  return (text.toLowerCase().match(/[a-z]+(?:-[a-z]+)*/g) ?? []).flatMap((token) => {
    const parts = token.split('-')
    if (parts.length !== 2) return [token]
    const tens = CARDINAL_ATOMS[parts[0]]
    const unit = CARDINAL_ATOMS[parts[1]] ?? ORDINAL_ATOMS[parts[1]]
    // Standard English compounds are twenty-one / twenty-first. Keeping other
    // hyphenated forms opaque prevents one-third from being misread as 1 + 3.
    return tens !== undefined && tens >= 20n && tens < 100n && tens % 10n === 0n
      && unit !== undefined && unit > 0n && unit < 10n
      ? parts
      : [token]
  })
}

function parseGroupedYear(tokens: readonly string[], startIndex: number): ParsedEnglishInteger | null {
  const century = CARDINAL_ATOMS[tokens[startIndex]]
  if (century === undefined || century < 10n || century > 20n) return null

  const remainder = parseEnglishInteger(tokens, startIndex + 1)
  if (!remainder || remainder.value < 10n || remainder.value > 99n) return null

  return {
    value: century * 100n + remainder.value,
    nextIndex: remainder.nextIndex,
    negative: false,
    form: 'cardinal',
  }
}

export interface EnglishNumberExpression {
  value: string
  form: 'cardinal' | 'ordinal'
}

/** Extracts maximal English cardinal, ordinal, and decimal phrases as canonical decimal strings. */
export function extractEnglishNumberExpressions(text: string): EnglishNumberExpression[] {
  const tokens = tokenizeEnglishNumberWords(text)
  const expressions: EnglishNumberExpression[] = []
  const seen = new Set<string>()

  const addExpression = (expression: EnglishNumberExpression) => {
    const key = `${expression.value}:${expression.form}`
    if (seen.has(key)) return
    seen.add(key)
    expressions.push(expression)
  }

  for (let index = 0; index < tokens.length;) {
    const groupedYear = parseGroupedYear(tokens, index)
    if (groupedYear) {
      addExpression({ value: groupedYear.value.toString(), form: 'cardinal' })
      index = groupedYear.nextIndex
      continue
    }
    const parsed = parseEnglishInteger(tokens, index)
    if (!parsed) {
      index += 1
      continue
    }
    if (tokens[parsed.nextIndex] === 'point') {
      const decimal = parseDecimalDigits(tokens, parsed.nextIndex + 1)
      if (decimal) {
        const integerMagnitude = parsed.value < 0n ? -parsed.value : parsed.value
        addExpression({
          value: `${parsed.negative ? '-' : ''}${integerMagnitude}.${decimal.digits}`,
          form: 'cardinal',
        })
        index = decimal.nextIndex
        continue
      }
    }
    addExpression({ value: parsed.value.toString(), form: parsed.form })
    index = parsed.nextIndex
  }

  return expressions
}
