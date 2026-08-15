import { afterEach, describe, expect, it, vi } from 'vitest'

import { getDefaultAdminSettings } from '@/api/adminSettings'
import type { AdminSettings } from '@/types/adminSettings'
import type { EnBlock, PipelineThresholds } from '../../blockTypes'
import type { AgentThresholds, DecisionContext } from '../types'
import type { LlmCallResult } from '../../llmCallWithMeta'
import type { SubtitleLlmCallResult } from './callSubtitleLlm'
import type { SeamCheckResult } from '../../seamOnlySplitCheck'

/**
 * splitBlock ツールの単体テスト。
 *
 * 背景: canApply を修復ループに繋いだ後、実パイプライン再実行（117分・839キュー）で
 * 尺違反56件中11件（出力中で最も長い字幕群）が一度も分割を試みられなくなる退行が発生した。
 * 原因は canApply の endsIncomplete ガードと、execute 側 isBadJapaneseUnit の
 * 「末尾が助詞・接続で終わっていないか」判定が、継ぎ目のみの書き換えを許した現在の設計と
 * 矛盾していたこと（詳細は splitBlock.ts 内のコメント参照）。本テストはその2箇所の修正を検証する。
 *
 * LLM 呼び出し（split 用 llmCallWithMeta / 翻訳用 callSubtitleLlm）はモックし、実 API は呼ばない。
 * checkSeamOnlySplit は専用テスト（seamOnlySplitCheck.test.ts）があるため split_ok 固定でモックし、
 * このテストは isBadJapaneseUnit のロジックのみに焦点を当てる。
 */

const llmCallWithMetaMock = vi.hoisted(() => vi.fn())
const callSubtitleLlmMock = vi.hoisted(() => vi.fn())
const checkSeamOnlySplitMock = vi.hoisted(() => vi.fn())

vi.mock('../../llmCallWithMeta', () => ({
  llmCallWithMeta: llmCallWithMetaMock,
}))

vi.mock('./callSubtitleLlm', () => ({
  callSubtitleLlm: callSubtitleLlmMock,
}))

vi.mock('../../seamOnlySplitCheck', () => ({
  checkSeamOnlySplit: checkSeamOnlySplitMock,
}))

const { splitBlockTool } = await import('./splitBlock')

afterEach(() => {
  vi.resetAllMocks()
})

const pipelineThresholds: PipelineThresholds = {
  shortDurationSec: 1.5,
  longDurationSec: 10,
  mergedLongDurationSec: 7,
  overCompressedRatio: 0.25,
  overCompressedJaChars: 15,
  verboseCps: 17,
  maxLineLen: 200,
  slowCps: 3,
  maxExpandPerBlock: 3,
  maxCompressPerBlock: 5,
}

function makeThresholds(overrides: Partial<AgentThresholds> = {}): PipelineThresholds & AgentThresholds {
  return {
    ...pipelineThresholds,
    maxCorrectionRounds: 4,
    minMeaningfulChars: 20,
    minInterSubtitleGapMs: 80,
    minUsefulBorrowMs: 250,
    maxLeadMs: 300,
    maxLagMs: 700,
    minReductionDeltaChars: 4,
    minReductionDeltaRatio: 0.03,
    subtitleMinDurationSec: 0.833,
    maxSplitDepth: 1,
    enableOffloadNeighbor: false,
    useAgentDecision: false,
    ...overrides,
  }
}

const settings: AdminSettings = getDefaultAdminSettings()

function makeBlock(overrides: Partial<EnBlock> = {}): EnBlock {
  const enText = overrides.enText ?? 'x'.repeat(100)
  return {
    id: 1,
    start: 0,
    end: 20,
    jaText: 'これはテスト用の長い日本語のテキストです。もう少し文字数を稼ぐための文章です。',
    jaChars: 40,
    alignConf: 'exact',
    enText,
    enRaw: enText,
    enChars: enText.length,
    cps: enText.length / 20,
    maxLineLen: enText.length,
    violation: 'long_segment',
    expandCount: 0,
    compressCount: 0,
    ...overrides,
  }
}

function makeCtx(block: EnBlock, thresholds: PipelineThresholds & AgentThresholds): DecisionContext {
  return {
    block,
    blockIndex: 0,
    gapBeforeMs: 1000,
    gapAfterMs: 1000,
    physicalMaxChars: 999,
    neighborSlack: {},
    attemptHistory: [],
    thresholds,
    settings,
  }
}

function llmSuccess(content: string): LlmCallResult {
  return { content }
}

function translationSuccess(text: string): SubtitleLlmCallResult {
  return { text, abortable: false }
}

const seamOk: SeamCheckResult = { classification: 'split_ok', units: [] }

