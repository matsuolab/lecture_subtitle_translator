import { describe, it, expect, vi } from 'vitest'
import { splitEnNode } from '../nodes/splitEn'
import type { NodeContext } from '../nodeContract'
import type { EnglishBlock } from '../types'

function makeCtx(maxCps = 17, maxChars = 42): NodeContext {
  return {
    config: {
      subtitleConstraints: { maxCps, maxChars, maxRetry: 3 },
    } as NodeContext['config'],
    onProgress: vi.fn(),
    reportUsage: vi.fn(),
  }
}

function makeBlock(
  id: number,
  enText: string,
  start: number,
  end: number,
): EnglishBlock {
  return {
    id,
    start,
    end,
    jaText: '',
    enText,
    translationDistance: 0,
    translationFlagged: false,
    attempt: 1,
    sourceSegmentIds: [],
    blockKey: `a1s${id}`,
  }
}

describe('splitEnNode', () => {
  it('制約内のブロックは cpsOk=true で violations なし', async () => {
    const input = [makeBlock(1, 'Hello world', 0, 2)]
    const { blocks, violations } = await splitEnNode.run(input, makeCtx())
    expect(blocks[0].cpsOk).toBe(true)
    expect(violations).toHaveLength(0)
  })

  it('CPS 超過ブロックは violations に追加される', async () => {
    // 42文字を1秒で表示 → CPS=42 > 17
    const longText = 'A'.repeat(42)
    const input = [makeBlock(1, longText, 0, 1)]
    const { blocks, violations } = await splitEnNode.run(input, makeCtx())
    expect(blocks[0].cpsOk).toBe(false)
    expect(violations).toHaveLength(1)
    expect(violations[0].blockId).toBe(1)
    expect(violations[0].cps).toBeGreaterThan(17)
  })

  it('複数ブロックを処理して一部だけ違反を返す', async () => {
    const input = [
      makeBlock(1, 'Short text', 0, 3),   // OK
      makeBlock(2, 'A'.repeat(43), 3, 4), // 違反
    ]
    const { blocks, violations } = await splitEnNode.run(input, makeCtx())
    expect(blocks).toHaveLength(2)
    expect(violations).toHaveLength(1)
    expect(violations[0].blockId).toBe(2)
  })

  it('violations に start/end/maxCps が含まれる', async () => {
    const input = [makeBlock(1, 'A'.repeat(50), 1.0, 2.0)]
    const { violations } = await splitEnNode.run(input, makeCtx(17))
    expect(violations[0].start).toBe(1.0)
    expect(violations[0].end).toBe(2.0)
    expect(violations[0].maxCps).toBe(17)
  })

  it('空入力は空結果を返す', async () => {
    const { blocks, violations } = await splitEnNode.run([], makeCtx())
    expect(blocks).toHaveLength(0)
    expect(violations).toHaveLength(0)
  })
})
