import type { BlockMetrics, EnBlock, JaBlock, PipelineThresholds, ViolationCode } from './blockTypes'
import { countCpsChars } from '../subtitleMetrics'

export function computeMetrics(
  block: Pick<JaBlock, 'start' | 'end' | 'jaChars' | 'alignConf' | 'merged'> &
    Partial<Pick<EnBlock, 'enText' | 'enRaw' | 'enChars' | 'cps' | 'maxLineLen'>>,
): BlockMetrics {
  const duration = Math.max(0.001, Number(block.end) - Number(block.start))
  const renderedText = block.enText ?? block.enRaw ?? ''
  const lines = renderedText.split('\n').filter((line) => line.length > 0)
  const hasRenderedText = renderedText.length > 0
  const enChars = hasRenderedText
    ? countCpsChars(renderedText)
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
  // en/ja 比（enJaRatio）はここでは違反判定に使わない。実測（117分・923キュー、閾値は
  // CPS>18 / 行長>75 / 比>1.5）で比の中央値は 2.21 だった。日英翻訳は文字数が2倍強になるのが
  // 標準のため、閾値1.5では9割のブロックが該当してしまい検知として機能しない。
  // また比が先にマッチすることで CPS 内・行長超過の 21件がすべて 'verbose_en' の裏に隠れ、
  // line_length_only として一度も出力されていなかった。視聴者が実際に経験する制約は
  // CPS（読める速さ）と行長（画面に収まるか）であり、比は「翻訳が冗長かもしれない」という
  // 推測に過ぎない。そのため比による判定はやめ、CPS 超過を独立コード cps_over として返す。
  // 比は診断値として computeMetrics には残し、over_compressed（比が小さすぎる＝訳し落とし）
  // の判定とレビュー表示（reviewDiagnostics の verbose-ratio 項目）では引き続き使う。
  if (metrics.cps > thresholds.verboseCps) {
    return 'cps_over'
  }
  if (metrics.maxLineLen > thresholds.maxLineLen) return 'line_length_only'
  if (metrics.cps < thresholds.slowCps && metrics.enJaRatio >= thresholds.overCompressedRatio) {
    return 'slow_speech'
  }
  return 'ok'
}
