import fs from 'node:fs'
import type { Constraints, StyleExample } from './schema.js'
import { visibleLength } from './lineFormat.js'

interface ProjectBlock {
  id?: number | string
  startTime?: number
  endTime?: number
  source?: string
  target?: string
}

interface ProjectFile {
  blocks?: ProjectBlock[]
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}

function normalizeText(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim()
}

function lineMetrics(en: string): { line_count: number; max_line_len: number } {
  const lines = normalizeText(en).split('\n').map((line) => line.trim()).filter(Boolean)
  return {
    line_count: lines.length || 1,
    max_line_len: lines.reduce((max, line) => Math.max(max, visibleLength(line)), 0),
  }
}

export function loadStyleExamples(pathname: string | null, constraints: Constraints, limit = 12): StyleExample[] {
  if (!pathname || !fs.existsSync(pathname)) return []
  const parsed = JSON.parse(fs.readFileSync(pathname, 'utf8')) as ProjectFile
  const blocks = Array.isArray(parsed.blocks) ? parsed.blocks : []
  const examples = blocks.flatMap((block): StyleExample[] => {
    const ja = normalizeText(String(block.target ?? ''))
    const en = normalizeText(String(block.source ?? ''))
    const start = Number(block.startTime)
    const end = Number(block.endTime)
    if (!ja || !en || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return []
    const duration = end - start
    const enChars = visibleLength(en)
    const capacity = Math.max(1, Math.floor(Math.min(constraints.max_segment_chars, duration * constraints.max_cps)))
    const metrics = lineMetrics(en)
    const example: StyleExample = {
      id: String(block.id ?? `${start}-${end}`),
      ja,
      en,
      duration: round(duration),
      en_chars: enChars,
      cps: round(enChars / Math.max(0.001, duration)),
      capacity_chars: capacity,
      utilization: round(enChars / capacity),
      line_count: metrics.line_count,
      max_line_len: metrics.max_line_len,
    }
    return [example]
  })
  return examples
    .filter((example) => example.duration >= 2 && example.duration <= Math.max(12, constraints.max_duration + 5))
    .filter((example) => example.en_chars >= 25)
    .filter((example) => example.max_line_len <= constraints.max_chars_per_line + 35)
    .filter((example) => example.cps <= constraints.max_cps)
    .filter((example) => example.utilization >= 0.35 && example.utilization <= 1.05)
    .sort((a, b) => {
      const aScore = Math.abs(a.utilization - 0.72) + Math.abs(a.duration - 5) * 0.03
      const bScore = Math.abs(b.utilization - 0.72) + Math.abs(b.duration - 5) * 0.03
      return aScore - bScore
    })
    .slice(0, limit)
}

export function compactStyleExamples(examples: StyleExample[]): Array<Record<string, unknown>> {
  return examples.map((example) => ({
    id: example.id,
    ja: example.ja,
    en: example.en,
    duration: example.duration,
    en_chars: example.en_chars,
    cps: example.cps,
    utilization: example.utilization,
    line_count: example.line_count,
    max_line_len: example.max_line_len,
  }))
}
