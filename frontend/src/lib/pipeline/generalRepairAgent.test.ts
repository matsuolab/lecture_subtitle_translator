import { afterEach, describe, expect, it, vi } from 'vitest'

import { getDefaultAdminSettings } from '@/api/adminSettings'
import type { AdminSettings } from '@/types/adminSettings'
import type { EnBlock, PipelineThresholds } from './blockTypes'
import { hasHardMetricRegression, partitionRewritesBySafety, runGeneralRepairAgent } from './generalRepairAgent'
import { countCpsChars } from '../subtitleMetrics'

const thresholds: PipelineThresholds = {
  shortDurationSec: 1.5,
  longDurationSec: 10,
  mergedLongDurationSec: 7,
  overCompressedRatio: 0.25,
  overCompressedJaChars: 15,
  verboseCps: 16.9,
  maxLineLen: 80,
  slowCps: 3,
  maxExpandPerBlock: 3,
  maxCompressPerBlock: 5,
}

function block(partial: Partial<EnBlock> & Pick<EnBlock, 'id' | 'jaText' | 'enText' | 'cps'>): EnBlock {
  const { id, jaText, enText, cps, ...rest } = partial
  return {
    id,
    start: 0,
    end: 4,
    jaText,
    jaChars: jaText.length,
    enText,
    enRaw: enText,
    enChars: countCpsChars(enText),
    cps,
    maxLineLen: Math.max(...enText.split('\n').map(line => line.length)),
    violation: 'cps_over',
    alignConf: 'exact',
    merged: false,
    expandCount: 0,
    compressCount: 0,
    ...rest,
  }
}

describe('hasHardMetricRegression', () => {
  it('rejects a rewrite that turns a within-CPS block into a CPS violation', () => {
    const before = [
      block({
        id: 9,
        jaText: '関数として使うことはできないと、',
        enText: "so it can't be used as a plain function.",
        cps: 11.1,
      }),
    ]
    const after = [
      block({
        id: 9,
        jaText: '関数として使うことはできないと、',
        enText: "BatchNorm has learnable parameters, so it can't be used functionally.",
        cps: 19.0,
      }),
    ]

    expect(hasHardMetricRegression(before, after, [9], thresholds)).toBe(true)
  })

  it('allows a rewrite that remains within hard CPS and total character constraints', () => {
    const before = [
      block({
        id: 9,
        jaText: '関数として使うことはできないと、',
        enText: "so you can't use them as plain functions.",
        cps: 11.1,
      }),
    ]
    const after = [
      block({
        id: 9,
        jaText: '関数として使うことはできないと、',
        enText: "so it can't be used as a function.",
        cps: 9.4,
      }),
    ]

    expect(hasHardMetricRegression(before, after, [9], thresholds)).toBe(false)
  })

  it('allows line-length regression that final formatting can wrap within total character budget', () => {
    const before = [
      block({
        id: 100,
        jaText: 'くるモデルの出力というのを一番確',
        enText: 'The model output that comes out as a probability distribution is',
        cps: 15.0,
        enChars: 60,
        maxLineLen: 69,
      }),
    ]
    const after = [
      block({
        id: 100,
        jaText: 'くるモデルの出力というのを一番確',
        enText: 'The output distribution is taken as the class with the highest predicted probability.',
        cps: 14.0,
        enChars: 73,
        maxLineLen: 85,
      }),
    ]

    expect(hasHardMetricRegression(before, after, [100], thresholds)).toBe(false)
  })
})

