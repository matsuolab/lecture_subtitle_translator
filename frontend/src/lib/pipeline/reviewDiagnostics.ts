import type {
  PipelineReviewDisposition,
  PipelineReviewItem,
  PipelineReviewPriority,
} from '@/types/pipeline'
import type { EnBlock } from './blockTypes'
import type { PipelineThresholds } from './blockTypes'
import { computeMetrics } from './metrics'
import {
  DEFAULT_LANGUAGE_PROFILE_CONFIG,
  hasContinuationEnd,
  type LanguageProfileConfig,
  type LanguageRoleProfile,
} from './languageProfileConfig'

function round1(value: number): string {
  return value.toFixed(1)
}

function lineLengths(text: string): number[] {
  return text.split('\n').map(line => line.length)
}

function compactText(text: string): string {
  return text.replace(/\s/g, '')
}

// transcript（元言語）が継続を示す記号（既定では読点）で終わるか。言語プロファイルの
// continuationEndPattern で判定する（既定構成 [、,]$ では従来の正規表現とバイト等価）。
function endsWithSourceContinuation(text: string, transcript: LanguageRoleProfile): boolean {
  return hasContinuationEnd(text, transcript)
}

// 出力字幕がラテン文字系のときのみ意味を持つ「文脈依存の断片」検出。
// 非ラテン構成では誤検出を避けるため適用しない（subtitle.script でゲート）。
function isContextDependentSubtitle(text: string, subtitle: LanguageRoleProfile): boolean {
  if (subtitle.script !== 'latin') return false
  const normalized = text.trim().replace(/\s+/g, ' ')
  return /^[a-z]/.test(normalized)
    || /^(This|That|It|These|Then|Also|Conversely|Especially|Using|In that case)\b/i.test(normalized)
    || (!/[.!?]$/.test(normalized) && compactText(normalized).length <= 55)
}

function isLikelyUnderTranslated(
  block: EnBlock,
  metrics: ReturnType<typeof computeMetrics>,
  languages: LanguageProfileConfig,
): boolean {
  return metrics.jaChars >= 45
    && (
      metrics.enJaRatio < 0.8
      || metrics.enChars <= 55
      || endsWithSourceContinuation(block.jaText, languages.transcript)
    )
}

function isLikelyFragment(block: EnBlock, languages: LanguageProfileConfig): boolean {
  const en = block.enText.trim().replace(/\s+/g, ' ')
  if (compactText(en).length === 0) return false
  return compactText(en).length <= 55
    && (isContextDependentSubtitle(en, languages.subtitle) || endsWithSourceContinuation(block.jaText, languages.transcript))
}

function hasKeepDecisionFromContextMerge(block: EnBlock): boolean {
  return (block.correctionAttempts ?? []).some((attempt) =>
    attempt.strategy === 'merge_window' &&
    !attempt.changed &&
    typeof attempt.rationale === 'string' &&
    !attempt.rationale.startsWith('context merge rejected')
  )
}

function shouldReportVerboseRatio(metrics: ReturnType<typeof computeMetrics>, thresholds: PipelineThresholds): boolean {
  if (metrics.enJaRatio <= thresholds.verboseEnRatio) return false
  const clearlyVerbose = metrics.enJaRatio >= thresholds.verboseEnRatio * 1.5 && metrics.enChars >= 80
  const nearCpsLimit = metrics.cps >= thresholds.verboseCps * 0.95
  return clearlyVerbose || nearCpsLimit
}

function violationTitle(violation: EnBlock['violation']): { title: string; action: string } {
  switch (violation) {
    case 'cps_over':
      return { title: '読み速度(CPS)が上限を超えています', action: '短縮するか、表示時間を延ばせるか確認してください' }
    case 'line_length_only':
      return { title: '1行の文字数が長すぎます', action: '改行位置、短縮、または分割を確認してください' }
    case 'long_segment':
    case 'merged_long':
      return { title: '1画面の表示時間が長めです', action: '意味の切れ目で分割できるか確認してください' }
    case 'short_duration':
      return { title: '表示時間が短すぎます', action: '前後の字幕と結合するか、時間を広げてください' }
    case 'over_compressed':
      return { title: '訳が短すぎる可能性があります', action: '重要語や条件が落ちていないか確認してください' }
    case 'proportional_ts':
      return { title: 'タイムスタンプが比例配分です', action: '音声との同期を確認してください' }
    default:
      return { title: '内容確認が必要です', action: '字幕内容を確認してください' }
  }
}

