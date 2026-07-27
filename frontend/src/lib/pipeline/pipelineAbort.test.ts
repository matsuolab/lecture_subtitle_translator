import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  abortCurrentPipeline,
  isPipelineAborted,
  isPipelineAbortedError,
  PipelineAbortedError,
  setCurrentPipelineAbortController,
  throwIfPipelineAborted,
} from './pipelineAbort'
import { runNodeWithHeartbeat } from './runNodeWithHeartbeat'

afterEach(() => {
  // 解放漏れが他テストへ波及しないようにする（本番でも finally での解放が必須）
  setCurrentPipelineAbortController(null)
})

describe('pipelineAbort', () => {
  it('コントローラ未設定なら中断扱いにならない', () => {
    expect(isPipelineAborted()).toBe(false)
    expect(() => throwIfPipelineAborted()).not.toThrow()
    // 実行中でなければ中断要求は何もしない
    expect(abortCurrentPipeline()).toBe(false)
  })

  it('中断すると throwIfPipelineAborted が PipelineAbortedError を投げる', () => {
    setCurrentPipelineAbortController(new AbortController())
    expect(isPipelineAborted()).toBe(false)

    expect(abortCurrentPipeline()).toBe(true)
    expect(isPipelineAborted()).toBe(true)
    expect(() => throwIfPipelineAborted()).toThrow(PipelineAbortedError)
  })

  it('二重の中断要求は false を返す', () => {
    setCurrentPipelineAbortController(new AbortController())
    expect(abortCurrentPipeline()).toBe(true)
    expect(abortCurrentPipeline()).toBe(false)
  })

  it('コントローラを null に戻すと中断状態が残らない', () => {
    // 解放漏れがあると次回実行が開始直後に中断され、アプリが実行不能になる
    const controller = new AbortController()
    setCurrentPipelineAbortController(controller)
    abortCurrentPipeline()
    expect(isPipelineAborted()).toBe(true)

    setCurrentPipelineAbortController(null)
    expect(isPipelineAborted()).toBe(false)
    expect(() => throwIfPipelineAborted()).not.toThrow()
  })

  it('isPipelineAbortedError が他のエラーと区別する', () => {
    expect(isPipelineAbortedError(new PipelineAbortedError())).toBe(true)
    expect(isPipelineAbortedError(new Error('boom'))).toBe(false)
    expect(isPipelineAbortedError(undefined)).toBe(false)
  })

  it('中断シグナルは fetch へ渡せる AbortSignal として取得できる', () => {
    const controller = new AbortController()
    setCurrentPipelineAbortController(controller)
    abortCurrentPipeline()
    expect(controller.signal.aborted).toBe(true)
  })
})

describe('runNodeWithHeartbeat の中断検知', () => {
  it('中断済みなら次のノードを実行しない', async () => {
    setCurrentPipelineAbortController(new AbortController())
    abortCurrentPipeline()

    const run = vi.fn(async () => 'result')
    await expect(runNodeWithHeartbeat('translateEn', run)).rejects.toThrow(PipelineAbortedError)
    expect(run).not.toHaveBeenCalled()
  })

  it('中断されていなければ通常どおり実行する', async () => {
    setCurrentPipelineAbortController(new AbortController())

    const run = vi.fn(async () => 'result')
    await expect(runNodeWithHeartbeat('translateEn', run)).resolves.toBe('result')
    expect(run).toHaveBeenCalledTimes(1)
  })
})
