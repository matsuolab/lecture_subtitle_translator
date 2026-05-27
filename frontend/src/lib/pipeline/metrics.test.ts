import { describe, expect, it } from 'vitest'

import { computeMetrics } from './metrics'

describe('computeMetrics', () => {
  it('excludes whitespace from CPS character count while preserving visual line length', () => {
    const metrics = computeMetrics({
      start: 0,
      end: 2,
      jaChars: 10,
      alignConf: 'exact',
      merged: false,
      enText: 'BatchNorm has\nlearnable parameters',
    })

    expect(metrics.enChars).toBe('BatchNormhaslearnableparameters'.length)
    expect(metrics.cps).toBe(metrics.enChars / 2)
    expect(metrics.maxLineLen).toBe('learnable parameters'.length)
  })
})
