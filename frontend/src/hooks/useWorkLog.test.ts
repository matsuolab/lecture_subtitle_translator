import { describe, expect, it } from 'vitest'
import { WORK_LOG_SCHEMA_VERSION } from '@/lib/worklog/types'
import { buildWorkLogHeader, createWorkLogWriteQueue } from './useWorkLog'

describe('WorkLog v2 lineage', () => {
  it('インポート元sessionをparentSessionIdとして新しいheaderに残す', () => {
    const header = buildWorkLogHeader({
      origin: 'json_import',
      video: { name: 'lecture.mp4' },
      initialBlocks: [],
      parentSessionId: 'imported-work-1',
    }, 'new-work-2', '2026-08-12T00:00:00.000Z')

    expect(header).toMatchObject({
      kind: 'header',
      schemaVersion: WORK_LOG_SCHEMA_VERSION,
      sessionId: 'new-work-2',
      parentSessionId: 'imported-work-1',
    })
  })
})

describe('WorkLog flush', () => {
  it('キューの全書込み完了を待って成功を返す', async () => {
    const queue = createWorkLogWriteQueue()
    const written: number[] = []
    queue.enqueue(async () => {
      await Promise.resolve()
      written.push(1)
      return { ok: true }
    })
    queue.enqueue(async () => {
      written.push(2)
      return { ok: true }
    })

    await expect(queue.flush()).resolves.toEqual({ ok: true })
    expect(written).toEqual([1, 2])
  })

  it('書込み失敗を握りつぶさずflush resultで返す', async () => {
    const queue = createWorkLogWriteQueue()
    queue.enqueue(async () => ({
      ok: false,
      error: { name: 'QuotaExceededError', message: 'disk full' },
    }))

    await expect(queue.flush()).resolves.toEqual({
      ok: false,
      error: { name: 'QuotaExceededError', message: 'disk full' },
    })
  })
})
