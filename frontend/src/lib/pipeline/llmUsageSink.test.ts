import { describe, expect, it } from 'vitest'
import { createLlmUsageSink, aggregateLlmUsageByModel, safePush } from './llmUsageSink'

describe('llmUsageSink', () => {
  it('records pushed entries with auto-filled at timestamp', () => {
    const sink = createLlmUsageSink()
    sink.push({ nodeId: 'translateEn', model: 'gpt-5.4-mini', promptTokens: 100, completionTokens: 50 })
    sink.push({ nodeId: 'compress', model: 'gpt-5.4-nano', promptTokens: 10, completionTokens: 5 })
    const records = sink.records()
    expect(records).toHaveLength(2)
    expect(records[0].nodeId).toBe('translateEn')
    expect(records[0].at).toBeTypeOf('number')
    expect(records[1].model).toBe('gpt-5.4-nano')
  })

  it('safePush ignores undefined sink and zero-token records', () => {
    safePush(undefined, { nodeId: 'x', model: 'm', promptTokens: 0, completionTokens: 0 })
    const sink = createLlmUsageSink()
    safePush(sink, { nodeId: 'x', model: 'm', promptTokens: 0, completionTokens: 0 })
    expect(sink.records()).toHaveLength(0)
    safePush(sink, { nodeId: 'y', model: 'm', promptTokens: 1, completionTokens: 0 })
    expect(sink.records()).toHaveLength(1)
  })
})

describe('aggregateLlmUsageByModel', () => {
  it('aggregates token totals per model and counts calls', () => {
    const sink = createLlmUsageSink()
    sink.push({ nodeId: 'translateEn', model: 'mini', promptTokens: 100, completionTokens: 50, reasoningTokens: 10 })
    sink.push({ nodeId: 'correct', model: 'mini', promptTokens: 200, completionTokens: 80, cachedInputTokens: 40 })
    sink.push({ nodeId: 'splitJa', model: 'nano', promptTokens: 30, completionTokens: 15 })
    const aggregated = aggregateLlmUsageByModel(sink.records())
    const mini = aggregated.find(a => a.model === 'mini')!
    const nano = aggregated.find(a => a.model === 'nano')!
    expect(mini.calls).toBe(2)
    expect(mini.promptTokens).toBe(300)
    expect(mini.completionTokens).toBe(130)
    expect(mini.reasoningTokens).toBe(10)
    expect(mini.cachedInputTokens).toBe(40)
    expect(nano.calls).toBe(1)
    expect(nano.promptTokens).toBe(30)
  })

  it('returns empty array for empty input', () => {
    expect(aggregateLlmUsageByModel([])).toEqual([])
  })

  it('sorts by total tokens descending', () => {
    const sink = createLlmUsageSink()
    sink.push({ nodeId: 'a', model: 'small', promptTokens: 10, completionTokens: 5 })
    sink.push({ nodeId: 'b', model: 'big', promptTokens: 1000, completionTokens: 500 })
    const aggregated = aggregateLlmUsageByModel(sink.records())
    expect(aggregated[0].model).toBe('big')
    expect(aggregated[1].model).toBe('small')
  })
})