describe('splitBlockTool.canApply', () => {
  it('violation=long_segment かつ endsIncomplete=true のブロックでは true を返す（尺違反は分割以外に手段がないため endsIncomplete ガードを適用しない）', () => {
    const thresholds = makeThresholds()
    const block = makeBlock({
      violation: 'long_segment',
      endsIncomplete: true,
      start: 0,
      end: 20, // 20秒: splitViable を満たす十分な長さ
      jaText: 'これはテスト用の長い日本語のテキストで、まだ文章が続いていて',
    })
    const ctx = makeCtx(block, thresholds)

    expect(splitBlockTool.canApply(ctx)).toBe(true)
  })

  it('violation=cps_over（extreme tier）かつ endsIncomplete=true のブロックでは false を返す（従来どおり圧縮に譲る）', () => {
    const thresholds = makeThresholds()
    // durationSec=5, verboseCps=17 → physicalMaxChars=85。enChars=300 で overRatio=3.5 (extreme)。
    const enText = 'x'.repeat(300)
    const block = makeBlock({
      violation: 'cps_over',
      endsIncomplete: true,
      start: 0,
      end: 5,
      enText,
      enRaw: enText,
      enChars: 300,
      cps: 300 / 5,
      jaText: 'これはテスト用の長い日本語のテキストで、まだ文章がずっと続いていく想定の長文です',
    })
    const ctx = makeCtx(block, thresholds)

    expect(splitBlockTool.canApply(ctx)).toBe(false)
  })
})

