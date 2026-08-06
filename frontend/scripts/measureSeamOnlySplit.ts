/**
 * 「尺が長すぎる」ブロック（CPS超過量 = end-start > 10.0秒）を、継ぎ目付近だけの
 * 最小限の書き換えを許して2〜3個の字幕単位に分割できるかを測る診断スクリプト。
 *
 * LLM に分割させたあと、返ってきた各ユニットが原文の該当区間と（継ぎ目の言い切り修正を
 * 除いて）一致するかをコード側で機械的に検査する。LLM が本文を勝手に言い換えていないかを
 * 目視ではなく文字列照合で確認したいので、正規化した原文とユニットを前から順にすり合わせる。
 *
 * 実行すると OpenAI 本番プロバイダへ実際にリクエストするため、課金が発生する。
 * このスクリプト自体は実行しないこと（依頼者が実行する）。
 *
 * 使い方（frontend ディレクトリで実行）:
 *   OPENAI_API_KEY_FILE=/path/to/key TSX_TSCONFIG_PATH="$(pwd)/tsconfig.app.json" node --import tsx \
 *     --import ./scripts/importMetaEnvShim.mjs scripts/measureSeamOnlySplit.ts <project.json> [limit]
 *
 * 鍵は OPENAI_API_KEY で直接渡してもよいが、鍵だけを書いたファイルのパスを
 * OPENAI_API_KEY_FILE で渡す方が、コマンドラインに鍵が残らない分安全。
 */
import { readFileSync } from 'node:fs'

import { normalizeAdminSettings } from '../src/api/adminSettings'
import { requireChatModelForProvider } from '../src/lib/pipeline/aiProvider'
import { llmCallWithMeta } from '../src/lib/pipeline/llmCallWithMeta'
import { parseJsonObjectFromLlmContent } from '../src/lib/pipeline/jsonResponse'
import { mapWithConcurrency } from '../src/lib/concurrency'
import {
  checkSeamOnlySplit,
  type SeamCheckClassification,
  type SeamUnitCheck,
} from '../src/lib/pipeline/seamOnlySplitCheck'
import type { AdminSettings } from '../src/types/adminSettings'

const SYSTEM_PROMPT = `この日本語の講義書き起こしを、2〜3個の字幕単位に分割してください。

厳守事項:
- 各単位は原文の文字列をそのまま使うこと。語順の変更・言い換え・要約・語句の追加は禁止。
- 唯一許される変更は、各単位の末尾を完結した文にするための最小限の修正のみ。
  例: 「〜しておりますので、」→「〜しております。」
      「〜を理解し、」→「〜を理解します。」
- 本文の圧縮やフィラーの削除は禁止。原文の情報を落とさないこと。
- 各単位は文として完結していること（助詞や接続助詞で終わらない）。
- 安全に分割できない場合は {"cannot_split": true, "units": []} を返すこと。

出力はJSONのみ: {"units":[{"text":"..."}]}`

interface SnapshotItem {
  id: number
  start: number
  end: number
  transcriptText?: string
}

// このスクリプト固有の分類。checkSeamOnlySplit が返す分類に、LLM 呼び出し自体が
// 失敗したケース（llm_error）を追加したもの。
type Classification = SeamCheckClassification | 'llm_error'

interface CheckResult {
  classification: Classification
  units: SeamUnitCheck[]
  detail?: string
}

interface MeasuredItem {
  item: SnapshotItem
  units: string[]
  check: CheckResult
  promptTokens: number
  completionTokens: number
  errorMessage?: string
}

/**
 * API キーを取得する。`OPENAI_API_KEY` を直接渡すか、鍵だけを書いたファイルの
 * パスを `OPENAI_API_KEY_FILE` で渡す。後者を用意しているのは、コマンドラインに
 * 鍵を書くとプロセス一覧やシェル履歴に残ってしまうため。
 */
function resolveApiKey(): string {
  const direct = process.env.OPENAI_API_KEY?.trim() ?? ''
  if (direct) return direct
  const keyFile = process.env.OPENAI_API_KEY_FILE?.trim() ?? ''
  if (!keyFile) return ''
  return readFileSync(keyFile, 'utf-8').trim()
}

