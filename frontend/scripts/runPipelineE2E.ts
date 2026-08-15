/**
 * WhisperX 生JSON または プロジェクトJSON埋め込みの書き起こし + プロジェクトJSON
 * (session.adminSettings) を入力に、`runLocalPostPipeline()` (後段パイプライン全体) を
 * ヘッドレスで実行し、`scripts/timing_probe/compare_timings.py` が読めるプロジェクトJSON形式、
 * および アプリで開けるプロジェクトJSON形式（`SessionExportData`）で結果を書き出す診断スクリプト。
 *
 * 使い方 (frontend/ ディレクトリから):
 *
 *   1) WhisperX 生JSONを別途渡す場合（3引数）:
 *   TSX_TSCONFIG_PATH="$(pwd)/tsconfig.app.json" \
 *     node --import tsx --import ./scripts/importMetaEnvShim.mjs \
 *     scripts/runPipelineE2E.ts <whisperx_raw.json> <project.json> <出力ディレクトリ>
 *
 *   2) プロジェクトJSONに埋め込まれた書き起こし
 *      (session.pipelineRun.debug.transcriptSegments) を使う場合（2引数）:
 *   TSX_TSCONFIG_PATH="$(pwd)/tsconfig.app.json" \
 *     node --import tsx --import ./scripts/importMetaEnvShim.mjs \
 *     scripts/runPipelineE2E.ts <project.json> <出力ディレクトリ>
 *
 *   引数が2個か3個かで自動判定する。保存済みプロジェクトJSONには語単位タイムスタンプ込みの
 *   書き起こしがそのまま残っているため、WhisperX 生JSONを別途用意できない場合でも
 *   このスクリプトを再実行できる。
 *
 *   OpenAI 本番プロバイダで実行したい場合は `OPENAI_API_KEY`（または `OPENAI_API_KEY_FILE` で
 *   鍵ファイルのパス）を渡す。詳細は `./resolveApiKey.ts` を参照。未指定時は従来どおり
 *   LM Studio（local_openai）にフォールバックする。
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
import { resolveApiKey } from './resolveApiKey'
import type { AdminSettings } from '../src/types/adminSettings'
import type { TranscriptSegment, WordTimestamp } from '../src/lib/pipeline/types'
import type { SubtitleBlock } from '../src/types/subtitle'
import type { SessionExportData } from '../src/api/persistence'
import type { PipelineRunDebug, PipelineRunResult } from '../src/types/pipeline'

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

interface EmbeddedTranscriptSegment {
  id?: number
  start: number
  end: number
  text: string
  words?: WhisperXRawWord[]
}

/**
 * 保存済みプロジェクトJSONの `session.pipelineRun.debug.transcriptSegments` を取り出す。
 *
 * このフィールドは実行時に既に `TranscriptSegment[]` として書き出されているため、
 * WhisperX 生JSONを別途用意できなくても、保存済みプロジェクトJSONだけで
 * パイプラインを再実行できる（語単位タイムスタンプ込みでそのまま残っている）。
 * 存在しない・空の場合はここでエラーにする（後段が空データで無言のまま進むのを防ぐ）。
 */
function extractEmbeddedTranscriptSegmentsRaw(projectJson: unknown): unknown {
  if (!projectJson || typeof projectJson !== 'object') return undefined
  const session = (projectJson as Record<string, unknown>).session
  if (!session || typeof session !== 'object') return undefined
  const pipelineRun = (session as Record<string, unknown>).pipelineRun
  if (!pipelineRun || typeof pipelineRun !== 'object') return undefined
  const debug = (pipelineRun as Record<string, unknown>).debug
  if (!debug || typeof debug !== 'object') return undefined
  return (debug as Record<string, unknown>).transcriptSegments
}

