import { afterEach, describe, expect, it } from 'vitest'
import { getLlmErrorLog, pushLlmError, resetLlmErrorLog } from './llmErrorLog'

describe('llmErrorLog', () => {
  afterEach(() => {
    resetLlmErrorLog()
  })

  it('records pushed entries and returns them in insertion order', () => {
    resetLlmErrorLog()
    pushLlmError({ nodeName: 'translateEn[batch]', model: 'gpt-5.4-mini', httpStatus: 400, errorCode: 'http_error', detail: 'first' })
    pushLlmError({ nodeName: 'translateEn[batch]', model: 'gpt-5.4-mini', httpStatus: 429, errorCode: 'rate_limited', detail: 'second' })

    const records = getLlmErrorLog()
    expect(records).toHaveLength(2)
    expect(records[0].detail).toBe('first')
    expect(records[1].detail).toBe('second')
    expect(records[0].httpStatus).toBe(400)
    expect(records[1].errorCode).toBe('rate_limited')
  })

  it('fills in `at` with the current time when not provided', () => {
    resetLlmErrorLog()
    const before = Date.now()
    pushLlmError({ nodeName: 'n', model: 'm', detail: 'd' })
    const after = Date.now()

    const [record] = getLlmErrorLog()
    expect(record.at).toBeGreaterThanOrEqual(before)
    expect(record.at).toBeLessThanOrEqual(after)
  })

  it('truncates detail to 1000 characters', () => {
    resetLlmErrorLog()
    const huge = 'x'.repeat(5000)
    pushLlmError({ nodeName: 'n', model: 'm', detail: huge })

    const [record] = getLlmErrorLog()
    expect(record.detail.length).toBe(1000)
    expect(record.detail).toBe('x'.repeat(1000))
  })

  it('caps the buffer at 100 records, discarding the oldest ones (FIFO) so the most recent failures survive', () => {
    resetLlmErrorLog()
    for (let i = 0; i < 150; i += 1) {
      pushLlmError({ nodeName: 'n', model: 'm', detail: `entry-${i}` })
    }

    const records = getLlmErrorLog()
    expect(records).toHaveLength(100)
    // 最初の50件（entry-0 〜 entry-49）は捨てられ、直近100件（entry-50 〜 entry-149）が残る
    expect(records[0].detail).toBe('entry-50')
    expect(records[records.length - 1].detail).toBe('entry-149')
  })

  it('clears all records via resetLlmErrorLog', () => {
    pushLlmError({ nodeName: 'n', model: 'm', detail: 'd' })
    expect(getLlmErrorLog()).toHaveLength(1)

    resetLlmErrorLog()
    expect(getLlmErrorLog()).toHaveLength(0)
  })

  it('returns a defensive copy so mutating the returned array does not affect internal state', () => {
    resetLlmErrorLog()
    pushLlmError({ nodeName: 'n', model: 'm', detail: 'd' })
    const records = getLlmErrorLog()
    records.pop()

    expect(getLlmErrorLog()).toHaveLength(1)
  })
})
