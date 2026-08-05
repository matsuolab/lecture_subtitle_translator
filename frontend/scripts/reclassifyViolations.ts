/**
 * 保存済みプロジェクトJSONの最終ブロックに、現在のコードの `classifyViolation` を
 * 当て直して違反コードの分布を出す。LLM呼び出しは不要。
 *
 * 違反判定の変更が実データにどう効くかを、実行し直さずに確認するための診断スクリプト。
 * 閾値はコードの既定値ではなく、そのプロジェクトの実行時設定
 * （workLog.header.settingsSnapshot > adminSettings）から読む。
 *
 * 使い方（frontend ディレクトリで実行）:
 *   TSX_TSCONFIG_PATH="$(pwd)/tsconfig.app.json" node --import tsx \
 *     --import ./scripts/importMetaEnvShim.mjs scripts/reclassifyViolations.ts <project.json>
 */
import { readFileSync } from 'node:fs'

import { classifyViolation, computeMetrics } from '../src/lib/pipeline/metrics'
import { DEFAULT_PIPELINE_THRESHOLDS, type PipelineThresholds } from '../src/lib/pipeline/blockTypes'

interface SnapshotItem {
  id: number
  start: number
  end: number
  jaChars?: number
  alignConf?: string
  merged?: boolean
  subtitleText?: string
  enChars?: number
  cps?: number
  maxLineLen?: number
  violation?: string
}

function readNumber(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** 実行時の設定から閾値を組む。未設定の項目はコードの既定値で補う。 */
function resolveThresholds(project: Record<string, unknown>): PipelineThresholds {
  const session = (project.session ?? {}) as Record<string, unknown>
  const admin = (session.adminSettings ?? {}) as Record<string, unknown>
  const workLog = (session.workLog ?? {}) as Record<string, unknown>
  const header = (workLog.header ?? {}) as Record<string, unknown>
  const snapshot = (header.settingsSnapshot ?? {}) as Record<string, unknown>
  const cfg: Record<string, unknown> = { ...admin, ...snapshot }
  const d = DEFAULT_PIPELINE_THRESHOLDS
  return {
    shortDurationSec: readNumber(cfg, 'pipelineShortDurationSec') ?? d.shortDurationSec,
    longDurationSec: readNumber(cfg, 'pipelineLongDurationSec') ?? d.longDurationSec,
    mergedLongDurationSec: readNumber(cfg, 'pipelineMergedLongDurationSec') ?? d.mergedLongDurationSec,
    overCompressedRatio: readNumber(cfg, 'pipelineOverCompressedRatio') ?? d.overCompressedRatio,
    overCompressedJaChars: readNumber(cfg, 'pipelineOverCompressedJaChars') ?? d.overCompressedJaChars,
    verboseEnRatio: readNumber(cfg, 'pipelineVerboseEnRatio') ?? d.verboseEnRatio,
    verboseCps: readNumber(cfg, 'enMaxCps') ?? d.verboseCps,
    maxLineLen: readNumber(cfg, 'enMaxCharsPerLine') ?? d.maxLineLen,
    slowCps: readNumber(cfg, 'pipelineSlowCps') ?? d.slowCps,
    maxExpandPerBlock: readNumber(cfg, 'pipelineMaxExpandPerBlock') ?? d.maxExpandPerBlock,
    maxCompressPerBlock: readNumber(cfg, 'pipelineMaxCompressPerBlock') ?? d.maxCompressPerBlock,
  }
}

function main(): void {
  const path = process.argv[2]
  if (!path) throw new Error('Usage: reclassifyViolations.ts <project.json>')
  const project = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>
  const thresholds = resolveThresholds(project)

  const session = (project.session ?? {}) as Record<string, unknown>
  const run = (session.pipelineRun ?? {}) as Record<string, unknown>
  const debug = (run.debug ?? {}) as Record<string, unknown>
  const stages = (debug.stageSnapshots ?? []) as Array<{ stage: string; items?: SnapshotItem[] }>
  const stage = stages.find(s => s.stage === 'finalFormatLines')
  if (!stage?.items) throw new Error('finalFormatLines スナップショットが見つかりません')

  console.log(`閾値: CPS>${thresholds.verboseCps} / 行長>${thresholds.maxLineLen} / 比>${thresholds.verboseEnRatio}`)
  console.log(`対象: ${stage.items.length} キュー`)
  console.log('')

  const recorded = new Map<string, number>()
  const recomputed = new Map<string, number>()
  let realHarm = 0
  let repairTargets = 0

  for (const item of stage.items) {
    recorded.set(item.violation ?? '(none)', (recorded.get(item.violation ?? '(none)') ?? 0) + 1)
    const block = {
      start: item.start,
      end: item.end,
      jaChars: item.jaChars ?? 0,
      alignConf: (item.alignConf ?? 'exact') as 'exact' | 'no_words' | 'merged' | 'proportional',
      merged: item.merged ?? false,
      enText: item.subtitleText ?? '',
      enChars: item.enChars,
      cps: item.cps,
      maxLineLen: item.maxLineLen,
    }
    const metrics = computeMetrics(block)
    const violation = classifyViolation(block, thresholds)
    recomputed.set(violation, (recomputed.get(violation) ?? 0) + 1)
    if (metrics.cps > thresholds.verboseCps || metrics.maxLineLen > thresholds.maxLineLen) realHarm += 1
    if (violation !== 'ok' && violation !== 'slow_speech') repairTargets += 1
  }

  const show = (label: string, map: Map<string, number>): void => {
    console.log(label)
    for (const [code, count] of [...map].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${code.padEnd(18)} ${String(count).padStart(4)}`)
    }
    console.log('')
  }
  show('保存されている violation（この実行時のコードによる分類）:', recorded)
  show('現在のコードで再分類した violation:', recomputed)
  console.log(`実害（CPS超過 or 行長超過）      : ${realHarm} 件`)
  console.log(`修復対象（violation != ok/slow）: ${repairTargets} 件`)
}

main()
