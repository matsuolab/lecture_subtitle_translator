import { afterEach, describe, expect, it, vi } from 'vitest'
import { tauriFetch } from './tauriFetch'

// テスト環境では isTauri() が false になるため、tauriFetch は常にブラウザ(native fetch)経路を通る。
// ここでは global.fetch をモックし、init.signal の abort 伝播だけを検証する
// （実ネットワークに依存せず、timeoutMs → AbortSignal.timeout の合成ロジックをテストする）。
describe('tauriFetch timeoutMs (browser path)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('rejects once timeoutMs elapses', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url: RequestInfo | URL, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        const signal = init?.signal
        signal?.addEventListener('abort', () => {
          reject(signal.reason ?? new DOMException('The operation was aborted.', 'TimeoutError'))
        })
      })
    })

    await expect(tauriFetch('http://127.0.0.1:1/unreachable', { timeoutMs: 5 })).rejects.toThrow()
  })

  it('combines an existing signal with timeoutMs so either can abort the request', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url: RequestInfo | URL, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        const signal = init?.signal
        signal?.addEventListener('abort', () => {
          reject(signal.reason ?? new DOMException('aborted', 'AbortError'))
        })
      })
    })

    const controller = new AbortController()
    const promise = tauriFetch('http://127.0.0.1:1/unreachable', {
      timeoutMs: 60_000,
      signal: controller.signal,
    })
    controller.abort(new DOMException('caller aborted', 'AbortError'))

    await expect(promise).rejects.toThrow()
  })

  it('resolves normally when neither timeoutMs nor signal fires', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200, headers: { 'Content-Type': 'text/plain' } }))

    const res = await tauriFetch('http://127.0.0.1:1/reachable', { timeoutMs: 60_000 })

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('ok')
  })
})
