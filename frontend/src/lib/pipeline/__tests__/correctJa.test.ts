import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NodeContext } from '../nodeContract'
import type { TranscriptSegment } from '../types'

// ---------------------------------------------------------------------------
// OpenAI SDK モック（class 形式でないと new できない）
// ---------------------------------------------------------------------------

const mockCreate = vi.fn()

vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create: mockCreate } }
  },
}))

// モック設定後にノードをインポート
const { correctJaNode } = await import('../nodes/correctJa')

// ---------------------------------------------------------------------------
// ヘルパー
// ---------------------------------------------------------------------------

function makeSeg(id: number, text: string): TranscriptSegment {
  return { id, start: id - 1, end: id, text, words: [] }
}

function makeCtx(): NodeContext {
  return {
    config: {
      openaiApiKey: 'test-key',
      correctionModel: 'gpt-4.1-nano',
      qualityThresholds: { correction: 0.15, translation: 0.25 },
    } as NodeContext['config'],
    onProgress: vi.fn(),
    reportUsage: vi.fn(),
  }
}

function mockLLMResponse(content: string) {
  mockCreate.mockResolvedValue({
    choices: [{ message: { content } }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  })
}

beforeEach(() => {
  mockCreate.mockReset()
})

// ---------------------------------------------------------------------------
// テスト
// ---------------------------------------------------------------------------

describe('correctJaNode', () => {
  it('LLM の補正結果を CorrectedSegment に変換する', async () => {
    mockLLMResponse('[1] こんにちは。\n[2] ありがとう。')

    const segments = [makeSeg(1, 'こんにちわ'), makeSeg(2, 'ありがと')]
    const result = await correctJaNode.run({ segments, embedProvider: undefined }, makeCtx())

    expect(result).toHaveLength(2)
    expect(result[0].correctedText).toBe('こんにちは。')
    expect(result[1].correctedText).toBe('ありがとう。')
    expect(result[0].original.id).toBe(1)
  })

  it('LLM が返さなかった ID は元テキストで補完する', async () => {
    mockLLMResponse('[1] 補正済み。')  // id=2 は返さない

    const segments = [makeSeg(1, '元テキスト'), makeSeg(2, 'フォールバック')]
    const result = await correctJaNode.run({ segments, embedProvider: undefined }, makeCtx())

    expect(result[0].correctedText).toBe('補正済み。')
    expect(result[1].correctedText).toBe('フォールバック')  // 元テキストで補完
  })

  it('embedProvider がない場合は correctionDistance = 0, flagged = false', async () => {
    mockLLMResponse('[1] テスト。')

    const segments = [makeSeg(1, 'テスト')]
    const result = await correctJaNode.run({ segments, embedProvider: undefined }, makeCtx())

    expect(result[0].correctionDistance).toBe(0)
    expect(result[0].correctionFlagged).toBe(false)
  })

  it('テキストが変化しないセグメントは Embed をスキップする', async () => {
    mockLLMResponse('[1] 変化なし')  // 元テキストと同じ

    const embed = { embed: vi.fn() }
    const segments = [makeSeg(1, '変化なし')]
    await correctJaNode.run({ segments, embedProvider: embed }, makeCtx())

    // 変化がないので embed は呼ばれない
    expect(embed.embed).not.toHaveBeenCalled()
  })

  it('embedProvider ありで距離が閾値超えなら flagged = true', async () => {
    mockLLMResponse('[1] 全く違うテキスト。')

    // 直交ベクトル（cosine distance = 1.0）
    const embed = {
      embed: vi.fn()
        .mockResolvedValueOnce([[1, 0, 0]])   // original
        .mockResolvedValueOnce([[0, 1, 0]]),  // corrected
    }

    const segments = [makeSeg(1, '補正前テキスト')]
    const result = await correctJaNode.run({ segments, embedProvider: embed }, makeCtx())

    expect(result[0].correctionFlagged).toBe(true)
    expect(result[0].correctionDistance).toBeCloseTo(1.0)
  })

  it('empty input returns empty array', async () => {
    const result = await correctJaNode.run({ segments: [], embedProvider: undefined }, makeCtx())
    expect(result).toHaveLength(0)
    expect(mockCreate).not.toHaveBeenCalled()
  })
})
