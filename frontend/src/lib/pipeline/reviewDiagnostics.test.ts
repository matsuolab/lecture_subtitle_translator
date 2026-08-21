import { describe, expect, it } from 'vitest'

import type { EnBlock, PipelineThresholds } from './blockTypes'
import { buildReviewItemsForBlock } from './reviewDiagnostics'
import { countCpsChars } from '../subtitleMetrics'

const thresholds: PipelineThresholds = {
  shortDurationSec: 1.5,
  longDurationSec: 10,
  mergedLongDurationSec: 7,
  overCompressedRatio: 0.25,
  overCompressedJaChars: 15,
  verboseCps: 17,
  maxLineLen: 42,
  slowCps: 3,
  maxExpandPerBlock: 3,
  maxCompressPerBlock: 5,
}

function block(seed: Pick<EnBlock, 'id' | 'start' | 'end' | 'jaText' | 'enText'> & Partial<EnBlock>): EnBlock {
  const enChars = countCpsChars(seed.enText)
  const duration = Math.max(0.001, seed.end - seed.start)
  return {
    jaChars: seed.jaText.replace(/\s/g, '').length,
    alignConf: 'exact',
    enRaw: seed.enText,
    enChars,
    cps: enChars / duration,
    maxLineLen: Math.max(...seed.enText.split('\n').map(line => line.length)),
    violation: 'ok',
    expandCount: 0,
    compressCount: 0,
    ...seed,
  }
}

describe('buildReviewItemsForBlock - cps_near_limit（旧 verbose_ratio_over_limit）', () => {
  it('does not fire on a high en/ja ratio alone when CPS is far below the limit', () => {
    // ratio 3.33（旧 verboseEnRatio 閾値1.5の2倍以上）でも cps=5（上限17の95%=16.15から遠い）
    // なら発火しない。比のみによる発火（旧 clearlyVerbose）を撤去したことの確認。
    // verboseEnRatio 自体は判定から撤去済みのため、ここでは撤去前の閾値をテスト用の
    // 参照値としてリテラルで残す（thresholds からは読まない）。
    const formerVerboseEnRatioThreshold = 1.5
    const b = block({
      id: 1,
      start: 0,
      end: 6,
      jaText: 'これはテストです。',
      enText: 'Sure, here is a short example today.',
    })
    expect(b.cps).toBeLessThan(thresholds.verboseCps * 0.95)
    expect(b.enChars / b.jaChars).toBeGreaterThan(formerVerboseEnRatioThreshold)

    const items = buildReviewItemsForBlock(b, thresholds)
    expect(items.map(i => i.reason)).not.toContain('cps_near_limit')
  })

  it('fires when CPS approaches the limit (>= 95% of verboseCps) even without a high ratio trigger', () => {
    // cps=16.5（上限17の95%=16.15以上、上限未満）なら、比の値によらず予兆として発火する。
    const b = block({
      id: 2,
      start: 0,
      end: 2,
      jaText: 'これはテストです。',
      enText: 'Sure, this line sits near the speed cap.',
    })
    expect(b.cps).toBeGreaterThanOrEqual(thresholds.verboseCps * 0.95)
    expect(b.cps).toBeLessThanOrEqual(thresholds.verboseCps)

    const items = buildReviewItemsForBlock(b, thresholds)
    const item = items.find(i => i.reason === 'cps_near_limit')
    expect(item).toBeDefined()
    // 実害ではなく予兆のため、should_review ではなく最下位の auto_pass に位置づける。
    expect(item?.priority).toBe('auto_pass')
    expect(item?.details?.[0]).toContain('CPS')
  })

  it('does not fire cps_near_limit once CPS actually exceeds the limit (cps_over_limit takes over instead)', () => {
    const b = block({
      id: 3,
      start: 0,
      end: 1,
      jaText: 'これはテストです。',
      enText: 'Sure, this line is now over the speed cap today.',
    })
    expect(b.cps).toBeGreaterThan(thresholds.verboseCps)

    const items = buildReviewItemsForBlock(b, thresholds)
    expect(items.map(i => i.reason)).not.toContain('cps_near_limit')
    expect(items.map(i => i.reason)).toContain('cps_over_limit')
  })
})