function priorityWeight(priority: PipelineReviewPriority): number {
  if (priority === 'must_review') return 3
  if (priority === 'should_review') return 2
  return 1
}

function dispositionWeight(disposition: PipelineReviewDisposition | undefined): number {
  if (disposition === 'manual_review') return 4
  if (disposition === 'proposed') return 3
  if (disposition === 'auto_applied') return 2
  return 1
}

function hasAutoCorrectionEvidence(block: EnBlock): boolean {
  const meta = block as EnBlock & {
    splitDepth?: number
    splitFrom?: number
    correctionStrategy?: string
  }
  return (block.compressCount ?? 0) > 0
    || (block.expandCount ?? 0) > 0
    || (meta.splitDepth ?? 0) > 0
    || meta.splitFrom !== undefined
    || Boolean(meta.correctionStrategy)
}

function baseItem(
  block: EnBlock,
  suffix: string,
  item: Omit<PipelineReviewItem, 'id' | 'blockId' | 'score'> & { score?: number },
): PipelineReviewItem {
  return {
    id: `${suffix}-${block.id}`,
    blockId: block.id,
    score: item.score ?? block.cps,
    ...item,
  }
}

export function buildReviewItemsForBlock(
  block: EnBlock,
  thresholds: PipelineThresholds,
  languages: LanguageProfileConfig = DEFAULT_LANGUAGE_PROFILE_CONFIG,
): PipelineReviewItem[] {
  const metrics = computeMetrics(block)
  const items: PipelineReviewItem[] = []

  if (metrics.duration < thresholds.shortDurationSec) {
    items.push(baseItem(block, 'short-duration', {
      nodeId: 'subtitleReview',
      reason: 'short_duration',
      category: 'timing',
      priority: 'must_review',
      disposition: 'manual_review',
      title: '表示時間が短すぎます',
      action: '前後の字幕と結合するか、時間を広げてください',
      details: [
        `${round1(metrics.duration)}秒 / 最低 ${round1(thresholds.shortDurationSec)}秒`,
        `CPS ${round1(metrics.cps)} / 上限 ${round1(thresholds.verboseCps)}`,
      ],
      attempts: block.correctionAttempts,
    }))
  }

  if (isLikelyUnderTranslated(block, metrics, languages)) {
    items.push(baseItem(block, 'under-translated', {
      nodeId: 'subtitleReview',
      reason: 'under_translated_or_over_simplified',
      category: 'content',
      priority: 'should_review',
      disposition: 'proposed',
      title: '訳が短すぎる可能性があります',
      action: '前後の字幕を含めた再分割・再翻訳案を確認してください',
      details: [
        `日本語 ${metrics.jaChars}字 / 英語 ${metrics.enChars}字`,
        `英日文字比 ${round1(metrics.enJaRatio)}`,
      ],
      proposal: {
        kind: 'merge_window',
        confidence: 0.58,
        rationale: '単体ブロックの短縮・分割では、授業の前置きや対象語が落ちたままになる可能性があるため',
      },
      attempts: block.correctionAttempts,
    }))
  }

  if (isLikelyFragment(block, languages) && !hasKeepDecisionFromContextMerge(block)) {
    items.push(baseItem(block, 'fragment', {
      nodeId: 'subtitleReview',
      reason: 'context_dependent_fragment',
      category: 'content',
      priority: 'should_review',
      disposition: 'proposed',
      title: '文脈依存の短い断片です',
      action: '前後の字幕を含めて再分割する案を確認してください',
      details: [
        block.enText.trim().replace(/\s+/g, ' '),
      ],
      proposal: {
        kind: 'merge_window',
        confidence: 0.62,
        rationale: '単独では授業文脈や係り先が不足し、前後とまとめたほうが自然な字幕になりやすいため',
      },
      attempts: block.correctionAttempts,
    }))
  }

  if (metrics.cps > thresholds.verboseCps) {
    const over = metrics.cps / thresholds.verboseCps
    const severe = over >= 1.35
    items.push(baseItem(block, 'cps', {
      nodeId: 'subtitleReview',
      reason: 'cps_over_limit',
      category: 'readability',
      priority: severe ? 'must_review' : 'should_review',
      disposition: 'proposed',
      title: '読む速度が速すぎます',
      action: severe ? '修正案を確認し、分割または短縮を承認してください' : '短縮案を確認して承認できます',
      details: [
        `CPS ${round1(metrics.cps)} / 上限 ${round1(thresholds.verboseCps)}`,
        `${metrics.enChars}文字 / ${round1(metrics.duration)}秒`,
      ],
      attempts: block.correctionAttempts,
      proposal: {
        kind: severe ? 'split_block' : 'replace_text',
        confidence: severe ? 0.72 : 0.64,
        rationale: severe
          ? '速度超過が大きく、文を短くするだけでは不十分な可能性が高いため'
          : '文意を保った短縮で読みやすさを改善できる可能性があるため',
      },
    }))
  }

  // 比が高いことは classifyViolation 上は違反ではなくなった（cps_over に分離済み）が、
  // レビュー時の参考ヒントとしては残したいため、violation への依存はやめて
  // metrics 由来の値だけで判定する。
  if (metrics.cps <= thresholds.verboseCps && shouldReportVerboseRatio(metrics, thresholds)) {
    items.push(baseItem(block, 'verbose-ratio', {
      nodeId: 'subtitleReview',
      reason: 'verbose_ratio_over_limit',
      category: 'readability',
      priority: 'should_review',
      disposition: 'proposed',
      title: '英文が長すぎる可能性があります',
      action: 'CPSは上限内です。英日比が高いため、冗長表現の短縮案を確認してください',
      details: [
        `CPS ${round1(metrics.cps)} / 上限 ${round1(thresholds.verboseCps)}`,
        `英日文字比 ${round1(metrics.enJaRatio)} / 上限 ${round1(thresholds.verboseEnRatio)}`,
      ],
      attempts: block.correctionAttempts,
      proposal: {
        kind: 'replace_text',
        confidence: 0.6,
        rationale: '読む速度ではなく、元の日本語に対して英文が相対的に長い可能性があるため',
      },
    }))
  }

  if (metrics.maxLineLen > thresholds.maxLineLen) {
    const lengths = lineLengths(block.enText)
    const over = metrics.maxLineLen / thresholds.maxLineLen
    const severe = over >= 1.5
    items.push(baseItem(block, 'line-length', {
      nodeId: 'subtitleReview',
      reason: 'line_length_over_limit',
      category: 'line_length',
      priority: severe ? 'must_review' : 'should_review',
      disposition: 'proposed',
      title: '1行の文字数が長すぎます',
      action: severe ? '分割案または短縮案を確認して承認してください' : '改行位置または短縮案を確認できます',
      details: [
        `最長 ${metrics.maxLineLen}文字 / 上限 ${thresholds.maxLineLen}文字`,
        `行長: ${lengths.join(' / ')}`,
      ],
      attempts: block.correctionAttempts,
      proposal: {
        kind: severe ? 'split_block' : 'replace_text',
        confidence: severe ? 0.7 : 0.62,
        rationale: severe
          ? '1行が長すぎ、改行だけでは画面内の読みやすさを保ちにくいため'
          : '短縮または改行位置の変更で制限内に収まる可能性があるため',
      },
    }))
  }

  if (metrics.duration > thresholds.longDurationSec) {
    const severe = metrics.duration > thresholds.longDurationSec * 1.5
    items.push(baseItem(block, 'long-segment', {
      nodeId: 'subtitleReview',
      reason: 'long_segment',
      category: 'timing',
      priority: severe ? 'must_review' : 'should_review',
      disposition: 'proposed',
      title: '1画面の表示時間が長めです',
      action: '意味の切れ目での分割案を確認してください',
      details: [
        `${round1(metrics.duration)}秒 / 目安 ${round1(thresholds.longDurationSec)}秒`,
      ],
      attempts: block.correctionAttempts,
      proposal: {
        kind: 'split_block',
        confidence: severe ? 0.68 : 0.55,
        rationale: '長い表示時間は文のまとまりを保ったまま複数画面に分けられる可能性があるため',
      },
    }))
  }

  if (block.violation === 'over_compressed') {
    items.push(baseItem(block, 'over-compressed', {
      nodeId: 'subtitleReview',
      reason: 'over_compressed',
      category: 'content',
      priority: 'should_review',
      disposition: 'manual_review',
      title: '訳が短すぎる可能性があります',
      action: '重要語や条件が落ちていないか確認してください',
      details: [
        `英日文字比 ${round1(metrics.enJaRatio)}`,
      ],
      attempts: block.correctionAttempts,
    }))
  }

  if (block.violation === 'proportional_ts') {
    items.push(baseItem(block, 'proportional-ts', {
      nodeId: 'subtitleReview',
      reason: 'proportional_ts',
      category: 'metadata',
      priority: 'should_review',
      disposition: 'proposed',
      title: 'タイムスタンプが比例配分です',
      action: '音声に合わせた再配置案を確認してください',
      details: ['word timestamp ではなく文字数比で時刻が付いています'],
      attempts: block.correctionAttempts,
      proposal: {
        kind: 'retime',
        confidence: 0.5,
        rationale: '文字数比の時刻は音声境界とずれる可能性があるため',
      },
    }))
  }

  if (
    items.length === 0 &&
    block.violation !== 'ok' &&
    block.violation !== 'slow_speech' &&
    block.violation !== 'cps_over'
  ) {
    const fallback = violationTitle(block.violation)
    items.push(baseItem(block, `violation-${block.violation}`, {
      nodeId: 'subtitleReview',
      reason: block.violation,
      category: 'metadata',
      priority: 'should_review',
      disposition: 'manual_review',
      title: fallback.title,
      action: fallback.action,
      attempts: block.correctionAttempts,
    }))
  }

  if (items.length === 0 && hasAutoCorrectionEvidence(block)) {
    items.push(baseItem(block, 'auto-applied', {
      nodeId: 'subtitleReview',
      reason: 'auto_applied',
      category: 'metadata',
      priority: 'auto_pass',
      disposition: 'auto_applied',
      title: '自動修正済み',
      action: '大きな問題がなければ承認できます',
      details: [
        `短縮 ${block.compressCount ?? 0}回`,
        `展開 ${block.expandCount ?? 0}回`,
      ],
      attempts: block.correctionAttempts,
      score: metrics.cps,
    }))
  }

  return items
}

