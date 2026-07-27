import { afterEach, describe, expect, it } from 'vitest'
import { beginLlmCall, getLlmActivitySnapshot, resetLlmActivity } from './llmActivity'

describe('llmActivity', () => {
  afterEach(() => {
    resetLlmActivity()
  })

  it('increments inFlight and totalStarted on begin', () => {
    resetLlmActivity()
    beginLlmCall()
    const snapshot = getLlmActivitySnapshot()
    expect(snapshot.inFlight).toBe(1)
    expect(snapshot.totalStarted).toBe(1)
    expect(snapshot.totalCompleted).toBe(0)
    expect(snapshot.lastCompletedAt).toBeNull()
  })

  it('decrements inFlight and records completion when the end function is called', () => {
    resetLlmActivity()
    const end = beginLlmCall()
    end()
    const snapshot = getLlmActivitySnapshot()
    expect(snapshot.inFlight).toBe(0)
    expect(snapshot.totalCompleted).toBe(1)
    expect(snapshot.lastCompletedAt).not.toBeNull()
  })

  it('does not double-decrement when the end function is called more than once', () => {
    resetLlmActivity()
    const end = beginLlmCall()
    end()
    end()
    end()
    const snapshot = getLlmActivitySnapshot()
    expect(snapshot.inFlight).toBe(0)
    expect(snapshot.totalCompleted).toBe(1)
  })

  it('tracks multiple concurrent calls independently', () => {
    resetLlmActivity()
    const end1 = beginLlmCall()
    const end2 = beginLlmCall()
    beginLlmCall()
    expect(getLlmActivitySnapshot().inFlight).toBe(3)
    end1()
    expect(getLlmActivitySnapshot().inFlight).toBe(2)
    end2()
    expect(getLlmActivitySnapshot().inFlight).toBe(1)
  })

  it('resets all counters via resetLlmActivity', () => {
    const end = beginLlmCall()
    end()
    beginLlmCall()
    resetLlmActivity()
    const snapshot = getLlmActivitySnapshot()
    expect(snapshot).toEqual({
      inFlight: 0,
      lastCompletedAt: null,
      totalStarted: 0,
      totalCompleted: 0,
    })
  })
})
