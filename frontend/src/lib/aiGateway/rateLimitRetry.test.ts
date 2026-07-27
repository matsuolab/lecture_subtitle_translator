import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  RATE_LIMIT_MAX_ATTEMPTS,
  computeBackoffDelayMs,
  delayRespectingAbort,
  parseDurationStringMs,
  parseRetryAfterMs,
  readResponseHeader,
  resolveRateLimitDelayMs,
  resolveRateLimitResetHeaderDelayMs,
} from './rateLimitRetry'

describe('computeBackoffDelayMs（指数バックオフ + ジッタ）', () => {
  it('doubles the base delay for each attempt without jitter (random=0.5 → no offset)', () => {
    const noJitter = () => 0.5 // (0.5*2-1) = 0 なのでジッタ無し
    expect(computeBackoffDelayMs(1, noJitter)).toBe(1000)
    expect(computeBackoffDelayMs(2, noJitter)).toBe(2000)
    expect(computeBackoffDelayMs(3, noJitter)).toBe(4000)
    expect(computeBackoffDelayMs(4, noJitter)).toBe(8000)
  })

  it('caps the exponential growth at the upper bound for large attempt numbers', () => {
    const noJitter = () => 0.5
    // 2^(10-1)*1000 は上限(30000)を大きく超えるため、上限でクランプされる
    expect(computeBackoffDelayMs(10, noJitter)).toBeLessThanOrEqual(30_000)
  })

  it('applies jitter within a ±50% range so concurrent retries do not resend at the exact same instant', () => {
    // random()=1 → 最大ジッタ (+50%), random()=0 → 最小ジッタ (-50%)
    const maxJitter = computeBackoffDelayMs(2, () => 1)
    const minJitter = computeBackoffDelayMs(2, () => 0)
    expect(maxJitter).toBeGreaterThan(2000)
    expect(minJitter).toBeLessThan(2000)
    expect(minJitter).toBeGreaterThanOrEqual(0)
  })

  it('never returns a negative delay', () => {
    expect(computeBackoffDelayMs(1, () => 0)).toBeGreaterThanOrEqual(0)
  })
})

describe('parseRetryAfterMs（Retry-After ヘッダの解釈）', () => {
  it('parses a seconds-format value', () => {
    expect(parseRetryAfterMs('2')).toBe(2000)
  })

  it('parses an HTTP-date value relative to now', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    expect(parseRetryAfterMs('Thu, 01 Jan 2026 00:00:05 GMT')).toBe(5000)
    vi.useRealTimers()
  })

  it('returns null for missing or unparsable values', () => {
    expect(parseRetryAfterMs(null)).toBeNull()
    expect(parseRetryAfterMs(undefined)).toBeNull()
    expect(parseRetryAfterMs('')).toBeNull()
    expect(parseRetryAfterMs('not-a-valid-value !!')).toBeNull()
  })
})

describe('parseDurationStringMs（x-ratelimit-reset-* ヘッダの duration 文字列パース）', () => {
  it('parses a plain seconds duration ("1s")', () => {
    expect(parseDurationStringMs('1s')).toBe(1000)
  })

  it('parses a combined minutes+seconds duration ("6m0s")', () => {
    expect(parseDurationStringMs('6m0s')).toBe(360_000)
  })

  it('parses a milliseconds duration ("120ms")', () => {
    expect(parseDurationStringMs('120ms')).toBe(120)
  })

  it('parses fractional and multi-unit durations ("1h2m3.5s")', () => {
    expect(parseDurationStringMs('1h2m3.5s')).toBe(3_600_000 + 120_000 + 3500)
  })

  it('parses microsecond units, rounded to the nearest millisecond ("2000us" / "2000µs" → 2ms)', () => {
    // 戻り値は setTimeout に渡す ms 単位のため、内部でミリ秒未満は四捨五入される
    // （parseDurationStringMs の実装参照）。境界値の丸め誤差を避けるため、
    // ちょうど整数msになる値で検証する。
    expect(parseDurationStringMs('2000us')).toBe(2)
    expect(parseDurationStringMs('2000µs')).toBe(2)
  })

  it('returns null for missing or empty values', () => {
    expect(parseDurationStringMs(null)).toBeNull()
    expect(parseDurationStringMs(undefined)).toBeNull()
    expect(parseDurationStringMs('')).toBeNull()
    expect(parseDurationStringMs('   ')).toBeNull()
  })

  it('returns null for values with no recognizable unit', () => {
    expect(parseDurationStringMs('5')).toBeNull()
    expect(parseDurationStringMs('abc')).toBeNull()
  })

  it('returns null for a value with stray characters mixed in', () => {
    expect(parseDurationStringMs('1x2s')).toBeNull()
    expect(parseDurationStringMs('1sabc')).toBeNull()
  })

  it('returns null for a negative-looking value (no valid digit token at the start)', () => {
    expect(parseDurationStringMs('-5s')).toBeNull()
  })
})

