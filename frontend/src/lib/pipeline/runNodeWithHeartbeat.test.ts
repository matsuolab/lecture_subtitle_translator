import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { beginLlmCall, resetLlmActivity } from '@/lib/aiGateway/llmActivity'
import { HEARTBEAT_INTERVAL_MS, runNodeWithHeartbeat } from './runNodeWithHeartbeat'

describe('runNodeWithHeartbeat', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetLlmActivity()
  })

  afterEach(() => {
    vi.useRealTimers()
    resetLlmActivity()
  })

  it('calls onStep once at start with no detail', async () => {
    const onStep = vi.fn()
    await runNodeWithHeartbeat('fastNode', () => 'ok', onStep)
    expect(onStep).toHaveBeenCalledWith('fastNode')
  })

  it('does not emit a heartbeat when the node finishes before HEARTBEAT_INTERVAL_MS elapses', async () => {
    const onStep = vi.fn()
    await runNodeWithHeartbeat('fastNode', async () => 'ok', onStep)

    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 2)

    // 開始時の1回のみ（detail 無し）。ノード完了後はタイマーが動いていないため増えない。
    expect(onStep).toHaveBeenCalledTimes(1)
    expect(onStep).toHaveBeenCalledWith('fastNode')
  })

  it('emits a heartbeat with elapsed seconds and LLM activity after HEARTBEAT_INTERVAL_MS while still running', async () => {
    const onStep = vi.fn()
    let resolveRun: (value: string) => void = () => {}
    const runPromise = new Promise<string>((resolve) => { resolveRun = resolve })

    const resultPromise = runNodeWithHeartbeat('slowNode', () => runPromise, onStep)

    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS)

    expect(onStep).toHaveBeenCalledWith('slowNode', {
      elapsedSec: 15,
      inFlightLlmCalls: 0,
      secondsSinceLastLlmResponse: null,
    })

    resolveRun('done')
    await resultPromise
  })

  it('reflects in-flight LLM calls and seconds-since-last-response in the heartbeat detail', async () => {
    const onStep = vi.fn()
    let resolveRun: (value: string) => void = () => {}
    const runPromise = new Promise<string>((resolve) => { resolveRun = resolve })

    // 1件は応答待ち、1件は完了済み（10秒前に完了したとみなす）にする。
    beginLlmCall()
    const endSecondCall = beginLlmCall()
    endSecondCall()

    const resultPromise = runNodeWithHeartbeat('llmHeavyNode', () => runPromise, onStep)

    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS)

    const heartbeatCall = onStep.mock.calls.find((call) => call[1] !== undefined)
    expect(heartbeatCall).toBeDefined()
    const detail = heartbeatCall?.[1]
    expect(detail?.inFlightLlmCalls).toBe(1)
    expect(detail?.secondsSinceLastLlmResponse).toBe(15)

    resolveRun('done')
    await resultPromise
  })

  it('fires multiple heartbeats at each interval while the node keeps running', async () => {
    const onStep = vi.fn()
    let resolveRun: (value: string) => void = () => {}
    const runPromise = new Promise<string>((resolve) => { resolveRun = resolve })

    const resultPromise = runNodeWithHeartbeat('verySlowNode', () => runPromise, onStep)

    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 3)

    const heartbeatCalls = onStep.mock.calls.filter((call) => call[1] !== undefined)
    expect(heartbeatCalls).toHaveLength(3)
    expect(heartbeatCalls.map((call) => call[1]?.elapsedSec)).toEqual([15, 30, 45])

    resolveRun('done')
    await resultPromise
  })

  it('clears the heartbeat timer after the node completes (no heartbeats after completion)', async () => {
    const onStep = vi.fn()
    let resolveRun: (value: string) => void = () => {}
    const runPromise = new Promise<string>((resolve) => { resolveRun = resolve })

    const resultPromise = runNodeWithHeartbeat('node', () => runPromise, onStep)
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS)
    resolveRun('done')
    await resultPromise

    const callCountAfterCompletion = onStep.mock.calls.length
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 3)

    expect(onStep.mock.calls.length).toBe(callCountAfterCompletion)
  })

  it('clears the heartbeat timer even if run() throws (no heartbeats after failure)', async () => {
    const onStep = vi.fn()

    await expect(
      runNodeWithHeartbeat('failingNode', async () => { throw new Error('boom') }, onStep),
    ).rejects.toThrow('boom')

    const callCountAfterFailure = onStep.mock.calls.length
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 3)

    expect(onStep.mock.calls.length).toBe(callCountAfterFailure)
  })

  it('works without an onStep callback', async () => {
    await expect(runNodeWithHeartbeat('node', () => 'ok')).resolves.toBe('ok')
  })
})
