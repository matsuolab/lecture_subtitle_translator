import { describe, expect, it } from 'vitest'
import type { SubtitleBlock } from '@/types/subtitle'
import { summarizeCompletedPipelineRun } from './runCompletion'

function block(): SubtitleBlock {
  return {
    id: 1,
    startTime: 0,
    endTime: 2,
    subtitle: 'Seven seconds.',
    transcript: '7秒です。',
    cps: 7,
    charCount: 13,
    status: 'pending',
    glossaryTerms: [],
  }
}

describe('summarizeCompletedPipelineRun', () => {
  it('reports a completed run with quota exhaustion as warning and preserves measured token totals', () => {
    const result = summarizeCompletedPipelineRun({
      blocks: [block()],
      startedAt: 1_000,
      finishedAt: 3_500,
      maxCps: 18,
      maxCharsPerLine: 42,
      llmUsage: [{
        nodeId: 'translateEn',
        model: 'gpt-5.6-luna',
        promptTokens: 11,
        completionTokens: 7,
        reasoningTokens: 3,
        cachedInputTokens: 5,
      }],
      llmErrors: [{
        at: 3_000,
        nodeName: 'compress_trim',
        model: 'gpt-5.6-luna',
        httpStatus: 429,
        errorCode: 'quota_exhausted',
        detail: 'insufficient_quota',
      }],
    })

    expect(result.status).toBe('warning')
    expect(result.message).toContain('API残高不足')
    expect(result.metrics.cost).toEqual({
      inputTokens: 11,
      outputTokens: 7,
      reasoningTokens: 3,
      cachedInputTokens: 5,
      estimatedUsd: null,
      durationMs: 2_500,
    })
  })

  it('keeps an error-free completed run successful without inventing a dollar estimate', () => {
    const result = summarizeCompletedPipelineRun({
      blocks: [block()],
      startedAt: 1_000,
      finishedAt: 2_000,
      maxCps: 18,
      maxCharsPerLine: 42,
      llmUsage: [{
        nodeId: 'translateEn',
        model: 'local-model-without-pricing',
        promptTokens: 5,
        completionTokens: 3,
      }],
    })

    expect(result.status).toBe('success')
    expect(result.message).toBe('パイプライン完了（1ブロック）')
    expect(result.metrics.cost.inputTokens).toBe(5)
    expect(result.metrics.cost.outputTokens).toBe(3)
    expect(result.metrics.cost.estimatedUsd).toBeNull()
  })
})