/** OpenAI 本番プロバイダの設定を作る。runPipelineE2E.ts の buildSettings と同じ方式。 */
function buildSettings(projectJson: unknown): AdminSettings {
  const session = (projectJson as Record<string, unknown>).session as Record<string, unknown> | undefined
  const raw = session?.adminSettings
  const normalized = normalizeAdminSettings(raw)
  const openaiApiKey = resolveApiKey()
  if (!openaiApiKey) {
    throw new Error('APIキーが未設定です。OPENAI_API_KEY か OPENAI_API_KEY_FILE を指定してください')
  }
  return {
    ...normalized,
    openaiApiKey,
    openaiCompatibleBaseUrl: process.env.OPENAI_BASE_URL?.trim() ?? '',
    translationProvider: 'openai',
  }
}

function loadTargets(projectPath: string, limit: number | undefined): SnapshotItem[] {
  const project = JSON.parse(readFileSync(projectPath, 'utf-8')) as Record<string, unknown>
  const session = (project.session ?? {}) as Record<string, unknown>
  const run = (session.pipelineRun ?? {}) as Record<string, unknown>
  const debug = (run.debug ?? {}) as Record<string, unknown>
  const stages = (debug.stageSnapshots ?? []) as Array<{ stage: string; items?: SnapshotItem[] }>
  const stage = stages.find(s => s.stage === 'checkCpsViolations')
  if (!stage?.items) throw new Error('checkCpsViolations スナップショットが見つかりません')

  const targets = stage.items.filter(item => item.end - item.start > 10.0)
  return typeof limit === 'number' ? targets.slice(0, limit) : targets
}

async function measureOne(item: SnapshotItem, settings: AdminSettings, model: string): Promise<MeasuredItem> {
  const transcriptText = item.transcriptText ?? ''
  const result = await llmCallWithMeta(
    {
      model,
      systemPrompt: SYSTEM_PROMPT,
      userContent: transcriptText,
      temperature: 0.0,
      nodeName: 'seam_only_split',
    },
    settings,
  )

  const promptTokens = result.promptTokens ?? 0
  const completionTokens = result.completionTokens ?? 0

  if (result.errorMessage) {
    return {
      item,
      units: [],
      check: { classification: 'llm_error', units: [], detail: result.errorMessage },
      promptTokens,
      completionTokens,
      errorMessage: result.errorMessage,
    }
  }

  let parsed: Record<string, unknown>
  try {
    parsed = parseJsonObjectFromLlmContent(result.content, 'seam_only_split')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      item,
      units: [],
      check: { classification: 'llm_error', units: [], detail: message },
      promptTokens,
      completionTokens,
      errorMessage: message,
    }
  }

  if (parsed.cannot_split === true) {
    return {
      item,
      units: [],
      check: { classification: 'refused', units: [] },
      promptTokens,
      completionTokens,
    }
  }

  const units: string[] = Array.isArray(parsed.units)
    ? parsed.units
      .map((row) => (row && typeof row === 'object' ? (row as Record<string, unknown>).text : undefined))
      .filter((text): text is string => typeof text === 'string' && text.length > 0)
    : []

  return {
    item,
    units,
    check: checkSeamOnlySplit(transcriptText, units),
    promptTokens,
    completionTokens,
  }
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

function printClassificationTable(measured: readonly MeasuredItem[]): void {
  const counts = new Map<Classification, number>()
  for (const m of measured) {
    counts.set(m.check.classification, (counts.get(m.check.classification) ?? 0) + 1)
  }
  console.log('── 分類ごとの件数 ──')
  const order: Classification[] = ['split_ok', 'refused', 'rewritten_outside_seam', 'tail_dropped', 'llm_error']
  for (const key of order) {
    const n = counts.get(key) ?? 0
    const pct = measured.length > 0 ? ((n / measured.length) * 100).toFixed(1) : '0.0'
    console.log(`  ${key.padEnd(24)} ${String(n).padStart(4)} 件 (${pct}%)`)
  }
  console.log('')
}

