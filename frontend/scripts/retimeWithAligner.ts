/**
 * WhisperX 生JSON + プロジェクトJSON から、新実装のdiffベース大域アライナ
 * (`buildAsrCharStream` + `alignCuesToAsr`) で各ブロックの時刻を再計算し、
 * `scripts/timing_probe/compare_timings.py --spans` が読める形式で出力する。
 *
 * 使い方:
 *   cd frontend && npx tsx scripts/retimeWithAligner.ts \
 *     <whisperx_raw.json> <project.json> <出力先.json>
 */
import { readFileSync, writeFileSync } from 'node:fs'

import { alignCuesToAsr, buildAsrCharStream, type AlignedSpan } from '../src/lib/pipeline/asrAlignment'
import type { TranscriptSegment, WordTimestamp } from '../src/lib/pipeline/types'

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

interface ProjectBlock {
  id: number
  transcript?: string
}

interface ProjectJson {
  blocks: ProjectBlock[]
}

interface RetimedSpan {
  id: number
  startSec: number
  endSec: number
  confidence: AlignedSpan['confidence']
  matchRate: number
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000
}

function isFiniteWord(word: WhisperXRawWord): word is WhisperXRawWord & { start: number; end: number } {
  return typeof word.start === 'number' && Number.isFinite(word.start) && typeof word.end === 'number' && Number.isFinite(word.end)
}

function toWordTimestamp(word: WhisperXRawWord & { start: number; end: number }): WordTimestamp {
  return {
    word: word.word,
    start: word.start,
    end: word.end,
    score: word.score,
  }
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

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf-8')) as T
}

function parseArgs(argv: readonly string[]): { whisperxPath: string; projectPath: string; outPath: string } {
  const [whisperxPath, projectPath, outPath] = argv
  if (!whisperxPath || !projectPath || !outPath) {
    throw new Error('Usage: retimeWithAligner.ts <whisperx_raw.json> <project.json> <out.json>')
  }
  return { whisperxPath, projectPath, outPath }
}

function summarizeConfidence(spans: readonly RetimedSpan[]): Record<AlignedSpan['confidence'], number> {
  const summary: Record<AlignedSpan['confidence'], number> = { exact: 0, partial: 0, interpolated: 0 }
  for (const span of spans) {
    summary[span.confidence] += 1
  }
  return summary
}

function main(): void {
  const { whisperxPath, projectPath, outPath } = parseArgs(process.argv.slice(2))

  const raw = readJson<WhisperXRaw>(whisperxPath)
  const project = readJson<ProjectJson>(projectPath)

  const segments = toTranscriptSegments(raw)
  const asr = buildAsrCharStream(segments)

  const cueTexts = project.blocks.map(block => block.transcript ?? '')
  const aligned = alignCuesToAsr(cueTexts, asr)

  const spans: RetimedSpan[] = project.blocks.map((block, index) => {
    const span = aligned[index]
    return {
      id: block.id,
      startSec: round3(span.startSec),
      endSec: round3(span.endSec),
      confidence: span.confidence,
      matchRate: round3(span.matchRate),
    }
  })

  writeFileSync(outPath, JSON.stringify(spans, null, 2), 'utf-8')

  const summary = summarizeConfidence(spans)
  console.log(
    `retimed ${spans.length} blocks -> ${outPath} ` +
      `(exact=${summary.exact}, partial=${summary.partial}, interpolated=${summary.interpolated})`,
  )
}

main()
