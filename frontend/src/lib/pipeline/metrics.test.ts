import { describe, expect, it } from 'vitest'

import type { PipelineThresholds } from './blockTypes'
import { classifyViolation, computeMetrics } from './metrics'

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

// 実機データ（117分・923キュー）で実測した閾値と一致させる: CPS>18 / 行長>75 / 比>1.5
const thresholds: PipelineThresholds = {
  shortDurationSec: 1.5,
  longDurationSec: 10.0,
  mergedLongDurationSec: 7.0,
  overCompressedRatio: 0.25,
  overCompressedJaChars: 15,
  verboseCps: 18,
  maxLineLen: 75,
  slowCps: 3.0,
  maxExpandPerBlock: 3,
  maxCompressPerBlock: 5,
}

describe('classifyViolation', () => {
  it('returns cps_over when CPS exceeds the limit', () => {
    // enChars=50 / duration=2s = cps 25 (> 18)。maxLineLen=50 (<=75) なので行長は無関係。
    const violation = classifyViolation(
      {
        start: 0,
        end: 2,
        jaChars: 20,
        alignConf: 'exact',
        merged: false,
        enText: 'x'.repeat(50),
      },
      thresholds,
    )

    expect(violation).toBe('cps_over')
  })

  // 今回の変更の核心: en/ja 比が閾値(1.5)を超えていても、CPS と行長が上限内なら
  // 違反として扱わない。実測で比の中央値は 2.21 であり、比だけでの判定は
  // 「翻訳が冗長かもしれない」という推測に過ぎず、視聴者が経験する実害
  // （読めない速さ・画面に収まらない行長）ではないため。
  it('returns ok when en/ja ratio is high but CPS and line length are within limits', () => {
    // enChars=30 / jaChars=10 = 比 3.0 (> 1.5)。enChars=30 / duration=3s = cps 10 (<= 18)。
    const violation = classifyViolation(
      {
        start: 0,
        end: 3,
        jaChars: 10,
        alignConf: 'exact',
        merged: false,
        enText: 'x'.repeat(30),
      },
      thresholds,
    )

    expect(violation).toBe('ok')
  })

  // 従来は enJaRatio が先にマッチして 'verbose_en' を返してしまい、この行長超過ケースが
  // 隠れていた（実機データでは line_length_only が最終出力で 0 件になっていた）。
  it('returns line_length_only when CPS is within limit but line length exceeds it', () => {
    // enChars=80 / duration=6s = cps 13.3 (<= 18)。maxLineLen=80 (> 75)。
    const violation = classifyViolation(
      {
        start: 0,
        end: 6,
        jaChars: 10,
        alignConf: 'exact',
        merged: false,
        enText: 'x'.repeat(80),
      },
      thresholds,
    )

    expect(violation).toBe('line_length_only')
  })

  it('still returns over_compressed when the ratio is far too small (content likely dropped)', () => {
    // enChars=3 / jaChars=20 = 比 0.15 (< overCompressedRatio 0.25)。cps=3/2=1.5 (< slowCps 3.0)。
    const violation = classifyViolation(
      {
        start: 0,
        end: 2,
        jaChars: 20,
        alignConf: 'exact',
        merged: false,
        enText: 'xyz',
      },
      thresholds,
    )

    expect(violation).toBe('over_compressed')
  })
})