describe('partitionRewritesBySafety', () => {
  it('keeps rewrites that improve or stay within hard constraints, drops only the regressing ones', () => {
    const before = [
      block({ id: 1, jaText: 'ja1', enText: 'safe block one', cps: 5 }),
      block({ id: 2, jaText: 'ja2', enText: 'safe block two', cps: 6 }),
      block({ id: 3, jaText: 'ja3', enText: 'safe block three', cps: 7 }),
    ]
    const after = [
      // id 1: improved (CPS 5 -> 4) - keep
      block({ id: 1, jaText: 'ja1', enText: 'better one', cps: 4 }),
      // id 2: hard regression (CPS 6 -> 18, was within, now over) - drop
      block({ id: 2, jaText: 'ja2', enText: 'verbose dense overflowing text that breaches CPS limit hard', cps: 18.0 }),
      // id 3: still OK (CPS 7 -> 9) - keep
      block({ id: 3, jaText: 'ja3', enText: 'slightly longer text', cps: 9 }),
    ]
    const rewrites = [
      { blockId: 1, jaSpan: 'ja1', en: 'better one' },
      { blockId: 2, jaSpan: 'ja2', en: 'verbose dense overflowing text that breaches CPS limit hard' },
      { blockId: 3, jaSpan: 'ja3', en: 'slightly longer text' },
    ]

    const { safe, dropped } = partitionRewritesBySafety(before, after, rewrites, thresholds)
    expect(safe.map(r => r.blockId)).toEqual([1, 3])
    expect(dropped.map(d => d.blockId)).toEqual([2])
    expect(dropped[0].reason).toMatch(/cps/i)
  })

  it('drops rewrites that exceed the per-segment character budget when before was within', () => {
    const before = [block({ id: 5, jaText: 'ja', enText: 'short', cps: 4, enChars: 5 })]
    // maxLineLen = 80, so maxSegmentChars = 160. Make after exceed 160.
    const longText = 'x'.repeat(170)
    const after = [block({ id: 5, jaText: 'ja', enText: longText, cps: 4, enChars: 170 })]
    const rewrites = [{ blockId: 5, jaSpan: 'ja', en: longText }]

    const { safe, dropped } = partitionRewritesBySafety(before, after, rewrites, thresholds)
    expect(safe).toHaveLength(0)
    expect(dropped).toHaveLength(1)
    expect(dropped[0].reason).toMatch(/chars/i)
  })

  it('keeps everything when no block has hard regression', () => {
    const before = [
      block({ id: 1, jaText: 'ja', enText: 'a', cps: 4 }),
      block({ id: 2, jaText: 'ja', enText: 'b', cps: 5 }),
    ]
    const after = [
      block({ id: 1, jaText: 'ja', enText: 'a2', cps: 4 }),
      block({ id: 2, jaText: 'ja', enText: 'b2', cps: 5 }),
    ]
    const rewrites = [
      { blockId: 1, jaSpan: 'ja', en: 'a2' },
      { blockId: 2, jaSpan: 'ja', en: 'b2' },
    ]
    const { safe, dropped } = partitionRewritesBySafety(before, after, rewrites, thresholds)
    expect(safe).toHaveLength(2)
    expect(dropped).toHaveLength(0)
  })
})

/**
 * runGeneralRepairAgent は coverage（sourceTextLexicalOverlap の重なり率）を一切引数に取らない。
 * 過去はこの重なり率の低さも起動条件に含めていたため、correctJa 等で意図的に書き換えられた
 * 日本語を「欠落」と誤認して不要な repair を走らせてしまっていた（sourceTextLexicalOverlap.ts
 * 冒頭コメント参照）。ここでは「block 単位の violation だけが起動条件である」ことを、
 * LLM 呼出の有無（fetch が呼ばれたかどうか）で検証する。
 */
