import { describe, expect, it } from 'vitest'
import { buildLlmFailureCode, classifyHttpErrorCode, isInsufficientQuotaHttpError, isRateLimitedHttpStatus } from './errors'

describe('classifyHttpErrorCode', () => {
  it('classifies HTTP 429 as rate_limited (本番事故の再現: gpt-5.4-mini 同時実行7で1053件中668件が429だった)', () => {
    expect(classifyHttpErrorCode(429, '{"error":{"message":"Rate limit reached"}}')).toBe('rate_limited')
  })

  it('classifies HTTP 429 with error.code=insufficient_quota as quota_exhausted (公式仕様: 課金枠切れは rate_limited と区別する)', () => {
    expect(classifyHttpErrorCode(429, JSON.stringify({
      error: { message: 'You exceeded your current quota.', type: 'insufficient_quota', code: 'insufficient_quota' },
    }))).toBe('quota_exhausted')
  })

  it('classifies HTTP 429 with error.type=insufficient_quota (but no error.code) as quota_exhausted', () => {
    expect(classifyHttpErrorCode(429, JSON.stringify({
      error: { message: 'You exceeded your current quota.', type: 'insufficient_quota' },
    }))).toBe('quota_exhausted')
  })

  it('classifies HTTP 503 as rate_limited (サーバ過負荷も同じバックオフ対象に含める)', () => {
    expect(classifyHttpErrorCode(503, 'Service Unavailable')).toBe('rate_limited')
  })

  it('classifies HTTP 529 as rate_limited (Anthropic 系の overloaded ステータス相当)', () => {
    expect(classifyHttpErrorCode(529, 'Overloaded')).toBe('rate_limited')
  })

  it('classifies HTTP 400 + context length wording as context_exceeded (決定的エラー。rate_limited と混同しない)', () => {
    expect(classifyHttpErrorCode(400, 'Context size has been exceeded.')).toBe('context_exceeded')
  })

  it('classifies other HTTP errors (e.g. 401/404/500) as the generic http_error', () => {
    expect(classifyHttpErrorCode(401, 'Unauthorized')).toBe('http_error')
    expect(classifyHttpErrorCode(404, 'Not Found')).toBe('http_error')
    expect(classifyHttpErrorCode(500, 'Internal Server Error')).toBe('http_error')
  })
})

describe('isInsufficientQuotaHttpError', () => {
  it('returns true for a 429 body with error.code=insufficient_quota', () => {
    expect(isInsufficientQuotaHttpError(429, JSON.stringify({ error: { code: 'insufficient_quota' } }))).toBe(true)
  })

  it('returns true for a 429 body with error.type=insufficient_quota', () => {
    expect(isInsufficientQuotaHttpError(429, JSON.stringify({ error: { type: 'insufficient_quota' } }))).toBe(true)
  })

  it('returns false for a plain rate-limited 429 body (no insufficient_quota marker)', () => {
    expect(isInsufficientQuotaHttpError(429, JSON.stringify({ error: { message: 'Rate limit reached', type: 'rate_limit_error' } }))).toBe(false)
  })

  it('returns false for non-429 statuses even if the body mentions insufficient_quota', () => {
    expect(isInsufficientQuotaHttpError(400, JSON.stringify({ error: { code: 'insufficient_quota' } }))).toBe(false)
    expect(isInsufficientQuotaHttpError(500, JSON.stringify({ error: { code: 'insufficient_quota' } }))).toBe(false)
  })

  it('falls back to string search when the body is not valid JSON', () => {
    expect(isInsufficientQuotaHttpError(429, 'error: insufficient_quota, please check your billing')).toBe(true)
    expect(isInsufficientQuotaHttpError(429, 'not json and no marker either')).toBe(false)
  })
})

describe('isRateLimitedHttpStatus', () => {
  it('returns true only for the rate-limited status set', () => {
    expect(isRateLimitedHttpStatus(429)).toBe(true)
    expect(isRateLimitedHttpStatus(503)).toBe(true)
    expect(isRateLimitedHttpStatus(529)).toBe(true)
    expect(isRateLimitedHttpStatus(500)).toBe(false)
    expect(isRateLimitedHttpStatus(400)).toBe(false)
  })
})

describe('buildLlmFailureCode（字幕本文・プロジェクトJSONに埋め込む失敗理由の組み立て。プロバイダの生応答本文を含めない）', () => {
  it('builds http_<status> for the generic http_error code', () => {
    expect(buildLlmFailureCode({ errorCode: 'http_error', httpStatus: 429 })).toBe('http_429')
  })

  it('returns the errorCode itself for rate_limited / context_exceeded / quota_exhausted (short classification codes)', () => {
    expect(buildLlmFailureCode({ errorCode: 'rate_limited', httpStatus: 429 })).toBe('rate_limited')
    expect(buildLlmFailureCode({ errorCode: 'context_exceeded', httpStatus: 400 })).toBe('context_exceeded')
    expect(buildLlmFailureCode({ errorCode: 'quota_exhausted', httpStatus: 429 })).toBe('quota_exhausted')
  })

  it('falls back to http_<status> when only httpStatus is known', () => {
    expect(buildLlmFailureCode({ httpStatus: 503 })).toBe('http_503')
  })

  it('falls back to unknown_error when neither errorCode nor httpStatus is known', () => {
    expect(buildLlmFailureCode({})).toBe('unknown_error')
  })

  it('never includes raw provider response text (regression: organization id leak via 429 body)', () => {
    const code = buildLlmFailureCode({ errorCode: 'rate_limited', httpStatus: 429 })
    expect(code).not.toContain('organization')
    expect(code).not.toContain('{"error"')
  })
})
