/**
 * 保存済みプロジェクトJSONを読んで、字幕出力の欠陥を機械的に洗い出す監査スクリプト。
 * LLM は一切呼ばない。
 *
 * 動画を目視して欠陥を探すのは漏れが多いので、網羅的に検出できるようにするためのもの。
 * 第2引数にベースラインを渡すと、項目ごとに「ベースライン → 対象」を並べ、悪化を印で示す。
 *
 * 閾値について: プロジェクトJSONの `session.adminSettings` はエクスポート時に一部フィールドへ
 * 間引かれることがある（8/5 のファイルは30項目しか無く `pipelineLongDurationSec` が欠けていた）。
 * 欠けた項目をコード既定値で黙って補うと、実際の設定（long=14秒）ではなく既定値（10秒）で
 * 測ってしまい誤った分析を招く。実際にそれをやって尺違反の件数を取り違えた。
 * そのため本スクリプトは各閾値の出所を必ず表示し、既定値で補った項目があれば警告する。
 *
 * 使い方（frontend ディレクトリで実行）:
 *   TSX_TSCONFIG_PATH="$(pwd)/tsconfig.app.json" node --import tsx \
 *     --import ./scripts/importMetaEnvShim.mjs scripts/auditOutput.ts <project.json> [baseline.json]
 */
import { readFileSync } from 'node:fs'

import { DEFAULT_PIPELINE_THRESHOLDS, type PipelineThresholds } from '../src/lib/pipeline/blockTypes'
import { endsWithIncompleteJapanese } from '../src/lib/pipeline/correctionAgent/tools/splitBlock'

// 語末をこの秒数でクランプしてから無音を測る。パイプライン自身（wordToChars）が同じ
// クランプを掛けているため、これを入れないと間の無音が消えて「無字幕の発話」が測れない。
const MAX_WORD_DURATION_SEC = 0.6
const SILENCE_MIN_GAP_SEC = 1.0
const MIN_HOLE_SEC = 1.0

const PUNCT = new Set('。、「」『』（）()［］[]！？!?・,，. \t\r\n　'.split(''))

// 文頭に立てない助詞・接続のみを対象にする。「は」「が」「に」「で」「と」「の」「も」の
// 単独文字を入れると「もう一つは」「ところが」のような正当な文頭を誤検出するため使わない。
const SENTENCE_INITIAL_PARTICLE = /^(には|では|からの|への|として|について|を|へ)/

// 前のキューを見ないと意味が取れない英語の始まり方。splitBlock の isBadEnglishUnit が禁じている形。
const CONTEXT_DEPENDENT_EN = /^(This|That|It|These|Those)\b/

interface Word { word?: string; start?: number; end?: number }
interface Segment { words?: Word[] }
interface Block {
  id: number
  startTime: number
  endTime: number
  transcript?: string
  subtitle?: string
  cps?: number
  merged?: boolean
}
interface SnapshotItem {
  id: number
  start: number
  end: number
  merged?: boolean
  transcriptText?: string
  subtitleText?: string
  cps?: number
  maxLineLen?: number
  violation?: string
  correctionAttempts?: unknown[]
}
type Span = [number, number]

type Source = 'settingsSnapshot' | 'adminSettings' | 'コード既定値'
interface ResolvedThresholds {
  values: PipelineThresholds
  sources: Map<keyof PipelineThresholds, Source>
}

interface Finding<T> {
  count: number
  examples: T[]
  extra?: Record<string, number>
}

interface AuditResult {
  label: string
  cues: number
  thresholds: ResolvedThresholds
  cpsOver: Finding<SnapshotItem>
  lineOver: Finding<SnapshotItem>
  durationOver: Finding<Block>
  durationShort: Finding<Block>
  midPhraseStart: Finding<{ block: Block; prevTail: string }>
  incompleteEnd: Finding<Block>
  contextDependentEn: Finding<Block>
  uncovered: Finding<Span>
  silenceCovered: number
  untriedViolations: Finding<SnapshotItem>
  timeAnomalies: Finding<Block>
  emptyText: Finding<Block>
}