describe('runGeneralRepairAgent の起動条件（coverage を判断材料にしない）', () => {
  function settings(overrides: Partial<AdminSettings> = {}): AdminSettings {
    return {
      ...getDefaultAdminSettings(),
      translationProvider: 'openai',
      openaiApiKey: 'sk-test',
      generalRepairEnabled: true,
      ...overrides,
    }
  }

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('全 block が制約を満たしていれば（＝重なり率が低いだけの状態相当）LLM を一切呼ばない', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const blocks = [
      block({ id: 1, jaText: '短くなった原文の断片', enText: 'A short line.', cps: 5, violation: 'ok' }),
      block({ id: 2, jaText: '別の断片', enText: 'Another short line.', cps: 6, violation: 'ok' }),
    ]

    const result = await runGeneralRepairAgent(blocks, settings(), thresholds)

    expect(fetchMock).not.toHaveBeenCalled()
    expect(result.enabled).toBe(true)
    expect(result.initialViolatingBlocks).toBe(0)
    expect(result.finalViolatingBlocks).toBe(0)
    expect(result.entries).toHaveLength(0)
    expect(result.blocks).toBe(blocks)
  })

  it('block 単位の violation があれば従来どおり LLM を呼び出す', async () => {
    const rewriteResponse = new Response(
      JSON.stringify({
        choices: [{
          finish_reason: 'stop',
          message: {
            content: JSON.stringify({
              rationale: 'shortened to fit cps',
              rewrites: [{ block_id: 9, en: 'Shorter line.' }],
            }),
            refusal: null,
          },
        }],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
    const fetchMock = vi.fn(async () => rewriteResponse)
    vi.stubGlobal('fetch', fetchMock)

    const blocks = [
      block({
        id: 9,
        jaText: '関数として使うことはできないと、',
        enText: "BatchNorm has learnable parameters, so it can't be used functionally as a plain stateless transformation.",
        cps: 19.0,
        violation: 'cps_over',
      }),
    ]

    const result = await runGeneralRepairAgent(blocks, settings(), thresholds, ['low'])

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0].blocksTargetedIds).toEqual([9])
  })
})

/**
 * バッチ分割の再現テスト群。
 *
 * 実機事故: 923ブロック全件を1リクエストにまとめて送っていたため、1回あたり259,465トークンとなり
 * TPM上限200,000を超えて必ず 429 になっていた（実機3回の実行すべてで発生。errorMessage: "Requested
 * 259465, Limit 200000"）。ここでは、対象ブロックを MAX_TARGETS_PER_BATCH（40）件ずつのバッチに
 * 分割して複数回 LLM を呼ぶこと、1バッチが失敗しても他バッチが続行すること、chunk_blocks が
 * 全ブロックではなくバッチの対象＋前後の文脈だけに絞られることを検証する。
 */
