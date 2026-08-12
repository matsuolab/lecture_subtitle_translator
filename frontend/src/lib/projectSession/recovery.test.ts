import { describe, expect, it } from 'vitest'
import type { AdminSettings } from '@/types/adminSettings'
import type { PipelineRunResult } from '@/types/pipeline'
import type { SubtitleBlock } from '@/types/subtitle'
import {
  LocalStorageRecoveryStore,
  createRecoverySnapshotInput,
  mergeImportedAdminSettings,
  type RecoveryStorage,
} from './recovery'

const blocks: SubtitleBlock[] = [{
  id: 1,
  startTime: 0,
  endTime: 1,
  subtitle: 'A',
  transcript: 'あ',
  cps: 1,
  charCount: 1,
  status: 'pending',
  glossaryTerms: [],
}]

class MemoryStorage implements RecoveryStorage {
  values = new Map<string, string>()
  failNextWrite = false

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    if (this.failNextWrite) {
      this.failNextWrite = false
      throw new DOMException('quota', 'QuotaExceededError')
    }
    this.values.set(key, value)
  }
}

describe('RecoveryStore', () => {
  it('完全runから軽量snapshotだけを保存しrevisionを進める', () => {
    const storage = new MemoryStorage()
    const store = new LocalStorageRecoveryStore(storage)
    const run: PipelineRunResult = {
      runId: 'run-1', status: 'success', step: 'done', message: 'ok',
      debug: {
        progressEvents: [],
        stageSnapshots: [{ stage: 'large', at: 1, itemCount: 1, items: [{ huge: 'x'.repeat(1000) }] }],
      },
    }
    const input = createRecoverySnapshotInput({
      savedAt: '2026-08-12T00:00:00.000Z',
      blocks,
      videoSource: { name: 'lecture.mp4' },
      adminSettings: {
        translationModel: 'gpt-5',
        openaiApiKey: '[configured]',
        serviceAuthToken: 'secret',
        workLogDir: 'D:/private/worklogs',
      },
      pipelineRun: run,
      pipelineHistory: [run],
      activeWorkLogSessionId: 'work-1',
    })

    expect(store.save(input)).toEqual({ ok: true, revision: 1 })
    expect(store.save({ ...input, blocks: [{ ...blocks[0], subtitle: 'B' }] })).toEqual({ ok: true, revision: 2 })

    const loaded = store.load()
    expect(loaded.status).toBe('ok')
    if (loaded.status !== 'ok') return
    expect(loaded.snapshot.revision).toBe(2)
    expect(loaded.snapshot.blocks[0].subtitle).toBe('B')
    expect(loaded.snapshot.session?.pipelineRun).not.toHaveProperty('debug')
    expect(loaded.snapshot.session?.adminSettings).toMatchObject({ translationModel: 'gpt-5' })
    expect(loaded.snapshot.session?.adminSettings).not.toHaveProperty('openaiApiKey')
    expect(loaded.snapshot.session?.adminSettings).not.toHaveProperty('serviceAuthToken')
    expect(loaded.snapshot.session?.adminSettings).not.toHaveProperty('workLogDir')
    expect(loaded.snapshot.session?.activeWorkLogSessionId).toBe('work-1')
  })

  it('Quota失敗はSaveResultで返し、直前のsnapshotとrevisionを壊さない', () => {
    const storage = new MemoryStorage()
    const store = new LocalStorageRecoveryStore(storage)
    const input = createRecoverySnapshotInput({ savedAt: '2026-08-12T00:00:00.000Z', blocks })
    expect(store.save(input)).toEqual({ ok: true, revision: 1 })
    const before = storage.getItem(store.key)

    storage.failNextWrite = true
    expect(store.save({ ...input, blocks: [{ ...blocks[0], subtitle: 'lost' }] })).toMatchObject({
      ok: false,
      revision: 1,
      error: { name: 'QuotaExceededError' },
    })
    expect(storage.getItem(store.key)).toBe(before)
    expect(store.load()).toMatchObject({ status: 'ok', snapshot: { revision: 1 } })
  })

  it('新しいアプリが作ったfuture recoveryをdowngrade起動で上書きしない', () => {
    const storage = new MemoryStorage()
    const store = new LocalStorageRecoveryStore(storage)
    storage.values.set(store.key, JSON.stringify({
      schema: 'matsuo.subtitle-recovery', version: 4, revision: 9, savedAt: 'future', blocks: [],
    }))
    const before = storage.getItem(store.key)

    expect(store.save({ savedAt: '2026-08-12T00:00:00.000Z', blocks })).toMatchObject({
      ok: false,
      error: { name: 'UnsupportedRecoveryVersion' },
    })
    expect(storage.getItem(store.key)).toBe(before)
  })
})

describe('mergeImportedAdminSettings', () => {
  it('インポートで端末の秘密値とWorkLog保管場所を上書きしない', () => {
    const current = {
      translationModel: 'local-model',
      openaiApiKey: 'local-secret',
      geminiApiKey: 'local-gemini',
      workLogDir: 'D:/local/logs',
    } as AdminSettings
    const imported: Partial<AdminSettings> = {
      translationModel: 'project-model',
      openaiApiKey: '[configured]',
      geminiApiKey: '',
      workLogDir: 'C:/other/logs',
    }

    expect(mergeImportedAdminSettings(current, imported)).toMatchObject({
      translationModel: 'project-model',
      openaiApiKey: 'local-secret',
      geminiApiKey: 'local-gemini',
      workLogDir: 'D:/local/logs',
    })
  })
})
