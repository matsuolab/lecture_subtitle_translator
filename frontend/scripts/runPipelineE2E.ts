/**
 * WhisperX 生JSON + プロジェクトJSON (session.adminSettings) を入力に、
 * `runLocalPostPipeline()` (後段パイプライン全体) をヘッドレスで実行し、
 * `scripts/timing_probe/compare_timings.py` が読めるプロジェクトJSON形式で
 * 結果を書き出す診断スクリプト。
 *
 * 使い方 (frontend/ ディレクトリから):
 *   TSX_TSCONFIG_PATH="$(pwd)/tsconfig.app.json" \
 *     node --import tsx --import ./scripts/importMetaEnvShim.mjs \
 *     scripts/runPipelineE2E.ts <whisperx_raw.json> <project.json> <出力ディレクトリ>
 *
 * 注意:
 * - パイプライン依存モジュールの一部が `@/...` エイリアスで実行時importを行うため
 *   (例: '@/lib/aiGateway', '@/lib/concurrency')、tsx にエイリアス解決用の tsconfig を
 *   教える必要がある。`npx tsx --tsconfig <path>` の代わりに環境変数
 *   `TSX_TSCONFIG_PATH` でも同じ効果があり、`node --import tsx` 経由の起動と併用できる。
 * - `frontend/src/api/adminSettings.ts` はモジュール先頭で Vite 専用の
 *   `import.meta.env` を参照するため、tsx (Node) 単体で import すると
 *   `TypeError: Cannot read properties of undefined` で落ちる。
 *   `frontend/src/` は変更禁止のため、`./scripts/importMetaEnvShim.mjs` を
 *   `--import` で併用し、ロード後のソースを後処理して吸収する
 *   （`node --import tsx --import ./scripts/importMetaEnvShim.mjs` の順で指定すること）。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { runLocalPostPipeline, type LocalPipelineResult } from '../src/lib/pipeline/localPipeline'
import { normalizeAdminSettings } from '../src/api/adminSettings'
import type { AdminSettings } from '../src/types/adminSettings'
import type { TranscriptSegment, WordTimestamp } from '../src/lib/pipeline/types'
import type { SubtitleBlock } from '../src/types/subtitle'

interface WhisperXRawWord {
  word: string
  start?: number
  end?: number
  score?: number
}

interface WhisperXRawSegment {
  start: number
  end: number
  text: string
  words?: WhisperXRawWord[]
}

interface WhisperXRaw {
  segments: WhisperXRawSegment[]
}

interface CompareTimingsBlock {
  id: number
  startTime: number
  endTime: number
  subtitle: string
  transcript: string
  charCount: number
  cps: number
}

interface CompareTimingsProject {
  version: number
  savedAt: string
  blocks: CompareTimingsBlock[]
}

function readJsonUnknown(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf-8')) as unknown
}

function isFiniteWord(word: WhisperXRawWord): word is WhisperXRawWord & { start: number; end: number } {
  return typeof word.start === 'number' && Number.isFinite(word.start)
    && typeof word.end === 'number' && Number.isFinite(word.end)
}

function toWordTimestamp(word: WhisperXRawWord & { start: number; end: number }): WordTimestamp {
  return { word: word.word, start: word.start, end: word.end, score: word.score }
}

function parseWhisperXRaw(value: unknown): WhisperXRaw {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { segments?: unknown }).segments)) {
    throw new Error('whisperx_raw.json: "segments" 配列が見つかりません')
  }
  return value as WhisperXRaw
}

function toTranscriptSegments(raw: WhisperXRaw): TranscriptSegment[] {
  return raw.segments.map((segment, index) => ({
    id: index + 1,
    start: segment.start,
    end: segment.end,
    text: segment.text,
    words: (segment.words ?? []).filter(isFiniteWord).map(toWordTimestamp),
  }))
}

/**
 * project.json から実行時の設定を取り出す。
 *
 * `session.adminSettings` は「エクスポート時点の現在値」であり、実行後にユーザーが
 * 変更している可能性がある（実際、compress/expand/contextMerge が実行時は空だったのに
 * 現在値では gpt-5.4-mini に変わっていた）。実行を再現したいので
 * `session.workLog.header.settingsSnapshot`（実行開始時のスナップショット）を優先し、
 * 欠けているフィールドだけ adminSettings で補う。
 */