function printSplitOkStats(measured: readonly MeasuredItem[]): void {
  const ok = measured.filter(m => m.check.classification === 'split_ok')
  if (ok.length === 0) {
    console.log('── split_ok の統計 ── (該当なし)\n')
    return
  }
  const byUnitCount = new Map<number, number>()
  const tailEditSums: number[] = []
  for (const m of ok) {
    const n = m.units.length
    byUnitCount.set(n, (byUnitCount.get(n) ?? 0) + 1)
    tailEditSums.push(m.check.units.reduce((sum, u) => sum + u.tailEdit, 0))
  }
  console.log('── split_ok の統計 ──')
  for (const [n, c] of [...byUnitCount].sort((a, b) => a[0] - b[0])) {
    console.log(`  ${n} 個に分割: ${c} 件`)
  }
  console.log(`  tailEdit合計 中央値: ${median(tailEditSums).toFixed(1)} / 最大: ${Math.max(...tailEditSums)}`)
  console.log('')
}

function printSplitOkExamples(measured: readonly MeasuredItem[]): void {
  const ok = measured.filter(m => m.check.classification === 'split_ok').slice(0, 5)
  console.log('── split_ok の実例（最大5件） ──')
  for (const m of ok) {
    console.log(`[block ${m.item.id}] 原文: ${m.item.transcriptText ?? ''}`)
    m.check.units.forEach((u, i) => {
      console.log(`  unit${i + 1} (tailEdit=${u.tailEdit}): ${u.text}`)
    })
    console.log('')
  }
}

function printRewrittenExamples(measured: readonly MeasuredItem[]): void {
  const rewritten = measured.filter(m => m.check.classification === 'rewritten_outside_seam').slice(0, 5)
  console.log('── rewritten_outside_seam の実例（最大5件） ──')
  for (const m of rewritten) {
    console.log(`[block ${m.item.id}] 原文: ${m.item.transcriptText ?? ''}`)
    console.log(`  崩れた箇所: ${m.check.detail ?? '(詳細なし)'}`)
    m.check.units.forEach((u, i) => {
      console.log(`  unit${i + 1} (tailEdit=${u.tailEdit}): ${u.text}`)
    })
    console.log('')
  }
}

function printTokenUsage(measured: readonly MeasuredItem[]): void {
  const promptTokens = measured.reduce((sum, m) => sum + m.promptTokens, 0)
  const completionTokens = measured.reduce((sum, m) => sum + m.completionTokens, 0)
  console.log('── トークン使用量 ──')
  console.log(`  promptTokens合計: ${promptTokens}`)
  console.log(`  completionTokens合計: ${completionTokens}`)
}

async function main(): Promise<void> {
  const projectPath = process.argv[2]
  const limitArg = process.argv[3]
  if (!projectPath) throw new Error('Usage: measureSeamOnlySplit.ts <project.json> [limit]')
  const limit = limitArg !== undefined ? Number(limitArg) : undefined
  if (limit !== undefined && !Number.isFinite(limit)) throw new Error('limit は数値で指定してください')

  const project = JSON.parse(readFileSync(projectPath, 'utf-8')) as Record<string, unknown>
  const settings = buildSettings(project)
  const model = requireChatModelForProvider(settings, settings.correctionModel || settings.translationModel, 'seam split')

  const targets = loadTargets(projectPath, limit)
  console.log(`対象件数: ${targets.length} 件 / 使用モデル: ${model}`)
  console.log('')

  const measured = await mapWithConcurrency(targets.length, 4, async (index) => {
    return measureOne(targets[index], settings, model)
  })

  printClassificationTable(measured)
  printSplitOkStats(measured)
  printSplitOkExamples(measured)
  printRewrittenExamples(measured)
  printTokenUsage(measured)
}

main().catch((error) => {
  console.error('[measureSeamOnlySplit] fatal error:', error)
  process.exitCode = 1
})
