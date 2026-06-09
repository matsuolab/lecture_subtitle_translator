import { describe, expect, it } from 'vitest'
import type { EnBlock, PipelineThresholds } from './blockTypes'
import { finalSafeMerge } from './finalSafeMerge'
import { countCpsChars } from '../subtitleMetrics'

const thresholds: PipelineThresholds = {
  shortDurationSec: 1.5,
  longDurationSec: 10,
  mergedLongDurationSec: 7,
  overCompressedRatio: 0.25,
  overCompressedJaChars: 15,
  verboseEnRatio: 1.5,
  verboseCps: 17,
  maxLineLen: 42,
  slowCps: 3,
  maxExpandPerBlock: 3,
  maxCompressPerBlock: 5,
}

function block(partial: Partial<EnBlock> & Pick<EnBlock, 'id' | 'start' | 'end' | 'jaText' | 'enText'>): EnBlock {
  const enChars = countCpsChars(partial.enText)
  const duration = Math.max(0.001, partial.end - partial.start)
  return {
    jaChars: partial.jaText.replace(/\s/g, '').length,
    alignConf: 'exact',
    enRaw: partial.enText,
    enChars,
    cps: enChars / duration,
    maxLineLen: Math.max(...partial.enText.split('\n').map(line => line.length)),
    violation: 'ok',
    expandCount: 0,
    compressCount: 0,
    contextGroupId: 'cg-1-2',
    contextGroupIndex: partial.id - 1,
    contextGroupSize: 2,
    contextGroupRole: partial.id === 1 ? 'lead' : 'tail',
    contextGroupText: '今回は勾配を確認して、 逆伝播の流れを見ます。',
    contextGroupSourceIds: [1, 2],
    ...partial,
  }
}

describe('finalSafeMerge', () => {
  it('merges adjacent cues in the same context group when display constraints are preserved', () => {
    const result = finalSafeMerge([
      block({
        id: 1,
        start: 0,
        end: 2.5,
        jaText: '今回はニューラルネットワークの学習で使う勾配の意味を丁寧に確認して、',
        enText: 'We will review gradients in PyTorch',
      }),
      block({
        id: 2,
        start: 2.7,
        end: 6.2,
        jaText: '逆伝播でその値がどのように流れていくのかを順番に見ます。',
        enText: 'and trace how backpropagation flows.',
      }),
    ], thresholds)

    expect(result.mergedCount).toBe(1)
    expect(result.blocks).toHaveLength(1)
    expect(result.blocks[0].enText).toBe('We will review gradients in PyTorch\nand trace how backpropagation flows.')
    expect(result.blocks[0].violation).toBe('ok')
    expect(result.blocks[0].contextGroupRole).toBe('single')
    expect(result.entries[0]).toMatchObject({
      status: 'merged',
      leftId: 1,
      rightId: 2,
      afterLineCount: 2,
      afterViolation: 'ok',
    })
  })

  it('rejects cross-context and long-duration pairs', () => {
    const crossGroup = block({
      id: 2,
      start: 2.7,
      end: 6.2,
      jaText: '別の話題です。',
      enText: 'This starts a different topic.',
      contextGroupId: 'cg-2',
    })
    const crossResult = finalSafeMerge([
      block({ id: 1, start: 0, end: 2.5, jaText: '前の話題です。', enText: 'This closes the previous topic.' }),
      crossGroup,
    ], thresholds)
    expect(crossResult.mergedCount).toBe(0)
    expect(crossResult.entries).toHaveLength(0)

    const longResult = finalSafeMerge([
      block({ id: 1, start: 0, end: 3.4, jaText: '長い前半です。', enText: 'This is the first half of the explanation.' }),
      block({ id: 2, start: 3.5, end: 7.4, jaText: '長い後半です。', enText: 'This is the second half of the explanation.' }),
    ], thresholds)
    expect(longResult.mergedCount).toBe(0)
    expect(longResult.entries[0]).toMatchObject({
      status: 'rejected',
      reason: 'duration 7.40s > 7.00s',
    })
  })

  it('rejects merges that would create a CPS violation', () => {
    const result = finalSafeMerge([
      block({
        id: 1,
        start: 0,
        end: 1.8,
        jaText: '短い範囲です。',
        enText: 'Dense wording remains fast here',
      }),
      block({
        id: 2,
        start: 1.9,
        end: 3.2,
        jaText: 'さらに続きます。',
        enText: 'and this extra phrase stays rapid',
      }),
    ], thresholds)

    expect(result.mergedCount).toBe(0)
    expect(result.entries[0].status).toBe('rejected')
    expect(result.entries[0].reason).toMatch(/^CPS /)
  })
})