function extractSessionAdminSettingsRaw(projectJson: unknown): unknown {
  if (!projectJson || typeof projectJson !== 'object') return undefined
  const session = (projectJson as Record<string, unknown>).session
  if (!session || typeof session !== 'object') return undefined
  const current = (session as Record<string, unknown>).adminSettings
  const workLog = (session as Record<string, unknown>).workLog
  const header = workLog && typeof workLog === 'object'
    ? (workLog as Record<string, unknown>).header
    : undefined
  const snapshot = header && typeof header === 'object'
    ? (header as Record<string, unknown>).settingsSnapshot
    : undefined
  if (!snapshot || typeof snapshot !== 'object') return current
  const base = current && typeof current === 'object' ? current as Record<string, unknown> : {}
  return { ...base, ...(snapshot as Record<string, unknown>) }
}

/** OpenAI/Gemini 専用のモデルIDらしき文字列か（local_openai には投げられない）。 */
function isNonLocalModelId(model: string): boolean {
  const normalized = model.trim().toLowerCase()
  if (!normalized) return false
  return normalized.startsWith('gpt-') || normalized.startsWith('gemini-') || normalized.startsWith('ft:')
}

/**
 * local_openai では resolveChatModelForProvider がモデルIDをそのまま返すため、
 * `gpt-5.4-nano` のような他プロバイダ用IDが混ざっていると LM Studio 側で解決できず失敗する。
 * 空欄・他プロバイダ用IDは、実際にローカルで動く translationModel に寄せる。
 */
function localizeModelFields(settings: AdminSettings): AdminSettings {
  const localModel = settings.translationModel.trim()
  if (!localModel) return settings
  const patched: Record<string, unknown> = { ...settings }
  for (const [key, value] of Object.entries(settings)) {
    if (!key.toLowerCase().endsWith('model')) continue
    if (typeof value !== 'string') continue
    if (value.trim() && !isNonLocalModelId(value)) continue
    patched[key] = localModel
  }
  return patched as AdminSettings
}

/**
 * 環境変数 `OPENAI_API_KEY` が設定されていれば OpenAI 本番プロバイダで実行する。
 *
 * 既定（未設定）はこれまでどおり LM Studio（local_openai）向けで、モデルIDも
 * ローカルで動くものへ寄せる（`localizeModelFields`）。一方、本番の実行結果と
 * 比較したい計測では同じモデルで走らせる必要があるため、その場合だけ OpenAI に切り替える。
 * プロジェクトJSONの `openaiApiKey` はエクスポート時に `[configured]` へ伏せられるので、
 * 鍵は環境変数からのみ受け取る（`src/lib/aiGateway/openaiSmoke.test.ts` と同じ方式）。
 */
function buildSettings(projectJson: unknown): AdminSettings {
  const raw = extractSessionAdminSettingsRaw(projectJson)
  const normalized = normalizeAdminSettings(raw)
  const openaiApiKey = process.env.OPENAI_API_KEY?.trim() ?? ''
  if (openaiApiKey) {
    return {
      ...normalized,
      openaiApiKey,
      openaiCompatibleBaseUrl: process.env.OPENAI_BASE_URL?.trim() ?? '',
      translationProvider: 'openai',
    }
  }
  return localizeModelFields({
    ...normalized,
    openaiCompatibleBaseUrl: 'http://127.0.0.1:1234/v1',
    translationProvider: 'local_openai',
  })
}

function toCompareTimingsBlock(block: SubtitleBlock): CompareTimingsBlock {
  return {
    id: block.id,
    startTime: block.startTime,
    endTime: block.endTime,
    subtitle: block.subtitle,
    transcript: block.transcript,
    charCount: block.charCount,
    cps: block.cps,
  }
}

function parseArgs(argv: readonly string[]): { whisperxPath: string; projectPath: string; outDir: string } {
  const [whisperxPath, projectPath, outDir] = argv
  if (!whisperxPath || !projectPath || !outDir) {
    throw new Error('Usage: runPipelineE2E.ts <whisperx_raw.json> <project.json> <out_dir>')
  }
  return {
    whisperxPath: resolve(whisperxPath),
    projectPath: resolve(projectPath),
    outDir: resolve(outDir),
  }
}

function fmtSec(ms: number): string {
  return (ms / 1000).toFixed(1)
}