/**
 * エディタの「要確認」バッジに出してよいレビュー理由。
 * 翻訳者へ常時見せるのは、自動補正で解消できなかった「測定可能な形式違反」と、
 * 決定論的に検出された翻訳失敗（未訳）のみに限定する。
 * under_translated / context_dependent_fragment / over_compressed / 比率のみ verbose /
 * proportional_ts などの「意味・傾向の推測」は誤検出で信頼を損なうため除外し、
 * ReportTab 診断側にのみ残す（CONTEXT.md「意味・翻訳傾向の修正は human-in-the-loop」）。
 */
const EDITOR_BADGE_REASONS = new Set<string>([
  'short_duration',
  'long_segment',
  'merged_long',
  'cps_over_limit',
  'line_length_over_limit',
  'untranslated',
])

export function isEditorBadgeReason(reason: string): boolean {
  return EDITOR_BADGE_REASONS.has(reason)
}

/**
 * エディタバッジ用に、コア形式違反（＋未訳）だけを要約する。
 * 該当が無ければ null（＝バッジを出さない）。具体数値（details の先頭）を要約に含める。
 */
export function summarizeFormViolationBadge(items: PipelineReviewItem[]): {
  priority: PipelineReviewPriority
  disposition: PipelineReviewDisposition
  summary: string
  action: string
} | null {
  const formItems = items.filter((item) => isEditorBadgeReason(item.reason))
  if (formItems.length === 0) return null
  const sorted = [...formItems].sort((a, b) => priorityWeight(b.priority) - priorityWeight(a.priority))
  const primary = sorted[0]
  const extra = sorted.length > 1 ? ` ほか${sorted.length - 1}件` : ''
  const detail = primary.details?.[0] ? `（${primary.details[0]}）` : ''
  return {
    priority: primary.priority,
    disposition: 'manual_review',
    summary: `${primary.title ?? primary.reason}${detail}${extra}`,
    action: primary.action ?? '字幕の形式を確認してください',
  }
}

export function summarizeReviewItems(items: PipelineReviewItem[]): {
  priority: PipelineReviewPriority
  disposition: PipelineReviewDisposition
  summary: string
  action: string
} {
  if (items.length === 0) {
    return {
      priority: 'auto_pass',
      disposition: 'auto_pass',
      summary: '自動チェックで大きな問題は見つかっていません',
      action: '内容を確認して承認できます',
    }
  }

  const sorted = [...items].sort((a, b) => {
    const dispositionDiff = dispositionWeight(b.disposition) - dispositionWeight(a.disposition)
    if (dispositionDiff !== 0) return dispositionDiff
    return priorityWeight(b.priority) - priorityWeight(a.priority)
  })
  const primary = sorted[0]
  const extra = sorted.length > 1 ? ` ほか${sorted.length - 1}件` : ''
  return {
    priority: primary.priority,
    disposition: primary.disposition ?? (primary.priority === 'auto_pass' ? 'auto_pass' : 'manual_review'),
    summary: `${primary.title ?? primary.reason}${extra}`,
    action: primary.action ?? '字幕内容を確認してください',
  }
}
