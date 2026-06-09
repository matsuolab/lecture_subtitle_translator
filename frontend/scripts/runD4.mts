/**
 * Run the REAL main pipeline (runLocalPostPipeline) on Day4 transcript using a
 * local OpenAI-compatible model, and dump the full trace for analysis.
 *
 * Usage (from frontend/):
 *   LIMIT=8 MODEL=qwen3.6-27b-mtp npx vite-node scripts/runD4.mts
 *
 * tauriFetch falls back to native fetch outside Tauri, so all LLM calls hit
 * the local server at http://127.0.0.1:1234/v1 directly.
 */
import fs from 'node:fs'
import path from 'node:path'

import { runLocalPostPipeline, getLocalPipelineDebugFailure } from '@/lib/pipeline/localPipeline'
import { getDefaultAdminSettings } from '@/api/adminSettings'
import type { AdminSettings } from '@/types/adminSettings'
import type { TranscriptSegment } from '@/lib/pipeline/types'

const REPO_ROOT = path.resolve(process.cwd(), '..')
const CACHE = path.join(REPO_ROOT, 'poc/cache/DL基礎_day4_講義用_202604_cache.json')
const OUT_DIR = path.join(REPO_ROOT, 'poc/segmentation_rules/out_mainrun')

const LIMIT = process.env.LIMIT ? parseInt(process.env.LIMIT, 10) : 0
const MODEL = process.env.MODEL ?? 'qwen3.6-27b-mtp'
const BASE_URL = process.env.BASE_URL ?? 'http://127.0.0.1:1234/v1'
const REASONING = process.env.REASONING === '1'
const TAG = process.env.TAG ?? String(LIMIT || 'full')
// Experiment levers (override pipeline thresholds without editing pipeline code).
const MERGED_LONG = process.env.MERGED_LONG ? parseFloat(process.env.MERGED_LONG) : undefined
const LONG = process.env.LONG ? parseFloat(process.env.LONG) : undefined

function loadSegments(): TranscriptSegment[] {
  const raw = JSON.parse(fs.readFileSync(CACHE, 'utf-8')) as Array<Record<string, unknown>>
  const all = raw.map((r, i) => ({
    id: typeof r.id === 'number' ? r.id : i,
    start: Number(r.start),
    end: Number(r.end),
    text: String(r.text ?? r.ja ?? ''),
    words: Array.isArray(r.words) ? (r.words as TranscriptSegment['words']) : undefined,
  }))
  return LIMIT > 0 ? all.slice(0, LIMIT) : all
}

function buildSettings(): AdminSettings {
  const base = getDefaultAdminSettings()
  return {
    ...base,
    translationProvider: 'local_openai',
    openaiCompatibleBaseUrl: BASE_URL,
    translationModel: MODEL,
    correctionModel: MODEL,
    incompleteEndDetectionModel: MODEL,
    compressModel: MODEL,
    microModel: MODEL,
    expandModel: MODEL,
    contextMergeModel: MODEL,
    splitJaModel: MODEL,
    coverageRepairModel: MODEL,
    generalRepairModel: MODEL,
    embeddingModel: 'text-embedding-qwen3-embedding-0.6b',
    semanticCheckMode: 'off',
    correctionDebugEmbedding: false,
    debugModeEnabled: true,
    // Reasoning inflates token use; shrink prompts so batched nodes fit the
    // local context window. Few-shot mainly affects wording, not segmentation.
    translationFewShotJson: '[]',
    correctionFewShotJson: '[]',
    apiRequestConcurrency: 1,
    ...(MERGED_LONG !== undefined ? { pipelineMergedLongDurationSec: MERGED_LONG } : {}),
    ...(LONG !== undefined ? { pipelineLongDurationSec: LONG } : {}),
  }
}

/**
 * Gemma 4 enables thinking via a `<|think|>` token at the start of the system
 * prompt, and emits it inline as `<|channel>thought ... <channel|> <answer>`.
 * LM Studio does NOT split this into reasoning_content, so we intercept fetch to
 * (1) enable thinking on every chat call, (2) strip the thought channel from the
 * returned content so the pipeline only sees the final answer, (3) give thinking
 * enough token budget.
 */
