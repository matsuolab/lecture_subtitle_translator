import { describe, expect, it } from 'vitest'
import { buildPartialFailureWarning } from './partialFailureSummary'

describe('buildPartialFailureWarning', () => {
  it('returns undefined when there are no failures', () => {
    expect(buildPartialFailureWarning('correction', 0, 333)).toBeUndefined()
  })

  it('returns undefined when totalCount is 0 (nothing to report)', () => {
    expect(buildPartialFailureWarning('correction', 0, 0)).toBeUndefined()
  })

  it('marks a majority failure as CRITICAL (regression: correctJa failed 332 of 333 while reported as success)', () => {
    const message = buildPartialFailureWarning('correction', 332, 333)
    expect(message).toBeDefined()
    expect(message).toContain('CRITICAL')
    expect(message).toContain('332 of 333')
    expect(message).toContain('correction')
    expect(message).toContain('rate=100%')
  })

  it('marks an exact-half failure as CRITICAL (rate >= 0.5 boundary)', () => {
    const message = buildPartialFailureWarning('translation', 5, 10)
    expect(message).toContain('CRITICAL')
    expect(message).toContain('rate=50%')
  })

  it('marks a minority failure as partial (not CRITICAL)', () => {
    const message = buildPartialFailureWarning('translation', 2, 10)
    expect(message).toContain('partial')
    expect(message).not.toContain('CRITICAL')
    expect(message).toContain('rate=20%')
  })
})