describe('runGeneralRepairAgent のバッチ分割（TPM 超過 429 の再現防止）', () => {
  function settings(overrides: Partial<AdminSettings> = {}): AdminSettings {
    return {
      ...getDefaultAdminSettings(),
      translationProvider: 'openai',
      openaiApiKey: 'sk-test',
      generalRepairEnabled: true,
      ...overrides,
    }
  }

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /**
   * id を 1 始まりで振った、全件 cps_over（CPS超過）で違反している block 群を作る。
   * classifyViolation は現在 CPS 超過のみで cps_over を判定する（enJaRatio による判定は
   * 廃止済み）ため、jaText の長さは判定に影響しない。
   */
  function makeViolatingBlocks(count: number): EnBlock[] {
    return Array.from({ length: count }, (_, i) => block({
      id: i + 1,
      jaText: 'あ'.repeat(40),
      // countCpsChars は空白を除去してカウントするため、空白無しの80文字で cps=80/4=20 (> verboseCps 16.9)。
      enText: 'x'.repeat(80),
      cps: 20,
      violation: 'cps_over',
    }))
  }

  /** LLM 応答を "rewrites: []"（変更なし）で返す chat/completions レスポンスを作る。 */
  function noChangeResponse(): Response {
    return new Response(
      JSON.stringify({
        choices: [{
          finish_reason: 'stop',
          message: { content: JSON.stringify({ rationale: 'no fix found', rewrites: [] }), refusal: null },
        }],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  }

  /** fetch 呼出のリクエスト本文から、送られた chunk_blocks（block_id と is_target）を取り出す。 */
  function parseChunkBlocks(init?: { body?: string }): Array<{ block_id: number; is_target: boolean }> {
    const body = JSON.parse(String(init?.body ?? '{}')) as { messages?: Array<{ role: string; content: string }> }
    const userMessage = (body.messages ?? []).find((m) => m.role === 'user')
    const prompt = JSON.parse(userMessage?.content ?? '{}') as { chunk_blocks?: Array<{ block_id: number; is_target: boolean }> }
    return prompt.chunk_blocks ?? []
  }

  it('対象ブロックが MAX_TARGETS_PER_BATCH(40) を超える場合、バッチ分割されて LLM が複数回呼ばれる', async () => {
    const blocks = makeViolatingBlocks(45) // ceil(45/40) = 2 バッチ
    const fetchMock = vi.fn(async () => noChangeResponse())
    vi.stubGlobal('fetch', fetchMock)

    const result = await runGeneralRepairAgent(blocks, settings(), thresholds, ['low'])

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0].batchCount).toBe(2)
    expect(result.entries[0].batchesSucceeded).toBe(2)
    expect(result.entries[0].batchErrors).toHaveLength(0)
  })

  it('1つのバッチが LLM エラーでも、他のバッチの rewrite は適用される', async () => {
    const blocks = makeViolatingBlocks(45)
    const fixedEnText = 'This block is now short enough to pass every constraint comfortably.'

    const fetchMock = vi.fn(async (_url: string, init?: { body?: string }) => {
      const chunkBlocks = parseChunkBlocks(init)
      const targetIds = chunkBlocks.filter((b) => b.is_target).map((b) => b.block_id)
      // block 45 を対象に含むバッチだけ成功させ、もう一方のバッチは HTTP 500 で失敗させる。
      if (targetIds.includes(45)) {
        return new Response(
          JSON.stringify({
            choices: [{
              finish_reason: 'stop',
              message: {
                content: JSON.stringify({
                  rationale: 'shortened block 45',
                  rewrites: [{ block_id: 45, en: fixedEnText }],
                }),
                refusal: null,
              },
            }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      return new Response(JSON.stringify({ error: { message: 'server error' } }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await runGeneralRepairAgent(blocks, settings(), thresholds, ['low'])

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const entry = result.entries[0]
    expect(entry.batchCount).toBe(2)
    expect(entry.batchesSucceeded).toBe(1)
    expect(entry.batchesApplied).toBe(1)
    expect(entry.batchErrors).toHaveLength(1)
    expect(entry.status).toBe('improved_partial')

    const fixedBlock = result.blocks.find((b) => b.id === 45)
    expect(fixedBlock?.enText).toBe(fixedEnText)
    expect(fixedBlock?.violation).not.toBe('cps_over')

    // 失敗したバッチの対象 block (1-40) は元のまま残っている。
    const untouchedBlock = result.blocks.find((b) => b.id === 1)
    expect(untouchedBlock?.enText).toBe('x'.repeat(80))
  })

  it('プロンプトの chunk_blocks は全ブロックではなく、バッチの対象＋前後 CONTEXT_NEIGHBORS 件だけに絞られる', async () => {
    const totalBlocks = 30
    const blocks = Array.from({ length: totalBlocks }, (_, i) => {
      const id = i + 1
      const isTarget = id >= 15 && id <= 17
      return block({
        id,
        jaText: 'てすと',
        enText: isTarget ? 'x'.repeat(80) : 'short line',
        cps: isTarget ? 20 : 5,
        violation: isTarget ? 'cps_over' : 'ok',
      })
    })

    let capturedChunkBlockIds: number[] = []
    const fetchMock = vi.fn(async (_url: string, init?: { body?: string }) => {
      capturedChunkBlockIds = parseChunkBlocks(init).map((b) => b.block_id)
      return noChangeResponse()
    })
    vi.stubGlobal('fetch', fetchMock)

    await runGeneralRepairAgent(blocks, settings(), thresholds, ['low'])

    expect(fetchMock).toHaveBeenCalledTimes(1)
    // 対象は 15-17 の3件。前後 CONTEXT_NEIGHBORS(2) 件を加えた 13-19 の7件だけが送られるべきで、
    // 全30ブロックが送られてはならない（923ブロック全件送信が429の原因だった実機事故の再発防止）。
    expect([...capturedChunkBlockIds].sort((a, b) => a - b)).toEqual([13, 14, 15, 16, 17, 18, 19])
    expect(capturedChunkBlockIds.length).toBeLessThan(totalBlocks)
  })
})