function loadEmbeddedTranscriptSegments(projectJson: unknown): TranscriptSegment[] {
  const raw = extractEmbeddedTranscriptSegmentsRaw(projectJson)
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(
      'project.json に session.pipelineRun.debug.transcriptSegments が見つからないか空です。'
      + ' WhisperX 生JSONを別途指定するか（3引数形式: <whisperx_raw.json> <project.json> <out_dir>）、'
      + ' 書き起こしを含む保存済みプロジェクトJSONを指定してください。',
    )
  }
  return (raw as EmbeddedTranscriptSegment[]).map((segment, index) => ({
    id: typeof segment.id === 'number' ? segment.id : index + 1,
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
 * `OPENAI_API_KEY`（または `OPENAI_API_KEY_FILE` が指す鍵ファイル）が設定されていれば
 * OpenAI 本番プロバイダで実行する（`resolveApiKey` は scripts/measureSeamOnlySplit.ts と共有）。
 *
 * 既定（未設定）はこれまでどおり LM Studio（local_openai）向けで、モデルIDも
 * ローカルで動くものへ寄せる（`localizeModelFields`）。一方、本番の実行結果と
 * 比較したい計測では同じモデルで走らせる必要があるため、その場合だけ OpenAI に切り替える。
 * プロジェクトJSONの `openaiApiKey` はエクスポート時に `[configured]` へ伏せられるので、
 * 鍵は環境変数またはファイル経由でのみ受け取る（`src/lib/aiGateway/openaiSmoke.test.ts` と同じ方式）。
 */
function buildSettings(projectJson: unknown): AdminSettings {
  const raw = extractSessionAdminSettingsRaw(projectJson)
  const normalized = normalizeAdminSettings(raw)
  const openaiApiKey = resolveApiKey()
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

/**
 * 引数の個数で入力形式を判定する:
 *   - 3個: <whisperx_raw.json> <project.json> <out_dir> （従来どおり）
 *   - 2個: <project.json> <out_dir> （書き起こしはプロジェクトJSON埋め込みから取る）
 */
function parseArgs(argv: readonly string[]): { whisperxPath?: string; projectPath: string; outDir: string } {
  if (argv.length === 3) {
    const [whisperxPath, projectPath, outDir] = argv
    return {
      whisperxPath: resolve(whisperxPath),
      projectPath: resolve(projectPath),
      outDir: resolve(outDir),
    }
  }
  if (argv.length === 2) {
    const [projectPath, outDir] = argv
    return {
      projectPath: resolve(projectPath),
      outDir: resolve(outDir),
    }
  }
  throw new Error(
    'Usage: runPipelineE2E.ts <whisperx_raw.json> <project.json> <out_dir>'
    + '\n   or: runPipelineE2E.ts <project.json> <out_dir>  (embedded transcriptSegments)',
  )
}

function fmtSec(ms: number): string {
  return (ms / 1000).toFixed(1)
}

/**
 * `session.adminSettings` を書き出し用にマスクする。App.tsx の sanitizeAdminSettings と
 * 同じ流儀（値があれば '[configured]'、無ければ空文字）に合わせる。
 * 鍵をそのまま書き出すと、このJSONファイルを共有した瞬間に漏洩してしまうため、
 * openaiApiKey を含む秘匿フィールドは必ずマスクしてから書き出す。
 */
function maskAdminSettingsForExport(settings: AdminSettings): AdminSettings {
  const masked: AdminSettings = {
    ...settings,
    serviceAuthToken: settings.serviceAuthToken ? '[configured]' : '',
    hfToken: settings.hfToken ? '[configured]' : '',
    openaiApiKey: settings.openaiApiKey ? '[configured]' : '',
    geminiApiKey: settings.geminiApiKey ? '[configured]' : '',
  }
  assertNoSecretsLeaked(masked)
  return masked
}

// マスクは「全部展開してから既知の4フィールドを潰す」方式なので、AdminSettings に
// 新しい鍵が追加されたときに素通りしてしまう。書き出すファイルは共有され得るため、
// 漏洩したら取り返しがつかない。名前と値の両面から機械的に検査して、疑わしければ落とす。
function assertNoSecretsLeaked(settings: AdminSettings): void {
  const suspiciousName = /key|token|secret|password|credential/i
  const allowedNames = new Set(['glossaryMaxOutputTokens', 'alignTokenMode'])
  for (const [name, value] of Object.entries(settings)) {
    if (typeof value !== 'string' || value === '' || value === '[configured]') continue
    if (suspiciousName.test(name) && !allowedNames.has(name)) {
      throw new Error(`マスク漏れの可能性: ${name} が素の文字列のまま書き出されようとしています`)
    }
    if (/^sk-/.test(value)) {
      throw new Error(`マスク漏れ: ${name} の値がAPIキーの形をしています`)
    }
  }
}

/**
 * アプリの「プロジェクトを開く」で読み込める形式（SessionExportData）で結果を組み立てる。
 * `debug.transcriptSegments` に今回入力した書き起こしをそのまま入れておくと、保存済み
 * プロジェクトJSONと同じ構造になり、`scripts/measureSeamOnlySplit.ts` 等の既存診断スクリプトが
 * このJSONもそのまま読める。
 */
function buildSessionExportData(
  result: LocalPipelineResult,
  settings: AdminSettings,
  transcriptSegments: TranscriptSegment[],
  runStartedAt: number,
  runFinishedAt: number,
): SessionExportData {
  const debug: PipelineRunDebug = {
    stageSnapshots: result.stageSnapshots,
    progressEvents: [],
    transcriptSegments,
  }
  const pipelineRun: PipelineRunResult = {
    status: 'success',
    step: 'done',
    message: 'runPipelineE2E.ts によるヘッドレス実行が完了しました',
    startedAt: runStartedAt,
    finishedAt: runFinishedAt,
    audit: result.audit,
    debug,
  }
  return {
    version: 2,
    savedAt: new Date().toISOString(),
    blocks: result.blocks,
    session: {
      adminSettings: maskAdminSettingsForExport(settings),
      pipelineRun,
    },
  }
}

async function main(): Promise<void> {
  const { whisperxPath, projectPath, outDir } = parseArgs(process.argv.slice(2))
  mkdirSync(outDir, { recursive: true })

  console.log(`[runPipelineE2E] project:  ${projectPath}`)
  console.log(`[runPipelineE2E] outDir:   ${outDir}`)

  const projectJson = readJsonUnknown(projectPath)

  let transcriptSegments: TranscriptSegment[]
  if (whisperxPath) {
    console.log(`[runPipelineE2E] whisperx: ${whisperxPath}`)
    const whisperxRaw = parseWhisperXRaw(readJsonUnknown(whisperxPath))
    transcriptSegments = toTranscriptSegments(whisperxRaw)
  } else {
    transcriptSegments = loadEmbeddedTranscriptSegments(projectJson)
    console.log(
      `[runPipelineE2E] whisperx: (none — using session.pipelineRun.debug.transcriptSegments `
      + `embedded in project.json: ${transcriptSegments.length} segments)`,
    )
  }
  const totalWords = transcriptSegments.reduce((sum, seg) => sum + (seg.words?.length ?? 0), 0)
  console.log(`[runPipelineE2E] segments: ${transcriptSegments.length}, words: ${totalWords}`)

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

  const sessionExport = buildSessionExportData(result, settings, transcriptSegments, runStartedAt, now)
  writeFileSync(resolve(outDir, 'e2e_session.json'), JSON.stringify(sessionExport, null, 2), 'utf-8')

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
  console.log(`[runPipelineE2E] wrote ${resolve(outDir, 'e2e_session.json')}`)
}

main().catch((error) => {
  console.error('[runPipelineE2E] fatal error:', error)
  process.exitCode = 1
})
