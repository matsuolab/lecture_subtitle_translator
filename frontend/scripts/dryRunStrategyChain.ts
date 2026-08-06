/**
 * 修復ループの戦略選択だけを、保存済みプロジェクトの実データでドライランする診断スクリプト。
 * ツールは実行しないので LLM 呼び出しは発生しない。
 *
 * 「全試行が失敗する」最悪ケースを仮定して、各違反ブロックがどの戦略を
 * どの順に試されるかを出す。失敗時に再キューする変更が、意図した戦略の連鎖
 * （分割 → 圧縮 → 差し戻し）に実際に繋がるかを、実行し直さずに確認するためのもの。
 *
 * 出力の試行回数は上限であり、実際にはどこかで成功して打ち切られる。
 *
 * 使い方（frontend ディレクトリで実行）:
 *   TSX_TSCONFIG_PATH="$(pwd)/tsconfig.app.json" node --import tsx \
 *     --import ./scripts/importMetaEnvShim.mjs scripts/dryRunStrategyChain.ts <project.json>
 */
import { readFileSync } from 'node:fs'

import { buildContext } from '../src/lib/pipeline/correctionAgent/contextBuilder'
import { getFeasibleStrategies } from '../src/lib/pipeline/correctionAgent/feasibility'
import { RuleBasedDecisionNode } from '../src/lib/pipeline/correctionAgent/decisionNode'
import { buildAgentThresholds } from '../src/lib/pipeline/correctionAgent/types'
import { toolRegistry } from '../src/lib/pipeline/correctionAgent/tools/index'
import type {
  AgentThresholds,
  CorrectionAttempt,
  CorrectionStrategy,
} from '../src/lib/pipeline/correctionAgent/types'
import { classifyViolation } from '../src/lib/pipeline/metrics'
import { DEFAULT_PIPELINE_THRESHOLDS, type EnBlock, type PipelineThresholds } from '../src/lib/pipeline/blockTypes'
import { getDefaultAdminSettings } from '../src/api/adminSettings'

interface SnapshotItem {
  id: number
  start: number
  end: number
  jaChars?: number
  alignConf?: string
  merged?: boolean
  transcriptText?: string
  subtitleText?: string
  enChars?: number
  cps?: number
  maxLineLen?: number
}