describe('splitBlockTool.execute', () => {
  it('WhisperXとの一致が高いとき、本文を変えずに子cueを発話境界へ寄せ、wordsを分離する', async () => {
    const thresholds = makeThresholds()
    const leftJa = 'これは前半の詳しい説明です。'
    const rightJa = 'これは後半の詳しい説明です。'
    const jaText = `${leftJa}${rightJa}`
    const normalizedChars = Array.from(jaText.replace(/[。\s]/g, ''))
    const words = normalizedChars.map((word, index) => ({
      word,
      start: index * 0.5,
      end: (index + 1) * 0.5,
      score: 1,
    }))
    const spokenBoundary = leftJa.replace(/[。\s]/g, '').length * 0.5
    const sourceRefs = [{ sourceSegmentId: 7, semanticUnitId: 'original-unit', relation: 'semantic_unit' as const }]
    const block = makeBlock({
      jaText,
      start: 0,
      end: normalizedChars.length * 0.5,
      words,
      sourceRefs,
      violation: 'long_segment',
    })

    llmCallWithMetaMock.mockResolvedValueOnce(llmSuccess(JSON.stringify({
      units: [{ text: leftJa }, { text: rightJa }],
    })))
    checkSeamOnlySplitMock.mockReturnValueOnce(seamOk)
    callSubtitleLlmMock
      .mockResolvedValueOnce(translationSuccess('This is a detailed explanation of the first part for the audience.'))
      .mockResolvedValueOnce(translationSuccess('This explains the second part.'))

    const patch = await splitBlockTool.execute(block, makeCtx(block, thresholds), settings, thresholds)

    expect(patch.changed).toBe(true)
    expect(patch.replaceBlocks.map(child => child.jaText)).toEqual([leftJa, rightJa])
    expect(patch.replaceBlocks.map(child => child.enText)).toEqual([
      'This is a detailed explanation of the first part for the audience.',
      'This explains the second part.',
    ])
    expect(patch.replaceBlocks[0].end).toBeCloseTo(spokenBoundary - 0.08, 3)
    expect(patch.replaceBlocks[1].start).toBeCloseTo(spokenBoundary, 3)
    expect(patch.replaceBlocks[0].words?.at(-1)?.end).toBeCloseTo(spokenBoundary, 3)
    expect(patch.replaceBlocks[1].words?.[0]?.start).toBeCloseTo(spokenBoundary, 3)
    expect(patch.replaceBlocks[0].words).not.toEqual(block.words)
    expect(patch.replaceBlocks[1].words).not.toEqual(block.words)
    expect(patch.replaceBlocks.every(child => child.sourceRefs === sourceRefs)).toBe(false)
    expect(patch.replaceBlocks.map(child => child.sourceRefs)).toEqual([
      [{ ...sourceRefs[0], relation: 'correction_split' }],
      [{ ...sourceRefs[0], relation: 'correction_split' }],
    ])
    expect(patch.splitTiming).toEqual(expect.objectContaining({ basis: 'asr_constrained' }))
  })

  it('入力が助詞で終わるブロックを分割したとき、最後のユニットが助詞で終わっていても採用される', async () => {
    const thresholds = makeThresholds()
    const jaText = 'この機能はとても便利で、多くのユーザーに使われているので'
    const block = makeBlock({ jaText, violation: 'long_segment', start: 0, end: 20 })

    llmCallWithMetaMock.mockResolvedValueOnce(llmSuccess(JSON.stringify({
      units: [
        { text: 'この機能はとても便利です。' },
        { text: '多くのユーザーに使われているので' }, // 助詞「ので」で終わる（原文の末尾を引き継いでいる）
      ],
    })))
    checkSeamOnlySplitMock.mockReturnValueOnce(seamOk)
    callSubtitleLlmMock
      .mockResolvedValueOnce(translationSuccess('This feature is very convenient.'))
      .mockResolvedValueOnce(translationSuccess('It is used by many users.'))

    const patch = await splitBlockTool.execute(block, makeCtx(block, thresholds), settings, thresholds)

    expect(patch.changed).toBe(true)
    expect(patch.replaceBlocks).toHaveLength(2)
  })

  it('入力が「。」で終わる（完全な）ブロックでは、最後のユニットが助詞で終わっていたら従来どおり不採用', async () => {
    const thresholds = makeThresholds()
    const jaText = 'この機能はとても便利です。多くのユーザーに評価されています。'
    const block = makeBlock({ jaText, violation: 'long_segment', start: 0, end: 20 })

    llmCallWithMetaMock.mockResolvedValueOnce(llmSuccess(JSON.stringify({
      units: [
        { text: 'この機能はとても便利です。' },
        { text: '多くのユーザーに評価されているので' }, // 原文は完結しているのに助詞で終わる不正な出力
      ],
    })))
    checkSeamOnlySplitMock.mockReturnValueOnce(seamOk)

    const patch = await splitBlockTool.execute(block, makeCtx(block, thresholds), settings, thresholds)

    expect(patch.changed).toBe(false)
    expect(patch.warning).toContain('rejected incomplete or too-short Japanese unit')
    // 翻訳フェーズまで進んでいない（早期に弾かれている）ことも確認する
    expect(callSubtitleLlmMock).not.toHaveBeenCalled()
  })

  it('分割で生まれた子キューは、親の文脈グループ情報をそのまま引き継がず独立した singleton になる', async () => {
    // 背景: execute は子ブロックを `{ ...block, id, start, end, ... }` で作るため、以前は
    // contextGroupId / contextGroupSize / contextGroupRole / contextGroupSourceIds が
    // 親からそのままコピーされていた。親が複数キューの文脈グループ（incomplete_end_context_group、
    // size>1）だった場合、finalSafeMerge.ts は sameContextGroup && contextGroupSize>1 を
    // 結合条件にしているため、子が親のグループ ID とサイズ(>1)を引き継いだままだと
    // 「意図して分割した子」が finalSafeMerge で直後に再結合されてしまう。
    const thresholds = makeThresholds()
    const jaText = 'この機能はとても便利で、多くのユーザーに使われているので'
    const block = makeBlock({
      jaText,
      violation: 'long_segment',
      start: 0,
      end: 20,
      contextGroupId: 'cg-1-3',
      contextGroupIndex: 1,
      contextGroupSize: 3,
      contextGroupRole: 'middle',
      contextGroupReason: 'incomplete_end_context_group',
      contextGroupText: '（グループ全体のテキスト）',
      contextGroupSourceIds: [0, 1, 2],
    })

    llmCallWithMetaMock.mockResolvedValueOnce(llmSuccess(JSON.stringify({
      units: [
        { text: 'この機能はとても便利です。' },
        { text: '多くのユーザーに使われているので' },
      ],
    })))
    checkSeamOnlySplitMock.mockReturnValueOnce(seamOk)
    callSubtitleLlmMock
      .mockResolvedValueOnce(translationSuccess('This feature is very convenient.'))
      .mockResolvedValueOnce(translationSuccess('It is used by many users.'))

    const patch = await splitBlockTool.execute(block, makeCtx(block, thresholds), settings, thresholds)

    expect(patch.changed).toBe(true)
    expect(patch.replaceBlocks).toHaveLength(2)
    for (const child of patch.replaceBlocks) {
      expect(child.contextGroupSize).toBe(1)
      expect(child.contextGroupRole).toBe('single')
      expect(child.contextGroupId).not.toBe(block.contextGroupId)
      expect(child.contextGroupSourceIds).toEqual([child.id])
    }
    // 子同士も互いに異なる singleton グループであり、同じグループ扱いにはならない
    expect(patch.replaceBlocks[0].contextGroupId).not.toBe(patch.replaceBlocks[1].contextGroupId)
  })

  it('最後のユニットが6文字未満なら、入力が不完全でも不採用（最小文字数の判定は免除しない）', async () => {
    const thresholds = makeThresholds()
    const jaText = 'この機能はとても便利で、多くのユーザーに使われているので'
    const block = makeBlock({ jaText, violation: 'long_segment', start: 0, end: 20 })

    llmCallWithMetaMock.mockResolvedValueOnce(llmSuccess(JSON.stringify({
      units: [
        { text: 'この機能はとても便利です。' },
        { text: 'ので' }, // 6文字未満の断片
      ],
    })))
    checkSeamOnlySplitMock.mockReturnValueOnce(seamOk)

    const patch = await splitBlockTool.execute(block, makeCtx(block, thresholds), settings, thresholds)

    expect(patch.changed).toBe(false)
    expect(patch.warning).toContain('rejected incomplete or too-short Japanese unit')
    expect(callSubtitleLlmMock).not.toHaveBeenCalled()
  })
})