async function main(): Promise<void> {
  const { whisperxPath, projectPath, outDir } = parseArgs(process.argv.slice(2))
  mkdirSync(outDir, { recursive: true })

  console.log(`[runPipelineE2E] whisperx: ${whisperxPath}`)
  console.log(`[runPipelineE2E] project:  ${projectPath}`)
  console.log(`[runPipelineE2E] outDir:   ${outDir}`)

  const whisperxRaw = parseWhisperXRaw(readJsonUnknown(whisperxPath))
  const transcriptSegments = toTranscriptSegments(whisperxRaw)
  const totalWords = transcriptSegments.reduce((sum, seg) => sum + (seg.words?.length ?? 0), 0)
  console.log(`[runPipelineE2E] segments: ${transcriptSegments.length}, words: ${totalWords}`)

  const projectJson = readJsonUnknown(projectPath)
  const settings = buildSettings(projectJson)
  console.log(
    `[runPipelineE2E] settings: translationProvider=${settings.translationProvider} `
    + `openaiCompatibleBaseUrl=${settings.openaiCompatibleBaseUrl} `
    + `apiRequestConcurrency=${settings.apiRequestConcurrency}`,
  )
  console.log(
    `[runPipelineE2E] models: translationModel=${settings.translationModel} `
    + `correctionModel=${settings.correctionModel} compressModel=${settings.compressModel} `
    + `expandModel=${settings.expandModel} contextMergeModel=${settings.contextMergeModel} `
    + `splitJaModel=${settings.splitJaModel} microModel=${settings.microModel} `
    + `coverageRepairModel=${settings.coverageRepairModel} generalRepairModel=${settings.generalRepairModel} `
    + `incompleteEndDetectionModel=${settings.incompleteEndDetectionModel}`,
  )

  const runStartedAt = Date.now()
  let lastStepName: string | undefined
  let lastStepStartedAt = runStartedAt

  const onStep = (step: string): void => {
    const now = Date.now()
    if (lastStepName !== undefined) {
      console.log(`[runPipelineE2E] step done: ${lastStepName} (${fmtSec(now - lastStepStartedAt)}s)`)
    }
    console.log(`[runPipelineE2E] step start: ${step} (+${fmtSec(now - runStartedAt)}s total)`)
    lastStepName = step
    lastStepStartedAt = now
  }

  let result: LocalPipelineResult | undefined
  let runError: unknown

  try {
    result = await runLocalPostPipeline(transcriptSegments, settings, onStep)
  } catch (error) {
    runError = error
  }

  const now = Date.now()
  if (lastStepName !== undefined) {
    console.log(`[runPipelineE2E] step done: ${lastStepName} (${fmtSec(now - lastStepStartedAt)}s)`)
  }
  console.log(`[runPipelineE2E] total elapsed: ${fmtSec(now - runStartedAt)}s`)

  if (runError) {
    console.error('[runPipelineE2E] runLocalPostPipeline failed:', runError)
    const row = (runError && typeof runError === 'object') ? runError as Record<string, unknown> : {}
    const partial = {
      failed: true,
      errorMessage: runError instanceof Error ? runError.message : String(runError),
      errorStack: runError instanceof Error ? runError.stack : undefined,
      traces: row.localPipelineTraces ?? [],
      stageSnapshots: row.localPipelineStageSnapshots ?? [],
    }
    writeFileSync(resolve(outDir, 'e2e_result_raw.json'), JSON.stringify(partial, null, 2), 'utf-8')
    console.error(`[runPipelineE2E] partial diagnostics written to ${resolve(outDir, 'e2e_result_raw.json')}`)
    process.exitCode = 1
    return
  }

  if (!result) {
    throw new Error('unreachable: result is undefined without runError')
  }

  writeFileSync(resolve(outDir, 'e2e_result_raw.json'), JSON.stringify(result, null, 2), 'utf-8')

  const compareProject: CompareTimingsProject = {
    version: 2,
    savedAt: new Date().toISOString(),
    blocks: result.blocks.map(toCompareTimingsBlock),
  }
  writeFileSync(resolve(outDir, 'e2e_project.json'), JSON.stringify(compareProject, null, 2), 'utf-8')

  console.log(`[runPipelineE2E] blocks: ${result.blocks.length}`)
  console.log(
    `[runPipelineE2E] audit: mustReview=${result.audit.mustReviewCount} `
    + `shouldReview=${result.audit.shouldReviewCount} autoPass=${result.audit.autoPassCount}`,
  )
  console.log('[runPipelineE2E] node traces:')
  for (const trace of result.traces) {
    console.log(
      `  - ${trace.nodeId}: ${trace.status} (${fmtSec(trace.durationMs)}s)`
      + `${trace.summary ? ` — ${trace.summary}` : ''}`,
    )
  }
  console.log(`[runPipelineE2E] wrote ${resolve(outDir, 'e2e_project.json')}`)
  console.log(`[runPipelineE2E] wrote ${resolve(outDir, 'e2e_result_raw.json')}`)
}

main().catch((error) => {
  console.error('[runPipelineE2E] fatal error:', error)
  process.exitCode = 1
})
