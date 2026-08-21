import { describe, expect, it } from 'vitest'
import type { PipelineRunResult } from '@/types/pipeline'
import type { SubtitleBlock } from '@/types/subtitle'
import {
  decodeProjectDocument,
  materializeProjectDocument,
  serializeProjectDocument,
} from './codec'

const block: SubtitleBlock = {
  id: 1,
  startTime: 1,
  endTime: 2,
  subtitle: 'Hello',
  transcript: 'こんにちは',
  cps: 5,
  charCount: 5,
  status: 'pending',
  glossaryTerms: [],
  correctionAttempts: [{
    strategy: 'split_block',
    changed: true,
    beforeChars: 12,
    afterChars: 10,
    beforeViolation: 'long_segment',
    afterViolation: 'ok',
    splitTiming: {
      basis: 'asr_constrained',
      matchRates: [0.95, 0.9],
      boundaryDeltasSec: [0.08],
      displayRanges: [{ start: 1, end: 2 }, { start: 2.08, end: 3 }],
    },
  }],
}

const run: PipelineRunResult = {
  runId: 'run-1',
  status: 'success',
  step: 'done',
  message: 'ok',
  debug: {
    progressEvents: [],
    transcriptSegments: [{ id: 7, start: 1, end: 2, text: '元テキスト' }],
    stageSnapshots: [{ stage: 'translateEn', at: 1, itemCount: 1, items: [{ id: 1 }] }],
  },
}

describe('ProjectDocumentV3 codec', () => {
  it('v2の作業データを失わずv3へ移行し、重複runは1度だけ保持する', () => {
    const result = decodeProjectDocument(JSON.stringify({
      version: 2,
      savedAt: '2026-08-03T11:07:59.000Z',
      appVersion: '1.1.1',
      legacyAnalyzerVersion: '2026-08',
      blocks: [block],
      session: {
        videoSource: { name: 'lecture.mp4', path: 'C:/lecture.mp4' },
        adminSettings: { translationModel: 'gpt-5', openaiApiKey: '[configured]' },
        pipelineRun: run,
        pipelineHistory: [run],
        workLog: {
          header: {
            kind: 'header', schemaVersion: 1, sessionId: 'work-1',
            startedAt: '2026-08-03T10:00:00.000Z', video: { name: 'lecture.mp4' },
          },
          events: [],
        },
        workLogs: [{
          header: {
            kind: 'header', schemaVersion: 2, sessionId: 'work-parent',
            startedAt: '2026-08-03T09:00:00.000Z', video: { name: 'lecture.mp4' },
          },
          events: [],
        }],
        activeWorkLogSessionId: 'work-1',
        operatorNote: 'keep-me',
      },
    }))

    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.migratedFrom).toBe(2)
    expect(result.document.schema).toBe('matsuo.subtitle-project')
    expect(result.document.version).toBe(3)
    expect(result.document.runs).toHaveLength(1)
    expect(result.document.session?.currentRunRef).toBe(result.document.session?.historyRunRefs?.[0])

    const hydrated = materializeProjectDocument(result.document)
    expect(hydrated.blocks).toEqual([block])
    expect(hydrated.pipelineRun?.debug?.transcriptSegments).toHaveLength(1)
    expect(hydrated.pipelineHistory).toHaveLength(1)
    expect(hydrated.workLogs?.map(log => log.header.sessionId)).toEqual(['work-parent', 'work-1'])
    expect(hydrated.activeWorkLogSessionId).toBe('work-1')
    expect(hydrated.extensions).toMatchObject({ legacyAnalyzerVersion: '2026-08' })
    expect(hydrated.sessionExtensions).toMatchObject({ operatorNote: 'keep-me' })
  })

  it('v3はcompact JSONだけを書き出し、再読込みで完全セッションが残る', () => {
    const migrated = decodeProjectDocument({
      version: 1,
      savedAt: '2026-08-03T11:07:59.000Z',
      blocks: [{ ...block, subtitle: undefined, transcript: undefined, english: 'Hello', japanese: 'こんにちは' }],
      session: { pipelineRun: run, pipelineHistory: [run] },
    })
    expect(migrated.status).toBe('ok')
    if (migrated.status !== 'ok') return

    const json = serializeProjectDocument(migrated.document)
    expect(json).not.toContain('\n')
    const roundTrip = decodeProjectDocument(json)
    expect(roundTrip.status).toBe('ok')
    if (roundTrip.status !== 'ok') return
    expect(roundTrip.document).toEqual(migrated.document)
    expect(roundTrip.document.blocks[0]).toMatchObject({ subtitle: 'Hello', transcript: 'こんにちは' })
  })

  it('local-transcriptのrunIdが同じでも別の開始時刻なら履歴を潰さない', () => {
    const first = { ...run, runId: 'local-transcript', startedAt: 100 }
    const second = { ...run, runId: 'local-transcript', startedAt: 200 }
    const result = decodeProjectDocument({
      version: 2,
      savedAt: '2026-08-12T00:00:00.000Z',
      blocks: [block],
      session: { pipelineRun: first, pipelineHistory: [first, second] },
    })
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.document.runs).toHaveLength(2)
    expect(result.document.session?.currentRunRef).toBe(result.document.session?.historyRunRefs?.[0])
    expect(result.document.session?.historyRunRefs?.[1]).not.toBe(result.document.session?.currentRunRef)
  })

  it('未来versionと不正JSONを別のstatusで拒否する', () => {
    expect(decodeProjectDocument({
      schema: 'matsuo.subtitle-project', version: 4, savedAt: '', blocks: [], runs: [],
    })).toMatchObject({ status: 'unsupported_newer', foundVersion: 4, supportedVersion: 3 })
    expect(decodeProjectDocument('{')).toMatchObject({ status: 'invalid' })
    expect(decodeProjectDocument({ version: 2, savedAt: '', blocks: 'not-array' })).toMatchObject({ status: 'invalid' })
    expect(decodeProjectDocument({
      schema: 'matsuo.subtitle-project', version: 3, savedAt: '', blocks: [],
      runs: [{ ref: 'same', run }, { ref: 'same', run }],
    })).toMatchObject({ status: 'invalid', error: 'run refs must be unique' })
    expect(decodeProjectDocument({
      schema: 'matsuo.subtitle-project', version: 3, savedAt: '', blocks: [], runs: [],
      session: { workLogs: [{}] },
    })).toMatchObject({ status: 'invalid' })
  })
})