const THINK = '<|think|>'
const CHANNEL_CLOSE = '<channel|>'
const reasoningStats = { calls: 0, thought: 0, truncated: 0 }

function stripThought(content: string): string {
  if (!content) return content
  const close = content.lastIndexOf(CHANNEL_CLOSE)
  if (close >= 0) {
    reasoningStats.thought += 1
    return content.slice(close + CHANNEL_CLOSE.length).trim()
  }
  // Opening present but no close => thinking was truncated before the answer.
  if (content.includes('<|channel>thought') || content.includes(THINK)) {
    reasoningStats.truncated += 1
    return ''
  }
  return content
}

function installThinkingFetch(): void {
  const orig = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
    const isChat = url.includes('/chat/completions') && typeof init?.body === 'string'
    if (isChat) {
      reasoningStats.calls += 1
      try {
        const body = JSON.parse(init!.body as string)
        const msgs = Array.isArray(body.messages) ? body.messages : []
        const sys = msgs.find((m: { role: string }) => m.role === 'system')
        if (sys && typeof sys.content === 'string') {
          if (!sys.content.startsWith(THINK)) sys.content = `${THINK}\n${sys.content}`
        } else {
          msgs.unshift({ role: 'system', content: THINK })
        }
        body.messages = msgs
        // Give thinking room ONLY on nodes that set a small output cap. Do NOT add a
        // cap to requests that omit max_tokens (e.g. batched translateEn) — reserving
        // output space there collides with the large prompt and overflows context.
        if (typeof body.max_tokens === 'number' && body.max_tokens < 1024) body.max_tokens = 1024
        init = { ...init, body: JSON.stringify(body) }
      } catch { /* leave request unchanged on parse failure */ }
    }
    const res = await orig(input as never, init)
    if (!isChat) return res
    const text = await res.text()
    try {
      const data = JSON.parse(text)
      for (const choice of data.choices ?? []) {
        if (choice?.message && typeof choice.message.content === 'string') {
          choice.message.content = stripThought(choice.message.content)
        }
      }
      return new Response(JSON.stringify(data), { status: res.status, headers: res.headers })
    } catch {
      return new Response(text, { status: res.status, headers: res.headers })
    }
  }) as typeof globalThis.fetch
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  if (REASONING) installThinkingFetch()
  const segments = loadSegments()
  const settings = buildSettings()
  console.log(`[runD4] segments=${segments.length} model=${MODEL} reasoning=${REASONING} tag=${TAG} `
    + `mergedLong=${settings.pipelineMergedLongDurationSec} long=${settings.pipelineLongDurationSec}`)
  const startedAt = Date.now()
  let stepCount = 0
  try {
    const result = await runLocalPostPipeline(segments, settings, (step) => {
      stepCount += 1
      console.log(`[node ${stepCount}] ${step} (+${((Date.now() - startedAt) / 1000).toFixed(1)}s)`)
    })
    const outPath = path.join(OUT_DIR, `d4_run_${TAG}.json`)
    fs.writeFileSync(
      outPath,
      JSON.stringify(
        { meta: { model: MODEL, segments: segments.length, elapsedSec: (Date.now() - startedAt) / 1000 },
          blocks: result.blocks, traces: result.traces, stageSnapshots: result.stageSnapshots },
        null,
        2,
      ),
      'utf-8',
    )
    console.log(`[runD4] reasoning: ${JSON.stringify(reasoningStats)}`)
    console.log(`[runD4] DONE blocks=${result.blocks.length} elapsed=${((Date.now() - startedAt) / 1000).toFixed(1)}s -> ${outPath}`)
  } catch (error) {
    const debug = getLocalPipelineDebugFailure(error)
    const outPath = path.join(OUT_DIR, `d4_run_${TAG}_FAILED.json`)
    fs.writeFileSync(outPath, JSON.stringify({ error: String(error), ...debug }, null, 2), 'utf-8')
    console.error(`[runD4] FAILED: ${error instanceof Error ? error.message : String(error)} -> ${outPath}`)
    process.exitCode = 1
  }
}

void main()
