import { describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { getDefaultAdminSettings } from '@/api/adminSettings'
import { buildLocalPipelineProgress, runPipelineViaApi, testServiceConnection } from './pipelineClient'

// isTauri()===true にすることで runLocalTranscriptPipeline（ローカルWhisperX経路）を通す。
vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => true,
  invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === 'extract_audio') return '/tmp/fake-audio.wav'
    if (cmd === 'transcribe_local') {
      return { segments: [{ start: 0, end: 1, text: 'hello', words: [] }] }
    }
    if (cmd === 'check_local_whisperx') {
      return `OK: language=${String(args?.language)}`
    }
    throw new Error(`unexpected invoke: ${cmd}`)
  }),
}))

// runLocalPostPipeline（実際の校正・翻訳・字幕化を行う重いパイプライン本体）は本テストの対象外
// （llmUsage sink の配線を確認したいだけで、実際の LLM 呼出チェーンを再現する必要はない）。
// 実際の gateway 呼出ヘルパー（chatText 等）が getCurrentLlmUsageSink() へ push するのと同じ経路を
// 模倣し、runPipelineViaApi がその push を最終的な debug.llmUsage まで回収することだけを検証する。
vi.mock('@/lib/pipeline/localPipeline', async () => {
  const actual = await vi.importActual<typeof import('@/lib/pipeline/localPipeline')>('@/lib/pipeline/localPipeline')
  return {
    ...actual,
    runLocalPostPipeline: vi.fn(async () => {
      const { getCurrentLlmUsageSink } = await import('@/lib/pipeline/llmUsageSink')
      getCurrentLlmUsageSink()?.push({
        nodeId: 'fake-node',
        model: 'fake-model',
        promptTokens: 10,
        completionTokens: 5,
      })
      return {
        blocks: [],
        traces: [],
        audit: { mustReviewCount: 0, shouldReviewCount: 0, autoPassCount: 0, reviewItems: [], nodeTraces: [] },
        stageSnapshots: [],
      }
    }),
  }
})

describe('runPipelineViaApi llmUsage sink wiring (regression: PipelineRunDebug.llmUsage was always empty because no code path ever called setCurrentLlmUsageSink)', () => {
  it('collects usage records pushed via getCurrentLlmUsageSink() during a pipeline run into result.debug.llmUsage', async () => {
    const settings = {
      ...getDefaultAdminSettings(),
      serviceMode: 'legacy_pipeline' as const,
      translationProvider: 'openai' as const,
      openaiApiKey: 'sk-test',
    }

    const result = await runPipelineViaApi('source.mp4', settings, { path: '/tmp/source.mp4' })

    expect(result.debug?.llmUsage).toEqual([
      expect.objectContaining({ nodeId: 'fake-node', model: 'fake-model', promptTokens: 10, completionTokens: 5 }),
    ])
    // llmErrorLog も同じ debug オブジェクトに載る（今回は失敗が無いので空配列）。
    expect(result.debug?.llmErrors).toEqual([])
  })
})

describe('local WhisperX language selection', () => {
  it('passes settings.transcribeLanguageCode to the transcribe_local invoke call', async () => {
    const mockedInvoke = vi.mocked(invoke)
    mockedInvoke.mockClear()

    const settings = {
      ...getDefaultAdminSettings(),
      serviceMode: 'legacy_pipeline' as const,
      translationProvider: 'openai' as const,
      openaiApiKey: 'sk-test',
      transcribeLanguageCode: 'en',
    }

    await runPipelineViaApi('source.mp4', settings, { path: '/tmp/source.mp4' })

    const transcribeCall = mockedInvoke.mock.calls.find(([cmd]) => cmd === 'transcribe_local')
    expect(transcribeCall?.[1]).toEqual(expect.objectContaining({ language: 'en' }))
  })

  it('passes settings.transcribeLanguageCode to the check_local_whisperx invoke call', async () => {
    const settings = {
      ...getDefaultAdminSettings(),
      serviceMode: 'legacy_pipeline' as const,
      transcribeLanguageCode: 'fr',
    }

    const result = await testServiceConnection(settings)

    expect(result.ok).toBe(true)
    expect(result.message).toBe('OK: language=fr')
  })
})

describe('buildLocalPipelineProgress', () => {
  it('maps a detail-less onStep call (node just started) to nodeElapsedSec: null', () => {
    const progress = buildLocalPipelineProgress(
      { runId: 'run-1', completedNodes: [], totalNodes: 10 },
      'translateEn',
      undefined,
    )

    expect(progress).toEqual({
      runId: 'run-1',
      completedNodes: [],
      totalNodes: 10,
      status: 'running',
      currentNode: 'translateEn',
      nodeElapsedSec: null,
      inFlightLlmCalls: undefined,
      secondsSinceLastLlmResponse: undefined,
    })
  })

  it('reflects heartbeat detail into nodeElapsedSec and LLM activity fields', () => {
    const progress = buildLocalPipelineProgress(
      { runId: 'run-1', completedNodes: ['transcribe'], totalNodes: 10 },
      'translateEn',
      { elapsedSec: 192, inFlightLlmCalls: 7, secondsSinceLastLlmResponse: 480 },
    )

    expect(progress.nodeElapsedSec).toBe(192)
    expect(progress.inFlightLlmCalls).toBe(7)
    expect(progress.secondsSinceLastLlmResponse).toBe(480)
    expect(progress.currentNode).toBe('translateEn')
    expect(progress.status).toBe('running')
  })

  it('reflects secondsSinceLastLlmResponse: null (no LLM response received yet) distinctly from undefined', () => {
    const progress = buildLocalPipelineProgress(
      { runId: 'run-1', completedNodes: [], totalNodes: 10 },
      'contextGroupCueBlocks',
      { elapsedSec: 30, inFlightLlmCalls: 3, secondsSinceLastLlmResponse: null },
    )

    expect(progress.secondsSinceLastLlmResponse).toBeNull()
    expect(progress.inFlightLlmCalls).toBe(3)
  })
})