function norm(text: string | undefined): string {
  return [...(text ?? '')].filter(c => !PUNCT.has(c)).join('')
}

function mmss(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function readNumber(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** 閾値を解決し、各項目がどこから来たかを記録する。 */
function resolveThresholds(project: Record<string, unknown>): ResolvedThresholds {
  const session = (project.session ?? {}) as Record<string, unknown>
  const admin = (session.adminSettings ?? {}) as Record<string, unknown>
  const workLog = (session.workLog ?? {}) as Record<string, unknown>
  const header = (workLog.header ?? {}) as Record<string, unknown>
  const snapshot = (header.settingsSnapshot ?? {}) as Record<string, unknown>

  const sources = new Map<keyof PipelineThresholds, Source>()
  const pick = (field: keyof PipelineThresholds, key: string): number => {
    const fromSnapshot = readNumber(snapshot, key)
    if (fromSnapshot !== undefined) {
      sources.set(field, 'settingsSnapshot')
      return fromSnapshot
    }
    const fromAdmin = readNumber(admin, key)
    if (fromAdmin !== undefined) {
      sources.set(field, 'adminSettings')
      return fromAdmin
    }
    sources.set(field, 'コード既定値')
    return DEFAULT_PIPELINE_THRESHOLDS[field] as number
  }

  const values: PipelineThresholds = {
    shortDurationSec: pick('shortDurationSec', 'pipelineShortDurationSec'),
    longDurationSec: pick('longDurationSec', 'pipelineLongDurationSec'),
    mergedLongDurationSec: pick('mergedLongDurationSec', 'pipelineMergedLongDurationSec'),
    overCompressedRatio: pick('overCompressedRatio', 'pipelineOverCompressedRatio'),
    overCompressedJaChars: pick('overCompressedJaChars', 'pipelineOverCompressedJaChars'),
    verboseEnRatio: pick('verboseEnRatio', 'pipelineVerboseEnRatio'),
    verboseCps: pick('verboseCps', 'enMaxCps'),
    maxLineLen: pick('maxLineLen', 'enMaxCharsPerLine'),
    slowCps: pick('slowCps', 'pipelineSlowCps'),
    maxExpandPerBlock: pick('maxExpandPerBlock', 'pipelineMaxExpandPerBlock'),
    maxCompressPerBlock: pick('maxCompressPerBlock', 'pipelineMaxCompressPerBlock'),
  }
  return { values, sources }
}

/** パイプラインと同じクランプを掛けた文字単位ストリームの時刻列を作る。 */
function asrCharSpans(segments: readonly Segment[]): Span[] {
  const spans: Span[] = []
  for (const segment of segments) {
    const words = (segment.words ?? [])
      .filter((w): w is Word & { start: number; end: number } =>
        typeof w.start === 'number' && Number.isFinite(w.start)
        && typeof w.end === 'number' && Number.isFinite(w.end))
      .sort((a, b) => a.start - b.start)
    for (const word of words) {
      const text = norm(String(word.word ?? ''))
      if (text.length === 0) continue
      const end = Math.min(word.end, word.start + MAX_WORD_DURATION_SEC)
      const per = (end - word.start) / text.length
      for (let k = 0; k < text.length; k += 1) {
        spans.push([word.start + per * k, word.start + per * (k + 1)])
      }
    }
  }
  return spans
}

function mergeSpans(spans: readonly Span[]): Span[] {
  const out: Span[] = []
  for (const [start, end] of [...spans].sort((a, b) => a[0] - b[0])) {
    const last = out[out.length - 1]
    if (last && start <= last[1]) last[1] = Math.max(last[1], end)
    else out.push([start, end])
  }
  return out
}

/** 文字の連なりを、SILENCE_MIN_GAP_SEC 以上の無音で区切って発話区間にする。 */
function speechSpans(chars: readonly Span[]): Span[] {
  if (chars.length === 0) return []
  const out: Span[] = []
  let [cur, curEnd] = chars[0]
  for (const [start, end] of chars.slice(1)) {
    if (start - curEnd >= SILENCE_MIN_GAP_SEC) {
      out.push([cur, curEnd])
      cur = start
    }
    curEnd = Math.max(curEnd, end)
  }
  out.push([cur, curEnd])
  return out
}

/** 発話しているのに、どのキューにも覆われていない区間。 */
function uncoveredSpeech(speech: readonly Span[], cues: readonly Span[]): Span[] {
  const holes: Span[] = []
  for (const [start, end] of speech) {
    let cursor = start
    for (const [cueStart, cueEnd] of cues) {
      if (cueEnd <= cursor || cueStart >= end) continue
      if (cueStart > cursor) holes.push([cursor, Math.min(cueStart, end)])
      cursor = Math.max(cursor, cueEnd)
      if (cursor >= end) break
    }
    if (cursor < end) holes.push([cursor, end])
  }
  return holes.filter(([s, e]) => e - s >= MIN_HOLE_SEC)
}

/** 字幕が出ているのに発話が無い時間の合計。 */
function silenceUnderCues(speech: readonly Span[], cues: readonly Span[]): number {
  let total = 0
  for (const [cueStart, cueEnd] of cues) {
    let overlap = 0
    for (const [start, end] of speech) {
      overlap += Math.max(0, Math.min(cueEnd, end) - Math.max(cueStart, start))
    }
    total += Math.max(0, (cueEnd - cueStart) - overlap)
  }
  return total
}

function isDurationViolation(item: { start: number; end: number; merged?: boolean }, t: PipelineThresholds): boolean {
  const duration = item.end - item.start
  return item.merged === true ? duration > t.mergedLongDurationSec : duration > t.longDurationSec
}

function find<T>(items: readonly T[], limit = 5, extra?: Record<string, number>): Finding<T> {
  return { count: items.length, examples: items.slice(0, limit), extra }
}

function stageItems(project: Record<string, unknown>, stage: string): SnapshotItem[] {
  const session = (project.session ?? {}) as Record<string, unknown>
  const run = (session.pipelineRun ?? {}) as Record<string, unknown>
  const debug = (run.debug ?? {}) as Record<string, unknown>
  const stages = (debug.stageSnapshots ?? []) as Array<{ stage: string; items?: SnapshotItem[] }>
  return stages.find(s => s.stage === stage)?.items ?? []
}

function audit(path: string, label: string): AuditResult {
  const project = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>
  const thresholds = resolveThresholds(project)
  const t = thresholds.values

  const blocks = [...((project.blocks ?? []) as Block[])].sort((a, b) => a.startTime - b.startTime)
  const session = (project.session ?? {}) as Record<string, unknown>
  const run = (session.pipelineRun ?? {}) as Record<string, unknown>
  const debug = (run.debug ?? {}) as Record<string, unknown>
  const segments = (debug.transcriptSegments ?? []) as Segment[]

  const final = stageItems(project, 'finalFormatLines')
  const entry = stageItems(project, 'checkCpsViolations')
  const afterLoop = stageItems(project, 'correctionEngine')

  // A. 表示制約
  const cpsOverItems = final.filter(i => (i.cps ?? 0) > t.verboseCps)
    .sort((a, b) => (b.cps ?? 0) - (a.cps ?? 0))
  const lineOverItems = final.filter(i => (i.maxLineLen ?? 0) > t.maxLineLen)
    .sort((a, b) => (b.maxLineLen ?? 0) - (a.maxLineLen ?? 0))
  // merged は最終ブロック（SubtitleBlock）には残らず toSubtitleBlocks で落ちるため、
  // blocks[].merged を見ると常に undefined になり、結合済みキューにも緩い方の閾値を
  // 当ててしまう。merged を保持している最後の段階（finalFormatLines）から引く。
  const mergedById = new Map(final.map(i => [i.id, i.merged === true]))
  const durationOverBlocks = blocks
    .filter(b => isDurationViolation({ start: b.startTime, end: b.endTime, merged: mergedById.get(b.id) }, t))
    .sort((a, b) => (b.endTime - b.startTime) - (a.endTime - a.startTime))
  const durationShortBlocks = blocks.filter(b => b.endTime - b.startTime < t.shortDurationSec)

  // B. 文の切れ方
  const midPhrase: Array<{ block: Block; prevTail: string }> = []
  blocks.forEach((block, index) => {
    const text = (block.transcript ?? '').replace(/^[\s\u3000]+/, '')
    if (!SENTENCE_INITIAL_PARTICLE.test(text)) return
    const prev = blocks[index - 1]
    midPhrase.push({ block, prevTail: (prev?.transcript ?? '').slice(-14) })
  })
  const incompleteEndBlocks = blocks.filter(b => endsWithIncompleteJapanese(b.transcript ?? ''))
  const contextDependentEnBlocks = blocks.filter(b => CONTEXT_DEPENDENT_EN.test((b.subtitle ?? '').trim()))

  // C. 発話との対応
  const speech = mergeSpans(speechSpans(asrCharSpans(segments)))
  const cues = mergeSpans(blocks.map((b): Span => [b.startTime, b.endTime]))
  const holes = uncoveredSpeech(speech, cues).sort((a, b) => (b[1] - b[0]) - (a[1] - a[0]))
  const uncoveredSec = holes.reduce((sum, [s, e]) => sum + (e - s), 0)

  // D. 修復の取りこぼし
  const afterById = new Map(afterLoop.map(i => [i.id, i]))
  const untried = entry
    .filter(i => isDurationViolation(i, t) || (i.cps ?? 0) > t.verboseCps || (i.maxLineLen ?? 0) > t.maxLineLen)
    .filter(i => ((afterById.get(i.id)?.correctionAttempts ?? []).length === 0))
    .sort((a, b) => (b.end - b.start) - (a.end - a.start))

  // E. 整合性
  const timeAnomalies = blocks.filter((b, i) => {
    if (b.endTime <= b.startTime) return true
    const next = blocks[i + 1]
    return next !== undefined && next.startTime < b.endTime
  })
  const emptyText = blocks.filter(b => norm(b.transcript).length === 0 || (b.subtitle ?? '').trim().length === 0)

  return {
    label,
    cues: blocks.length,
    thresholds,
    cpsOver: find(cpsOverItems, 5, { 最大: Math.max(0, ...cpsOverItems.map(i => i.cps ?? 0)) }),
    lineOver: find(lineOverItems, 5, { 最大: Math.max(0, ...lineOverItems.map(i => i.maxLineLen ?? 0)) }),
    durationOver: find(durationOverBlocks, 5, {
      最大秒: Math.max(0, ...durationOverBlocks.map(b => b.endTime - b.startTime)),
    }),
    durationShort: find(durationShortBlocks),
    midPhraseStart: find(midPhrase),
    incompleteEnd: find(incompleteEndBlocks),
    contextDependentEn: find(contextDependentEnBlocks),
    uncovered: find(holes, 5, {
      合計秒: uncoveredSec,
      最大秒: Math.max(0, ...holes.map(([s, e]) => e - s)),
    }),
    silenceCovered: silenceUnderCues(speech, cues),
    untriedViolations: find(untried),
    timeAnomalies: find(timeAnomalies),
    emptyText: find(emptyText),
  }
}

function printThresholds(r: AuditResult): void {
  console.log(`【閾値】(${r.label})`)
  const watched: Array<[keyof PipelineThresholds, string]> = [
    ['verboseCps', 'CPS上限'],
    ['maxLineLen', '行長上限'],
    ['longDurationSec', '尺の上限'],
    ['mergedLongDurationSec', '尺の上限(結合済)'],
    ['shortDurationSec', '尺の下限'],
  ]
  for (const [field, name] of watched) {
    console.log(`  ${name.padEnd(18)} ${String(r.thresholds.values[field]).padStart(6)}  (出所: ${r.thresholds.sources.get(field)})`)
  }
  const defaulted = watched.filter(([field]) => r.thresholds.sources.get(field) === 'コード既定値')
  for (const [field, name] of defaulted) {
    console.log(`  ⚠ ${name}（${field}）はJSONに無く、コード既定値 ${r.thresholds.values[field]} を使用しています。`)
    console.log('    実際の設定と異なる可能性があります。この値に依存する件数は信用しないこと。')
  }
  console.log('')
}

function printDetails(r: AuditResult): void {
  const t = r.thresholds.values
  console.log(`【詳細】(${r.label}) ${r.cues} キュー`)

  if (r.midPhraseStart.count > 0) {
    console.log(`\n■ 文節途中で切れた境界: ${r.midPhraseStart.count} 件`)
    for (const { block, prevTail } of r.midPhraseStart.examples) {
      console.log(`  ${mmss(block.startTime)} id=${block.id}`)
      console.log(`    …${prevTail}  ／  ${(block.transcript ?? '').slice(0, 34)}…`)
    }
  }
  if (r.incompleteEnd.count > 0) {
    console.log(`\n■ 文の途中で終わるキュー: ${r.incompleteEnd.count} 件`)
    for (const block of r.incompleteEnd.examples) {
      console.log(`  ${mmss(block.startTime)} id=${block.id}  …${(block.transcript ?? '').slice(-24)}`)
    }
  }
  if (r.contextDependentEn.count > 0) {
    console.log(`\n■ 英語が文脈依存の代名詞で始まるキュー: ${r.contextDependentEn.count} 件`)
    for (const block of r.contextDependentEn.examples) {
      console.log(`  ${mmss(block.startTime)} id=${block.id}  ${(block.subtitle ?? '').replace(/\n/g, ' ').slice(0, 70)}`)
    }
  }
  if (r.durationOver.count > 0) {
    console.log(`\n■ 尺違反（>${t.longDurationSec}秒 / 結合済 >${t.mergedLongDurationSec}秒）: ${r.durationOver.count} 件`)
    for (const block of r.durationOver.examples) {
      console.log(`  ${mmss(block.startTime)} id=${block.id} ${(block.endTime - block.startTime).toFixed(1)}秒  ${(block.transcript ?? '').slice(0, 46)}`)
    }
  }
  if (r.untriedViolations.count > 0) {
    console.log(`\n■ 違反なのに修復が一度も試みられなかったキュー: ${r.untriedViolations.count} 件`)
    for (const item of r.untriedViolations.examples) {
      console.log(`  ${mmss(item.start)} id=${item.id} ${(item.end - item.start).toFixed(1)}秒 [${item.violation}]  …${(item.transcriptText ?? '').slice(-20)}`)
    }
  }
  if (r.cpsOver.count > 0) {
    console.log(`\n■ CPS超過（>${t.verboseCps}）: ${r.cpsOver.count} 件`)
    for (const item of r.cpsOver.examples) {
      console.log(`  ${mmss(item.start)} id=${item.id} cps=${(item.cps ?? 0).toFixed(1)} ${(item.end - item.start).toFixed(1)}秒`)
      console.log(`    ${(item.subtitleText ?? '').replace(/\n/g, ' ').slice(0, 76)}`)
    }
  }
  if (r.lineOver.count > 0) {
    console.log(`\n■ 行長超過（>${t.maxLineLen}）: ${r.lineOver.count} 件`)
    for (const item of r.lineOver.examples) {
      console.log(`  ${mmss(item.start)} id=${item.id} 行長=${item.maxLineLen}`)
      console.log(`    ${(item.subtitleText ?? '').replace(/\n/g, ' | ').slice(0, 76)}`)
    }
  }
  if (r.uncovered.count > 0) {
    console.log(`\n■ 無字幕の発話（${MIN_HOLE_SEC}秒以上）: ${r.uncovered.count} 箇所 / 合計 ${(r.uncovered.extra?.合計秒 ?? 0).toFixed(1)}秒`)
    for (const [start, end] of r.uncovered.examples) {
      console.log(`  ${mmss(start)}〜${mmss(end)}  ${(end - start).toFixed(1)}秒`)
    }
  }
  for (const [name, finding] of [['時刻の逆転・重なり', r.timeAnomalies], ['本文が空のキュー', r.emptyText]] as const) {
    if (finding.count === 0) continue
    console.log(`\n■ ${name}: ${finding.count} 件`)
    for (const block of finding.examples) {
      console.log(`  ${mmss(block.startTime)} id=${block.id} ${block.startTime.toFixed(2)}〜${block.endTime.toFixed(2)}`)
    }
  }
  console.log('')
}

interface SummaryRow { name: string; value: (r: AuditResult) => number; unit: string; lowerIsBetter: boolean }

const SUMMARY_ROWS: SummaryRow[] = [
  { name: 'キュー数', value: r => r.cues, unit: '', lowerIsBetter: false },
  { name: 'CPS超過', value: r => r.cpsOver.count, unit: '件', lowerIsBetter: true },
  { name: '行長超過', value: r => r.lineOver.count, unit: '件', lowerIsBetter: true },
  { name: '尺違反', value: r => r.durationOver.count, unit: '件', lowerIsBetter: true },
  { name: '尺が短すぎる', value: r => r.durationShort.count, unit: '件', lowerIsBetter: true },
  { name: '文節途中で切れた境界', value: r => r.midPhraseStart.count, unit: '件', lowerIsBetter: true },
  { name: '文の途中で終わるキュー', value: r => r.incompleteEnd.count, unit: '件', lowerIsBetter: true },
  { name: '英語が代名詞で始まる', value: r => r.contextDependentEn.count, unit: '件', lowerIsBetter: true },
  { name: '無字幕の発話（合計）', value: r => r.uncovered.extra?.合計秒 ?? 0, unit: '秒', lowerIsBetter: true },
  { name: '無字幕の発話（箇所）', value: r => r.uncovered.count, unit: '箇所', lowerIsBetter: true },
  { name: '無音上の字幕', value: r => r.silenceCovered, unit: '秒', lowerIsBetter: true },
  { name: '修復が試されなかった違反', value: r => r.untriedViolations.count, unit: '件', lowerIsBetter: true },
  { name: '時刻の逆転・重なり', value: r => r.timeAnomalies.count, unit: '件', lowerIsBetter: true },
  { name: '本文が空のキュー', value: r => r.emptyText.count, unit: '件', lowerIsBetter: true },
]

function fmt(value: number, unit: string): string {
  const shown = Number.isInteger(value) ? String(value) : value.toFixed(1)
  return unit ? `${shown} ${unit}` : shown
}

function printSummary(target: AuditResult, baseline?: AuditResult): void {
  console.log('='.repeat(76))
  console.log('【サマリ】')
  console.log('='.repeat(76))
  if (!baseline) {
    for (const row of SUMMARY_ROWS) {
      const v = row.value(target)
      if (v === 0 && row.lowerIsBetter) continue
      console.log(`  ${row.name.padEnd(26)} ${fmt(v, row.unit).padStart(12)}`)
    }
    console.log('\n  （0 件の項目は省略しています）')
    return
  }

  const rows = SUMMARY_ROWS.map((row) => {
    const before = row.value(baseline)
    const after = row.value(target)
    const worse = row.lowerIsBetter && after > before
    return { row, before, after, worse }
  })
  // 悪化した項目を先に出す。見落とすと困るのはこちらなため。
  const ordered = [...rows.filter(r => r.worse), ...rows.filter(r => !r.worse)]
  console.log(`  ${''.padEnd(26)} ${baseline.label.padStart(12)} ${target.label.padStart(12)}`)
  console.log('  ' + '-'.repeat(64))
  for (const { row, before, after, worse } of ordered) {
    const mark = worse ? ' ← 悪化' : ''
    console.log(`  ${row.name.padEnd(26)} ${fmt(before, row.unit).padStart(12)} ${fmt(after, row.unit).padStart(12)}${mark}`)
  }
  const worseCount = rows.filter(r => r.worse).length
  console.log(`\n  悪化した項目: ${worseCount} / ${rows.length}`)
}

function main(): void {
  const targetPath = process.argv[2]
  if (!targetPath) throw new Error('Usage: auditOutput.ts <project.json> [baseline.json]')
  const baselinePath = process.argv[3]

  const target = audit(targetPath, '対象')
  const baseline = baselinePath ? audit(baselinePath, 'ベースライン') : undefined

  printThresholds(target)
  if (baseline) printThresholds(baseline)
  printDetails(target)
  printSummary(target, baseline)
}

main()
