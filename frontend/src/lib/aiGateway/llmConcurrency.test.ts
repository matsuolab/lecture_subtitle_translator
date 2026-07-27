import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  acquireLlmSlot,
  getLlmConcurrencyState,
  reportLlmCallSucceeded,
  reportLlmRateLimitEncountered,
  resetLlmConcurrency,
  setLlmConcurrencyLimit,
} from './llmConcurrency'

/**
 * acquireLlmSlot() が resolve したかどうかを、マイクロタスクを1周させて判定するヘルパー。
 * Promise の resolve/reject 自体は同期的に走るが .then コールバックはマイクロタスクに
 * ずれるため、setTimeout(0) でマクロタスクまで進めて確実に判定する。
 */
async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('llmConcurrency', () => {
  afterEach(() => {
    resetLlmConcurrency()
  })

  it('does not limit concurrency when no limit is set (limit <= 0)', async () => {
    resetLlmConcurrency()
    const releases = await Promise.all([
      acquireLlmSlot(),
      acquireLlmSlot(),
      acquireLlmSlot(),
      acquireLlmSlot(),
      acquireLlmSlot(),
    ])
    expect(getLlmConcurrencyState().active).toBe(5)
    expect(getLlmConcurrencyState().queued).toBe(0)
    releases.forEach((release) => release())
    expect(getLlmConcurrencyState().active).toBe(0)
  })

  it('does not allow more concurrent acquisitions than the configured limit', async () => {
    resetLlmConcurrency()
    setLlmConcurrencyLimit(2)

    const release1 = await acquireLlmSlot()
    const release2 = await acquireLlmSlot()

    let thirdResolved = false
    const third = acquireLlmSlot().then((release) => {
      thirdResolved = true
      return release
    })

    await flushMicrotasks()
    expect(thirdResolved).toBe(false)
    expect(getLlmConcurrencyState()).toEqual({ limit: 2, active: 2, queued: 1, lastRateLimitAt: null })

    release1()
    const release3 = await third
    expect(thirdResolved).toBe(true)
    expect(getLlmConcurrencyState().active).toBe(2)
    expect(getLlmConcurrencyState().queued).toBe(0)

    release2()
    release3()
    expect(getLlmConcurrencyState().active).toBe(0)
  })

  it('lets a queued acquisition proceed as soon as a slot is released', async () => {
    resetLlmConcurrency()
    setLlmConcurrencyLimit(1)

    const release1 = await acquireLlmSlot()
    let secondGranted = false
    const secondPromise = acquireLlmSlot().then((release) => {
      secondGranted = true
      return release
    })

    await flushMicrotasks()
    expect(secondGranted).toBe(false)

    release1()
    const release2 = await secondPromise
    expect(secondGranted).toBe(true)
    release2()
  })

  it('resets limit, active count, and the wait queue via resetLlmConcurrency', async () => {
    setLlmConcurrencyLimit(1)
    await acquireLlmSlot()
    void acquireLlmSlot()
    await flushMicrotasks()
    expect(getLlmConcurrencyState().queued).toBe(1)

    resetLlmConcurrency()

    expect(getLlmConcurrencyState()).toEqual({ limit: 0, active: 0, queued: 0, lastRateLimitAt: null })
  })

  it('does not double-release when the release function is called more than once', async () => {
    resetLlmConcurrency()
    setLlmConcurrencyLimit(1)
    const release = await acquireLlmSlot()
    release()
    release()
    release()
    expect(getLlmConcurrencyState().active).toBe(0)
  })

  it('releases the slot even when the caller throws before calling release (deadlock regression)', async () => {
    resetLlmConcurrency()
    setLlmConcurrencyLimit(1)

    async function riskyCall(): Promise<void> {
      const release = await acquireLlmSlot()
      try {
        throw new Error('simulated failure inside the critical section')
      } finally {
        release()
      }
    }

    await expect(riskyCall()).rejects.toThrow('simulated failure')
    expect(getLlmConcurrencyState().active).toBe(0)

    // スロットが正しく解放されていれば、次の acquireLlmSlot は即座に進む
    // （解放漏れがあればここが永久に resolve せずテストがタイムアウトする）。
    const release = await acquireLlmSlot()
    expect(getLlmConcurrencyState().active).toBe(1)
    release()
  })

  it('drains multiple queued acquisitions in order as slots become available', async () => {
    resetLlmConcurrency()
    setLlmConcurrencyLimit(1)

    const order: number[] = []
    const release1 = await acquireLlmSlot()
    const p2 = acquireLlmSlot().then((release) => { order.push(2); return release })
    const p3 = acquireLlmSlot().then((release) => { order.push(3); return release })

    await flushMicrotasks()
    expect(getLlmConcurrencyState().queued).toBe(2)

    release1()
    const release2 = await p2
    expect(order).toEqual([2])

    release2()
    const release3 = await p3
    expect(order).toEqual([2, 3])

    release3()
    expect(getLlmConcurrencyState()).toEqual({ limit: 1, active: 0, queued: 0, lastRateLimitAt: null })
  })

  it('immediately drains the queue when the limit is raised', async () => {
    resetLlmConcurrency()
    setLlmConcurrencyLimit(1)

    const release1 = await acquireLlmSlot()
    let secondGranted = false
    const secondPromise = acquireLlmSlot().then((release) => {
      secondGranted = true
      return release
    })

    await flushMicrotasks()
    expect(secondGranted).toBe(false)

    setLlmConcurrencyLimit(2)
    const release2 = await secondPromise
    expect(secondGranted).toBe(true)
    expect(getLlmConcurrencyState().active).toBe(2)

    release1()
    release2()
  })

  describe('reportLlmRateLimitEncountered / reportLlmCallSucceeded（レート制限検知での動的絞り込みと回復）', () => {
    it('halves the effective limit (observable via getLlmConcurrencyState().limit) when a rate limit is encountered', async () => {
      resetLlmConcurrency()
      setLlmConcurrencyLimit(8)

      reportLlmRateLimitEncountered()

      expect(getLlmConcurrencyState().limit).toBe(4)
    })

    it('never drops the effective limit below 1', async () => {
      resetLlmConcurrency()
      setLlmConcurrencyLimit(1)

      reportLlmRateLimitEncountered()
      reportLlmRateLimitEncountered()

      expect(getLlmConcurrencyState().limit).toBe(1)
    })

    it('does nothing when no limit is configured (unlimited operation stays unlimited)', async () => {
      resetLlmConcurrency()
      // setLlmConcurrencyLimit を呼ばない（configuredLimit <= 0 = 無制限）

      reportLlmRateLimitEncountered()

      expect(getLlmConcurrencyState().limit).toBe(0)
    })

    it('restores the effective limit by one step after enough consecutive successes, without exceeding the configured limit', async () => {
      resetLlmConcurrency()
      setLlmConcurrencyLimit(8)
      reportLlmRateLimitEncountered()
      expect(getLlmConcurrencyState().limit).toBe(4)

      // RECOVERY_SUCCESS_STREAK (5) 回未満の成功では戻らない
      reportLlmCallSucceeded()
      reportLlmCallSucceeded()
      reportLlmCallSucceeded()
      reportLlmCallSucceeded()
      expect(getLlmConcurrencyState().limit).toBe(4)

      // 5回目でようやく1段階戻る
      reportLlmCallSucceeded()
      expect(getLlmConcurrencyState().limit).toBe(5)

      // 一度に configuredLimit まで戻さない（輻輳がまだ解消していない可能性を考慮した段階復帰）
      expect(getLlmConcurrencyState().limit).toBeLessThan(8)
    })

    it('does not exceed the configured limit even after many successes', async () => {
      resetLlmConcurrency()
      setLlmConcurrencyLimit(2)
      reportLlmRateLimitEncountered() // limit: 1 (下限)

      for (let i = 0; i < 100; i += 1) reportLlmCallSucceeded()

      expect(getLlmConcurrencyState().limit).toBe(2)
    })

    it('a fresh rate limit hit resets the recovery streak (partial progress is discarded)', async () => {
      resetLlmConcurrency()
      setLlmConcurrencyLimit(8)
      reportLlmRateLimitEncountered() // limit: 4

      reportLlmCallSucceeded()
      reportLlmCallSucceeded()
      reportLlmCallSucceeded()
      reportLlmCallSucceeded() // あと1回で回復するところだった

      reportLlmRateLimitEncountered() // limit: 2, streak reset
      expect(getLlmConcurrencyState().limit).toBe(2)

      reportLlmCallSucceeded()
      expect(getLlmConcurrencyState().limit).toBe(2) // streak がリセットされているので1回では戻らない
    })

    it('reduced effective limit actually constrains acquireLlmSlot concurrency', async () => {
      resetLlmConcurrency()
      setLlmConcurrencyLimit(4)
      reportLlmRateLimitEncountered() // limit: 2

      const release1 = await acquireLlmSlot()
      const release2 = await acquireLlmSlot()
      let thirdResolved = false
      const third = acquireLlmSlot().then((release) => { thirdResolved = true; return release })

      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(thirdResolved).toBe(false)
      expect(getLlmConcurrencyState().active).toBe(2)

      release1()
      const release3 = await third
      expect(thirdResolved).toBe(true)

      release2()
      release3()
    })

    it('setLlmConcurrencyLimit resets the effective limit back to the newly configured value (no carry-over from a previous run)', async () => {
      resetLlmConcurrency()
      setLlmConcurrencyLimit(8)
      reportLlmRateLimitEncountered()
      expect(getLlmConcurrencyState().limit).toBe(4)

      // 新しいパイプライン実行が同じ設定値で再度呼ぶ想定
      setLlmConcurrencyLimit(8)
      expect(getLlmConcurrencyState().limit).toBe(8)
    })
  })

  describe('time-based recovery（失敗が疎らに混ざり続けストリークが積み上がらない状況での回復）', () => {
    afterEach(() => {
      resetLlmConcurrency()
      vi.useRealTimers()
    })

    it('recovers one step per success once the cooldown window has elapsed since the last rate limit, even without a streak of 5', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
      resetLlmConcurrency()
      setLlmConcurrencyLimit(8)

      reportLlmRateLimitEncountered()
      expect(getLlmConcurrencyState().limit).toBe(4)
      expect(getLlmConcurrencyState().lastRateLimitAt).toBe(Date.now())

      // 疎らな成功: 5連続には満たないが、cooldown (15秒) を経過させてから1回だけ成功させる
      vi.setSystemTime(new Date('2026-01-01T00:00:16.000Z'))
      reportLlmCallSucceeded()

      // 輻輳はもう解消しているとみなし、ストリーク条件を待たず1段階戻る
      expect(getLlmConcurrencyState().limit).toBe(5)
    })

    it('keeps requiring the success streak while still inside the cooldown window', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
      resetLlmConcurrency()
      setLlmConcurrencyLimit(8)

      reportLlmRateLimitEncountered()
      expect(getLlmConcurrencyState().limit).toBe(4)

      // cooldown (15秒) 未満なら、1回の成功では戻らない（ストリーク条件が維持される）
      vi.setSystemTime(new Date('2026-01-01T00:00:10.000Z'))
      reportLlmCallSucceeded()
      expect(getLlmConcurrencyState().limit).toBe(4)

      // 5回連続成功すればストリーク経路で戻る
      reportLlmCallSucceeded()
      reportLlmCallSucceeded()
      reportLlmCallSucceeded()
      reportLlmCallSucceeded()
      expect(getLlmConcurrencyState().limit).toBe(5)
    })

    it('exposes lastRateLimitAt via getLlmConcurrencyState for observability, resetting it to null on resetLlmConcurrency', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
      resetLlmConcurrency()
      expect(getLlmConcurrencyState().lastRateLimitAt).toBeNull()

      setLlmConcurrencyLimit(4)
      reportLlmRateLimitEncountered()
      expect(getLlmConcurrencyState().lastRateLimitAt).toBe(Date.now())

      resetLlmConcurrency()
      expect(getLlmConcurrencyState().lastRateLimitAt).toBeNull()
    })
  })
})