function readNumber(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

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

function toBlock(item: SnapshotItem, thresholds: PipelineThresholds): EnBlock {
  const base = {
    id: item.id,
    start: item.start,
    end: item.end,
    jaText: item.transcriptText ?? '',
    jaChars: item.jaChars ?? 0,
    alignConf: (item.alignConf ?? 'exact') as EnBlock['alignConf'],
    words: [],
    merged: item.merged ?? false,
    enText: item.subtitleText ?? '',
    enRaw: item.subtitleText ?? '',
    enChars: item.enChars ?? 0,
    cps: item.cps ?? 0,
    maxLineLen: item.maxLineLen ?? 0,
    expandCount: 0,
    compressCount: 0,
  } as unknown as EnBlock
  return { ...base, violation: classifyViolation(base, thresholds) }
}

/** 失敗した試行を1件作る（ツールは実行しないので中身は最小限）。*/
function failedAttempt(strategy: CorrectionStrategy, block: EnBlock): CorrectionAttempt {
  return {
    strategy,
    changed: false,
    beforeChars: block.enChars,
    afterChars: block.enChars,
    beforeViolation: block.violation,
    afterViolation: block.violation,
    beforeTranscriptText: block.jaText,
    beforeSubtitleText: block.enText,
    afterTranscriptText: block.jaText,
    afterSubtitleText: block.enText,
  }
}

/** 打ち切り条件。loop.ts の shouldEarlyTerminate と同じ規則を、全失敗前提で再現する。*/
function stops(history: CorrectionAttempt[]): boolean {
  if (history.length >= 2) {
    const last2 = history.slice(-2)
    if (last2[0].strategy === last2[1].strategy) return true
  }
  // 全試行が失敗（changed=false）なので、3連続で no_meaningful_reduction に当たる
  if (history.length >= 3) return true
  return false
}

type SkipReason = 'too_short_to_hold_text' | 'no_feasible_strategy' | 'early_termination' | 'max_rounds'

interface BlockResult {
  block: EnBlock
  chain: CorrectionStrategy[]
  stopReason: SkipReason
}

/** 1ブロック分のループを、全試行失敗の前提で回す。requeue=false なら旧挙動（失敗即打ち切り）。*/
async function simulateBlock(
  block: EnBlock,
  idx: number,
  timeline: EnBlock[],
  thresholds: PipelineThresholds & AgentThresholds,
  settings: ReturnType<typeof getDefaultAdminSettings>,
  decisionNode: RuleBasedDecisionNode,
  requeue: boolean,
): Promise<BlockResult> {
  const history: CorrectionAttempt[] = []
  let stopReason: SkipReason = 'max_rounds'
  for (;;) {
    const ctx = buildContext(block, idx, timeline, history, thresholds, settings)
    const agentThresholds = thresholds
    if (history.length >= agentThresholds.maxCorrectionRounds) { stopReason = 'max_rounds'; break }
    if (history.length > 0 && stops(history)) { stopReason = 'early_termination'; break }
    if (ctx.physicalMaxChars < agentThresholds.minMeaningfulChars) { stopReason = 'too_short_to_hold_text'; break }
    // loop.ts と同じ絞り込み。ここを合わせないと実機と違う連鎖を出してしまう。
    const feasible = getFeasibleStrategies(ctx, agentThresholds)
      .filter(strategy => toolRegistry[strategy].canApply(ctx))
    if (feasible.length === 0) { stopReason = 'no_feasible_strategy'; break }
    history.push(failedAttempt(await decisionNode.decide(ctx, feasible), block))
    // 旧挙動: 失敗したブロックはキューに戻されないので、ここで打ち切られる
    if (!requeue) { stopReason = 'early_termination'; break }
  }
  return { block, chain: history.map(a => a.strategy), stopReason }
}

function report(label: string, results: BlockResult[]): void {
  const chains = new Map<string, number>()
  const reachedCompress = new Set<number>()
  const noAttemptReason = new Map<SkipReason, number>()
  let totalAttempts = 0
  for (const r of results) {
    chains.set(r.chain.join(' -> ') || '(試行なし)', (chains.get(r.chain.join(' -> ') || '(試行なし)') ?? 0) + 1)
    totalAttempts += r.chain.length
    if (r.chain.some(s => s.startsWith('compress_'))) reachedCompress.add(r.block.id)
    if (r.chain.length === 0) noAttemptReason.set(r.stopReason, (noAttemptReason.get(r.stopReason) ?? 0) + 1)
  }
  console.log(`── ${label} ──`)
  for (const [chain, n] of [...chains].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log(`  ${String(n).padStart(4)} 件  ${chain}`)
  }
  if (noAttemptReason.size > 0) {
    console.log('  「試行なし」の理由:')
    for (const [reason, n] of [...noAttemptReason].sort((a, b) => b[1] - a[1])) {
      console.log(`      ${reason.padEnd(24)} ${String(n).padStart(4)} 件`)
    }
  }
  console.log(`  圧縮まで到達: ${reachedCompress.size} / ${results.length} ブロック`)
  console.log(`  延べ試行回数（LLM呼び出しの上限）: ${totalAttempts}`)
  console.log('')
}

async function main(): Promise<void> {
  const path = process.argv[2]
  if (!path) throw new Error('Usage: dryRunStrategyChain.ts <project.json>')
  const project = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>
  const pipelineThresholds = resolveThresholds(project)
  const settings = getDefaultAdminSettings()
  // phase2.ts と同じ組み立て方。AgentThresholds を混ぜないと maxSplitDepth 等が
  // undefined になり、split_block / borrow_gap が常に不可能と判定されてしまう。
  const thresholds: PipelineThresholds & AgentThresholds = {
    ...pipelineThresholds,
    ...buildAgentThresholds({ subtitleMinDurationSec: settings.subtitleMinDurationSec }),
  }
  const decisionNode = new RuleBasedDecisionNode()

  const session = (project.session ?? {}) as Record<string, unknown>
  const run = (session.pipelineRun ?? {}) as Record<string, unknown>
  const debug = (run.debug ?? {}) as Record<string, unknown>
  const stages = (debug.stageSnapshots ?? []) as Array<{ stage: string; items?: SnapshotItem[] }>
  const stage = stages.find(s => s.stage === 'checkCpsViolations')
  if (!stage?.items) throw new Error('checkCpsViolations スナップショットが見つかりません')

  const timeline = stage.items.map(item => toBlock(item, thresholds))
  // phase2.ts の needsCorrection と同じ条件で入口を決める
  const violating = timeline.filter(b =>
    b.violation === 'cps_over' ||
    b.violation === 'line_length_only' ||
    b.violation === 'long_segment' ||
    b.violation === 'merged_long',
  )

  console.log(`閾値: CPS>${thresholds.verboseCps} / 行長>${thresholds.maxLineLen}`)
  console.log(`correctionEngine 入力: ${timeline.length} ブロック / 修復対象 ${violating.length} 件`)
  const byViolation = new Map<string, number>()
  for (const b of violating) byViolation.set(b.violation, (byViolation.get(b.violation) ?? 0) + 1)
  console.log(`  内訳: ${[...byViolation].map(([k, v]) => `${k} ${v}`).join(' / ')}`)
  console.log('全試行が失敗する最悪ケースを仮定（＝LLM呼び出し回数の上限）')
  console.log('')

  for (const [label, requeue] of [['旧: 失敗したら捨てる', false], ['新: 失敗しても次の戦略へ', true]] as const) {
    const results: BlockResult[] = []
    for (const block of violating) {
      const idx = timeline.findIndex(b => b.id === block.id)
      results.push(await simulateBlock(block, idx, timeline, thresholds, settings, decisionNode, requeue))
    }
    report(label, results)
  }

  // 実機の記録と突き合わせて、シミュレーションの再現度を確認する
  const blocks = (project.blocks ?? []) as Array<{ id: number; correctionAttempts?: Array<{ strategy: string }> }>
  const attemptsById = new Map(blocks.map(b => [b.id, b.correctionAttempts ?? []]))
  const counts = new Map<number, number>()
  for (const b of violating) {
    const n = (attemptsById.get(b.id) ?? []).length
    counts.set(n, (counts.get(n) ?? 0) + 1)
  }
  console.log('── 突き合わせ: 実機（8/5実行）で同じブロックに記録された試行回数 ──')
  for (const [n, c] of [...counts].sort((a, b) => a[0] - b[0])) {
    console.log(`  ${n} 回: ${String(c).padStart(4)} 件`)
  }
}

void main()
