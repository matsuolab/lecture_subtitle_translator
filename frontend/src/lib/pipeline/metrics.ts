import type { BlockMetrics, EnBlock, JaBlock, PipelineThresholds, ViolationCode } from './blockTypes'

export function computeMetrics(
  block: Pick<JaBlock, 'start' | 'end' | 'jaChars' | 'alignConf' | 'merged'> &
    Partial<Pick<EnBlock, 'enText' | 'enRaw' | 'enChars' | 'cps' | 'maxLineLen'>>,
): BlockMetrics {
  const duration = Math.max(0.001, Number(block.end) - Number(block.start))
  const renderedText = block.enText ?? block.enRaw ?? ''
  const lines = renderedText.split('\n').filter((line) => line.length > 0)
  const hasRenderedText = renderedText.length > 0
  const enChars = hasRenderedText
    ? renderedText.replace(/\n/g, '').length
    : block.enChars ?? 0
  const maxLineLen = hasRenderedText
    ? Math.max(0, ...lines.map((line) => line.length))
    : block.maxLineLen ?? 0
  const cps = enChars / duration
  return {
    duration,
    jaChars: block.jaChars,
    enChars,
    enJaRatio: block.jaChars > 0 ? enChars / block.jaChars : 0,
    cps,
    maxLineLen,
  }
}

export function classifyViolation(
  block: Pick<JaBlock, 'alignConf' | 'merged' | 'jaChars'> &
    Partial<Pick<EnBlock, 'enText' | 'enRaw' | 'enChars' | 'cps' | 'maxLineLen'>> &
    Pick<JaBlock, 'start' | 'end'>,
  thresholds: PipelineThresholds,
): ViolationCode {
  const metrics = computeMetrics(block)

  if (block.alignConf === 'proportional' || block.alignConf === 'no_words') return 'proportional_ts'
  if (metrics.duration < thresholds.shortDurationSec) return 'short_duration'
  if (block.merged && metrics.duration > thresholds.mergedLongDurationSec) return 'merged_long'
  if (metrics.duration > thresholds.longDurationSec) return 'long_segment'
  if (
    metrics.enJaRatio < thresholds.overCompressedRatio &&
    metrics.cps < thresholds.slowCps &&
    metrics.jaChars > thresholds.overCompressedJaChars
  ) {
    return 'over_compressed'
  }
  if (metrics.enJaRatio > thresholds.verboseEnRatio || metrics.cps > thresholds.verboseCps) {
    return 'verbose_en'
  }
  if (metrics.maxLineLen > thresholds.maxLineLen) return 'line_length_only'
  if (metrics.cps < thresholds.slowCps && metrics.enJaRatio >= thresholds.overCompressedRatio) {
    return 'slow_speech'
  }
  return 'ok'
}
