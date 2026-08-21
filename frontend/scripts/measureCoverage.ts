/**
 * 実データで `alignUnitsGlobally` を再実行し、「発話しているのに字幕が無い」秒数を測る。
 *
 * 入力は `scripts/extract_align_input.py` 相当が書き出す JSON:
 *   { segments: CorrectedSegmentLite相当[], units: RawSemanticUnit相当[] }
 *
 * 使い方（frontend ディレクトリで実行）:
 *   TSX_TSCONFIG_PATH="$(pwd)/tsconfig.app.json" node --import tsx \
 *     --import ./scripts/importMetaEnvShim.mjs scripts/measureCoverage.ts <align_input.json>
 */
import { readFileSync, writeFileSync } from 'node:fs'

import { buildAsrCharStreamWithRanges, findSilenceBoundaries, type AsrChar } from '../src/lib/pipeline/asrAlignment'
import { DEFAULT_PIPELINE_THRESHOLDS } from '../src/lib/pipeline/blockTypes'
import { __testing } from '../src/lib/pipeline/semanticSplitJa'
import type { TranscriptSegment } from '../src/lib/pipeline/types'

interface InputSegment {
  id: number
  start: number
  end: number
  text: string
  correctedText: string
  words: Array<{ word: string; start: number; end: number; score: number }>
}

interface InputUnit {
  unitId: string
  sourceSegmentId: number
  jaText: string
  canMergeWithNext: boolean
}

interface Span { start: number; end: number }

function speechRuns(asr: readonly AsrChar[], silenceAfter: ReadonlySet<number>): Span[] {
  const runs: Span[] = []
  let from = 0
  for (let i = 0; i < asr.length; i += 1) {
    if (i === asr.length - 1 || silenceAfter.has(i)) {
      runs.push({ start: asr[from].start, end: asr[i].end })
      from = i + 1
    }
  }
  return runs
}

function mergeSpans(spans: readonly Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start)
  const merged: Span[] = []
  for (const span of sorted) {
    const last = merged[merged.length - 1]
    if (last && span.start <= last.end + 0.001) {
      merged[merged.length - 1] = { start: last.start, end: Math.max(last.end, span.end) }
    } else {
      merged.push({ ...span })
    }
  }
  return merged
}

/** 発話区間のうち、どのキューにも覆われていない区間（minSec 以上）を返す。*/
function holes(runs: readonly Span[], covered: readonly Span[], minSec: number): Span[] {
  const result: Span[] = []
  for (const run of runs) {
    let cursor = run.start
    for (const span of covered) {
      if (span.end <= cursor || span.start >= run.end) continue
      if (span.start > cursor) result.push({ start: cursor, end: Math.min(span.start, run.end) })
      cursor = Math.max(cursor, Math.min(span.end, run.end))
      if (cursor >= run.end) break
    }
    if (cursor < run.end) result.push({ start: cursor, end: run.end })
  }
  return result.filter(hole => hole.end - hole.start >= minSec)
}

/** キューが無音の上に乗っている秒数（逆方向の不変条件の確認）。*/
function onSilenceSec(runs: readonly Span[], covered: readonly Span[]): number {
  let total = 0
  for (let i = 0; i < runs.length - 1; i += 1) {
    const gapStart = runs[i].end
    const gapEnd = runs[i + 1].start
    for (const span of covered) {
      total += Math.max(0, Math.min(span.end, gapEnd) - Math.max(span.start, gapStart))
    }
  }
  return total
}

function main(): void {
  const path = process.argv[2]
  if (!path) throw new Error('Usage: measureCoverage.ts <align_input.json>')
  const raw = JSON.parse(readFileSync(path, 'utf-8')) as { segments: InputSegment[]; units: InputUnit[] }

  const segments: TranscriptSegment[] = raw.segments.map(segment => ({
    id: segment.id,
    start: segment.start,
    end: segment.end,
    text: segment.text,
    words: segment.words,
  }))
  const { stream, ranges } = buildAsrCharStreamWithRanges(segments)
  const silenceAfter = findSilenceBoundaries(stream)
  const runs = speechRuns(stream, silenceAfter)
  const speechTotal = runs.reduce((sum, run) => sum + (run.end - run.start), 0)

  const units = raw.units.map(unit => ({ ...unit }))
  const result = __testing.alignUnitsGlobally(units, stream, ranges, DEFAULT_PIPELINE_THRESHOLDS, [])

  const covered = mergeSpans(result.units.map(unit => ({ start: unit.start, end: unit.end })))
  const found = holes(runs, covered, 1.0)
  const lostTotal = found.reduce((sum, hole) => sum + (hole.end - hole.start), 0)
  const durations = result.units.map(unit => unit.end - unit.start).sort((a, b) => a - b)
  const median = durations[Math.floor(durations.length / 2)]

  console.log(`入力ユニット      : ${raw.units.length}`)
  console.log(`出力キュー        : ${result.units.length}`)
  console.log(`発話合計          : ${speechTotal.toFixed(1)}秒 (${runs.length}ラン)`)
  console.log(`無字幕の発話(>=1秒): ${lostTotal.toFixed(1)}秒 (${found.length}箇所)`)
  console.log(`  最大の欠損      : ${found.length ? Math.max(...found.map(h => h.end - h.start)).toFixed(1) : 0}秒`)
  console.log(`無音上の字幕      : ${onSilenceSec(runs, covered).toFixed(1)}秒`)
  console.log(`キュー尺の中央値  : ${median.toFixed(2)}秒`)
  console.log(`7秒超のキュー     : ${durations.filter(d => d > 7).length}件`)
  console.log(`最長キュー        : ${durations[durations.length - 1].toFixed(1)}秒`)
  if ('coverageSplits' in result) {
    console.log(`カバレッジ修復分割: ${(result as { coverageSplits: number }).coverageSplits}件`)
  }
  if (process.env.HOLES_JSON) {
    writeFileSync(process.env.HOLES_JSON, JSON.stringify(found), 'utf-8')
  }
  console.log('')
  console.log('欠損の大きい順 上位10:')
  for (const hole of [...found].sort((a, b) => (b.end - b.start) - (a.end - a.start)).slice(0, 10)) {
    console.log(`  [${hole.start.toFixed(1)}-${hole.end.toFixed(1)}] ${(hole.end - hole.start).toFixed(1)}秒`)
  }
}

main()
