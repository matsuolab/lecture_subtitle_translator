import { describe, expect, it } from 'vitest'
import type { AdminSettings } from '@/types/adminSettings'
import type { EnBlock, PipelineThresholds } from '../blockTypes'
import type { LanguageScript } from '../languageProfileConfig'
import { getFeasibleStrategies } from './feasibility'
import { buildAgentThresholds } from './types'
import type { AgentThresholds, DecisionContext } from './types'

const BASE_THRESHOLDS: PipelineThresholds = {
  shortDurationSec: 1.5,
  longDurationSec: 14,
  mergedLongDurationSec: 12,
  overCompressedRatio: 0.25,
  overCompressedJaChars: 15,
  verboseCps: 16.9,
  maxLineLen: 80,
  slowCps: 3,
  maxExpandPerBlock: 3,
  maxCompressPerBlock: 5,
}

/**
 * tier='tiny'（超過 ≤10%）になる block を作る。
 * physicalMaxChars = floor(verboseCps * durationSec) = floor(16.9 * 4) = 67
 * enChars = 70 → overRatio ≈ 1.045 → tiny
 */
function makeTinyOvershootBlock(): EnBlock {
  return {
    id: 1,
    start: 0,
    end: 4,
    jaText: 'ソース',
    jaChars: 40,
    alignConf: 'exact',
    enText: 'x'.repeat(70),
    enRaw: 'x'.repeat(70),
    enChars: 70,
    cps: 17.5,
    maxLineLen: 70,
    violation: 'verbose_en',
  } as EnBlock
}

function makeContext(subtitleScript: LanguageScript | undefined): DecisionContext {
  const thresholds: PipelineThresholds & AgentThresholds = {
    ...BASE_THRESHOLDS,
    ...(subtitleScript ? { subtitleScript } : {}),
    ...buildAgentThresholds(),
  }
  return {
    block: makeTinyOvershootBlock(),
    blockIndex: 1,
    gapBeforeMs: 0,
    gapAfterMs: 0,
    physicalMaxChars: 67,
    neighborSlack: {},
    attemptHistory: [],
    thresholds,
    settings: {} as AdminSettings,
  }
}

describe('getFeasibleStrategies — compress_micro の言語ゲート', () => {
  it('ラテン字幕では tier=tiny で compress_micro が候補になる（従来どおり）', () => {
    const ctx = makeContext('latin')
    expect(getFeasibleStrategies(ctx, ctx.thresholds)).toContain('compress_micro')
  })

  it('subtitleScript 未指定でもラテン系として候補になる（後方互換）', () => {
    const ctx = makeContext(undefined)
    expect(getFeasibleStrategies(ctx, ctx.thresholds)).toContain('compress_micro')
  })

  it('日本語字幕では compress_micro を候補から外す', () => {
    // ツール内部の countWords / detectRemovedWord が空白区切り前提で壊れるため。
    const ctx = makeContext('japanese')
    expect(getFeasibleStrategies(ctx, ctx.thresholds)).not.toContain('compress_micro')
  })

  it('日本語字幕でも代替の圧縮戦略は残る（詰まらせない）', () => {
    const ctx = makeContext('japanese')
    const strategies = getFeasibleStrategies(ctx, ctx.thresholds)
    expect(strategies.length).toBeGreaterThan(0)
    expect(strategies.some(s => s.startsWith('compress_') || s === 'split_block')).toBe(true)
  })

  it('generic は語間空白ありとみなし候補に残す', () => {
    const ctx = makeContext('generic')
    expect(getFeasibleStrategies(ctx, ctx.thresholds)).toContain('compress_micro')
  })
})