describe('resolveRateLimitResetHeaderDelayMs（x-ratelimit-reset-requests / -tokens のどちらが大きいかを採用）', () => {
  it('uses x-ratelimit-reset-requests when only that header is present', () => {
    const response = new Response('', { headers: { 'x-ratelimit-reset-requests': '2s' } })
    expect(resolveRateLimitResetHeaderDelayMs(response)).toBe(2000)
  })

  it('uses x-ratelimit-reset-tokens when only that header is present', () => {
    const response = new Response('', { headers: { 'x-ratelimit-reset-tokens': '6m0s' } })
    expect(resolveRateLimitResetHeaderDelayMs(response)).toBe(360_000)
  })

  it('prefers the larger of the two when both are present', () => {
    const response = new Response('', {
      headers: { 'x-ratelimit-reset-requests': '1s', 'x-ratelimit-reset-tokens': '6m0s' },
    })
    expect(resolveRateLimitResetHeaderDelayMs(response)).toBe(360_000)
  })

  it('returns null when neither header is present', () => {
    const response = new Response('', { headers: {} })
    expect(resolveRateLimitResetHeaderDelayMs(response)).toBeNull()
  })
})

describe('resolveRateLimitDelayMs の優先順位（Retry-After > x-ratelimit-reset-* > 指数バックオフ）', () => {
  it('uses x-ratelimit-reset-requests when Retry-After is absent', () => {
    const response = new Response('', { headers: { 'x-ratelimit-reset-requests': '3s' } })
    expect(resolveRateLimitDelayMs(response, 1)).toBe(3000)
  })

  it('still prefers Retry-After over x-ratelimit-reset-* when both are present', () => {
    const response = new Response('', {
      headers: { 'Retry-After': '9', 'x-ratelimit-reset-requests': '3s' },
    })
    expect(resolveRateLimitDelayMs(response, 1)).toBe(9000)
  })

  it('falls back to exponential backoff when neither Retry-After nor x-ratelimit-reset-* is present or parseable', () => {
    const response = new Response('', { headers: { 'x-ratelimit-reset-requests': 'not-a-duration' } })
    const noJitter = () => 0.5
    expect(resolveRateLimitDelayMs(response, 1, noJitter)).toBe(1000)
  })
})

describe('readResponseHeader（Response / TauriFetchResponse どちらの形でも読める）', () => {
  it('reads from a native Response (Headers instance) case-insensitively', () => {
    const response = new Response('', { headers: { 'Retry-After': '3' } })
    expect(readResponseHeader(response, 'retry-after')).toBe('3')
  })

  it('reads from a plain Record<string,string> (TauriFetchResponse shape) case-insensitively', () => {
    const response = { status: 429, ok: false, headers: { 'Retry-After': '7' } } as unknown as Response
    expect(readResponseHeader(response, 'retry-after')).toBe('7')
  })

  it('returns null when the header is absent', () => {
    const response = new Response('', { headers: {} })
    expect(readResponseHeader(response, 'retry-after')).toBeNull()
  })
})

describe('resolveRateLimitDelayMs（Retry-After 優先、無ければ指数バックオフ）', () => {
  it('prefers Retry-After over the exponential backoff computation', () => {
    const response = new Response('', { headers: { 'Retry-After': '9' } })
    expect(resolveRateLimitDelayMs(response, 1)).toBe(9000)
  })

  it('falls back to exponential backoff when Retry-After is absent', () => {
    const response = new Response('', { headers: {} })
    const noJitter = () => 0.5
    expect(resolveRateLimitDelayMs(response, 1, noJitter)).toBe(1000)
  })
})

describe('delayRespectingAbort（待機中の中断要求は即座に打ち切る）', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('resolves after the full delay when never aborted', async () => {
    let resolved = false
    delayRespectingAbort(1000, undefined).then(() => { resolved = true })
    await vi.advanceTimersByTimeAsync(999)
    expect(resolved).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(resolved).toBe(true)
  })

  it('resolves immediately without waiting the full delay once the signal aborts mid-wait', async () => {
    const controller = new AbortController()
    let resolved = false
    delayRespectingAbort(10_000, controller.signal).then(() => { resolved = true })

    await vi.advanceTimersByTimeAsync(100)
    expect(resolved).toBe(false)

    controller.abort()
    await vi.advanceTimersByTimeAsync(0)
    expect(resolved).toBe(true)
  })

  it('resolves immediately if the signal is already aborted before the call', async () => {
    const controller = new AbortController()
    controller.abort()
    let resolved = false
    delayRespectingAbort(10_000, controller.signal).then(() => { resolved = true })
    await vi.advanceTimersByTimeAsync(0)
    expect(resolved).toBe(true)
  })

  it('resolves immediately for a non-positive delay', async () => {
    await expect(delayRespectingAbort(0, undefined)).resolves.toBeUndefined()
  })
})

describe('RATE_LIMIT_MAX_ATTEMPTS', () => {
  it('allows more attempts than a typical one-off retry (rate limiting is treated as more likely to recover)', () => {
    expect(RATE_LIMIT_MAX_ATTEMPTS).toBeGreaterThanOrEqual(5)
  })
})
