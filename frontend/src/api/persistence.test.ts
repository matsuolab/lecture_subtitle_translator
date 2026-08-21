import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PipelineRunResult } from '@/types/pipeline'
import {
  loadSessionSnapshotFromLocalStorage,
  reconcileRestoredPipelineRun,
  saveSessionSnapshotToLocalStorage,
  saveToLocalStorage,
} from './persistence'

function installFakeLocalStorage(initial: Record<string, string> = {}): Map<string, string> {
  const store = new Map(Object.entries(initial))
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value) },
    removeItem: (key: string) => { store.delete(key) },
    clear: () => { store.clear() },
    key: () => null,
    length: 0,
  })
  return store
}

const STORAGE_KEY = 'matsuo-subtitle-editor-v1'

describe('reconcileRestoredPipelineRun', () => {
  it('running を cancelled に落とす（新しい画面プロセスでは実行継続がありえないため）', () => {
    const run: PipelineRunResult = {
      status: 'running',
      step: 'translate',
      message: '翻訳中',
      sourceName: 'PhyAI05_1920x1080.mp4',
    }
    const result = reconcileRestoredPipelineRun(run)
    expect(result?.status).toBe('cancelled')
    expect(result?.step).toBe('done')
    expect(result?.message).toContain('中断')
    // 元のフィールドは保持する
    expect(result?.sourceName).toBe('PhyAI05_1920x1080.mp4')
  })

  it('queued も cancelled に落とす', () => {
    const result = reconcileRestoredPipelineRun({ status: 'queued', step: 'idle', message: '待機中' })
    expect(result?.status).toBe('cancelled')
  })

  it('引数を書き換えない（immutable）', () => {
    const run: PipelineRunResult = { status: 'running', step: 'translate', message: '翻訳中' }
    reconcileRestoredPipelineRun(run)
    expect(run.status).toBe('running')
    expect(run.step).toBe('translate')
    expect(run.message).toBe('翻訳中')
  })

  it('終端状態はそのまま返す', () => {
    for (const status of ['success', 'warning', 'error', 'idle', 'cancelled'] as const) {
      const run: PipelineRunResult = { status, step: 'done', message: 'x' }
      expect(reconcileRestoredPipelineRun(run)).toBe(run)
    }
  })

  it('undefined はそのまま返す', () => {
    expect(reconcileRestoredPipelineRun(undefined)).toBeUndefined()
  })
})

describe('loadSessionSnapshotFromLocalStorage', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('実行中のまま保存されたスナップショットを cancelled として復元する', () => {
    // ユーザーが「何も実行していないのに実行中と表示され復帰できない」状態に陥った事故の再現。
    installFakeLocalStorage({
      [STORAGE_KEY]: JSON.stringify({
        savedAt: new Date().toISOString(),
        blocks: [],
        session: {
          pipelineRun: { status: 'running', step: 'translate', message: '翻訳中', runId: 'local-transcript' },
        },
      }),
    })

    const restored = loadSessionSnapshotFromLocalStorage()
    expect(restored?.session?.pipelineRun?.status).toBe('cancelled')
  })

  it('履歴 (pipelineHistory) は過去の記録なので変換しない', () => {
    installFakeLocalStorage({
      [STORAGE_KEY]: JSON.stringify({
        savedAt: new Date().toISOString(),
        blocks: [],
        session: {
          pipelineRun: { status: 'success', step: 'done', message: 'ok' },
          pipelineHistory: [{ status: 'running', step: 'translate', message: '古い記録' }],
        },
      }),
    })

    const restored = loadSessionSnapshotFromLocalStorage()
    expect(restored?.session?.pipelineHistory?.[0]?.status).toBe('running')
  })

  it('success はそのまま復元する', () => {
    installFakeLocalStorage({
      [STORAGE_KEY]: JSON.stringify({
        savedAt: new Date().toISOString(),
        blocks: [],
        session: { pipelineRun: { status: 'success', step: 'done', message: 'ok' } },
      }),
    })

    expect(loadSessionSnapshotFromLocalStorage()?.session?.pipelineRun?.status).toBe('success')
  })

  it('session が無いスナップショットでも壊れない', () => {
    installFakeLocalStorage({
      [STORAGE_KEY]: JSON.stringify({ savedAt: new Date().toISOString(), blocks: [] }),
    })

    const restored = loadSessionSnapshotFromLocalStorage()
    expect(restored).not.toBeNull()
    expect(restored?.session).toBeUndefined()
  })

  it('blocks-only autosaveでも直前のvideo/settings/run/historyを上書き消さない', () => {
    const initialBlocks = [{
      id: 1, startTime: 0, endTime: 1, subtitle: 'before', transcript: '前',
      cps: 6, charCount: 6, status: 'pending' as const, glossaryTerms: [],
    }]
    installFakeLocalStorage()
    expect(saveSessionSnapshotToLocalStorage({
      version: 2,
      savedAt: '2026-08-12T00:00:00.000Z',
      blocks: initialBlocks,
      session: {
        videoSource: { name: 'lecture.mp4' },
        adminSettings: { translationModel: 'gpt-5' },
        pipelineRun: { status: 'success', step: 'done', message: 'ok', runId: 'run-1' },
        pipelineHistory: [{ status: 'error', step: 'done', message: 'old', runId: 'run-0' }],
        activeWorkLogSessionId: 'work-1',
      },
    })).toMatchObject({ ok: true, revision: 1 })

    expect(saveToLocalStorage([{ ...initialBlocks[0], subtitle: 'after' }]))
      .toMatchObject({ ok: true, revision: 2 })
    const restored = loadSessionSnapshotFromLocalStorage()
    expect(restored?.blocks[0].subtitle).toBe('after')
    expect(restored?.session?.videoSource?.name).toBe('lecture.mp4')
    expect(restored?.session?.adminSettings?.translationModel).toBe('gpt-5')
    expect(restored?.session?.pipelineRun?.runId).toBe('run-1')
    expect(restored?.session?.pipelineHistory?.[0]?.runId).toBe('run-0')
    expect(restored?.session?.activeWorkLogSessionId).toBe('work-1')
  })
})
