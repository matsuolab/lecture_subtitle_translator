import { describe, expect, it } from 'vitest'

import type { AdminSettings } from '@/types/adminSettings'
import type { EnBlock, PipelineThresholds } from './blockTypes'
import { runPhase3 } from './phase3'
import { countCpsChars } from '../subtitleMetrics'

const thresholds: PipelineThresholds = {
  shortDurationSec: 1.5,
  longDurationSec: 10,
  mergedLongDurationSec: 7,
  overCompressedRatio: 0.25,
  overCompressedJaChars: 15,
  verboseEnRatio: 1.5,
  verboseCps: 16.9,
  maxLineLen: 30,
  slowCps: 3,
  maxExpandPerBlock: 3,
  maxCompressPerBlock: 5,
}

const settings = {
  textNormalizationEnabled: false,
} as AdminSettings

function enBlock(partial: Partial<EnBlock> & Pick<EnBlock, 'id' | 'jaText' | 'enText'>): EnBlock {
  const { id, jaText, enText, ...rest } = partial
  const start = partial.start ?? 0
  const end = partial.end ?? 8
  const enChars = countCpsChars(enText)
  return {
    id,
    start,
    end,
    jaText,
    jaChars: jaText.length,
    enText,
    enRaw: partial.enRaw ?? enText,
    enChars,
    cps: enChars / Math.max(0.001, end - start),
    maxLineLen: Math.max(...enText.split('\n').map(line => line.length)),
    violation: 'ok',
    alignConf: 'exact',
    merged: false,
    expandCount: 0,
    compressCount: 0,
    ...rest,
  }
}

describe('runPhase3', () => {
  it('applies final line formatting before saving subtitle blocks', async () => {
    const visited: string[] = []
    const result = await runPhase3(
      [
        enBlock({
          id: 1,
          jaText: 'これは長い字幕です。',
          enText: 'This subtitle should be wrapped before it is saved',
        }),
      ],
      settings,
      [],
      thresholds,
      async (nodeId, run) => {
        visited.push(nodeId)
        return run()
      },
    )

    expect(visited).toContain('finalFormatLines')
    expect(result.blocks[0].source).toContain('\n')
    expect(Math.max(...result.blocks[0].source.split('\n').map(line => line.length))).toBeLessThanOrEqual(30)
  })
})
