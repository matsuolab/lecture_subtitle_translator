import type { AdminSettings } from '@/types/adminSettings'
import type { EnBlock, PipelineThresholds } from '../../blockTypes'
import { normalizeSpaces } from '../../textUtils'
import { resolveTranslateModelId } from '../../prompts'
import { loadLanguageProfileConfig, type LanguageScript, type LanguageProfileConfig } from '../../languageProfileConfig'
import { formatLines } from '../../formatLines'
import { computeMetrics } from '../../metrics'
import { requireChatModelForProvider } from '../../aiProvider'
import type { AgentThresholds, DecisionContext, TimelinePatch, Tool } from '../types'
import { countCpsChars } from '@/lib/subtitleMetrics'
import { buildMetrics } from '../metrics'
import { parseJsonObjectFromLlmContent } from '../../jsonResponse'
import { llmCallWithMeta } from '../../llmCallWithMeta'
import { checkSeamOnlySplit } from '../../seamOnlySplitCheck'
import { callSubtitleLlm } from './callSubtitleLlm'
import { allocateSplitTiming } from './splitTimingAllocator'
import { withCueSourceRelation } from '@/types/sourceEvidence'

interface SplitResult {
  units: SplitUnit[]
  warning?: string  // LLM が期待形式を返さなかった場合に診断情報を含む
}

interface SplitUnit {
  text: string
  reason?: string
  confidence?: number
}

function fallbackSplitJa(jaText: string): SplitResult | null {
  // 句点・読点・接続表現の近くで分割を試みる
  const sentenceEnd = /[。！？、]|(?:について|として|ために|踏まえて|また|そして|ただし|一方で)/g
  let match: RegExpExecArray | null
  const candidates: number[] = []
  while ((match = sentenceEnd.exec(jaText)) !== null) {
    const pos = match.index + match[0].length
    if (pos > 0 && pos < jaText.length) candidates.push(pos)
  }

  // 中央に最も近い分割位置を選ぶ
  const half = jaText.length / 2
  let bestPos = -1
  let bestDist = Infinity
  for (const pos of candidates) {
    if (pos > 0 && pos < jaText.length) {
      const dist = Math.abs(pos - half)
      if (dist < bestDist) {
        bestDist = dist
        bestPos = pos
      }
    }
  }

  if (bestPos === -1) return null

  const first = normalizeJaSplitUnit(jaText.slice(0, bestPos))
  const second = normalizeJaSplitUnit(jaText.slice(bestPos))
  if (!first || !second) return null

  return {
    units: [
      { text: first, reason: 'semantic_boundary_fallback' },
      { text: second, reason: 'semantic_boundary_fallback' },
    ],
  }
}

function normalizeJaSplitUnit(text: string): string {
  return normalizeSpaces(text)
    .replace(/[、,]\s*$/g, '')
    .trim()
}

function normalizeJaUnit(text: string): string {
  return normalizeSpaces(text).replace(/\s/g, '')
}

/**
 * 日本語テキストが文の途中で終わっているか（助詞・接続・読点で終わる）。
 * scripts/auditOutput.ts も同じ判定を使うため export している。判定を二重実装すると
 * 監査結果と実際の挙動がずれるので、必ずこれを使うこと。
 */
export function endsWithIncompleteJapanese(text: string): boolean {
  const normalized = normalizeJaUnit(text)
  return /([、,]|の|と|を|に|が|は|で|て|から|ため|として|について|には|では|ので|し|か|点で)$/.test(normalized)
}

// exemptTrailingParticle: true の場合、「末尾が助詞・接続で終わっていないか」の判定を免除する。
// 最小文字数（6文字未満）の判定は免除しない — 短すぎる断片は分割そのものが生んだ問題であり、
// 入力が不完全だったかどうかとは無関係に弾くべきなため。
function isBadJapaneseUnit(text: string, opts: { exemptTrailingParticle?: boolean } = {}): boolean {
  const normalized = normalizeJaUnit(text)
  if (normalized.length < 6) return true
  if (opts.exemptTrailingParticle) return false
  return endsWithIncompleteJapanese(normalized)
}

// isBadJapaneseUnit は末尾しか見ていないため、「ということを紹介したいと思います。」のように
// 継ぎ目の言い切り修正としては正しくても、2個目以降のユニットが接続表現で始まって
// 前のユニットに文脈依存する断片になるケースを捕捉できない。過剰に弾かないよう、
// 計測中に実際に見つかった3パターンに限定した独立の判定として実装する。
const CONNECTIVE_UNIT_START_PATTERNS = ['という', 'といった', 'ということ'] as const

function startsWithConnectiveExpression(text: string): boolean {
  const normalized = normalizeJaUnit(text)
  return CONNECTIVE_UNIT_START_PATTERNS.some((pattern) => normalized.startsWith(pattern))
}

function isBadEnglishUnit(text: string): boolean {
  const normalized = normalizeSpaces(text).replace(/\n/g, ' ')
  if (normalized.replace(/\s/g, '').length < 8) return true
  if (/^[a-z]/.test(normalized)) return true
  return /^(This|That|It|These|There is\.?|There are\.?|In that case,?|In the case of|Each one|Means)\.?$/i.test(normalized)
}

/**
 * 「単独の字幕単位として成立しないテキストか」を、そのテキストの言語で判定する。
 *
 * この判定はロール（書きおこし／字幕）ではなく **言語** に依存する。
 * 既定構成（書きおこし=日本語 / 字幕=英語）では、従来の
 * isBadJapaneseUnit(unit) / isBadEnglishUnit(translation) と同じ組み合わせになる。
 * 英→日構成ではそれぞれ入れ替わり、短い日本語字幕が英語基準（8文字未満）で
 * 誤って却下される問題を防ぐ。
 */
function isBadUnitForScript(
  text: string,
  script: LanguageScript,
  opts: { exemptTrailingParticle?: boolean } = {},
): boolean {
  if (script === 'japanese') return isBadJapaneseUnit(text, opts)
  if (script === 'latin') return isBadEnglishUnit(text)
  // generic: 言語固有の作法が不明なため、極端に短いものだけ却下する。
  return normalizeSpaces(text).replace(/\s/g, '').length < 6
}

function confidenceOf(unit: SplitUnit): number {
  return typeof unit.confidence === 'number' && Number.isFinite(unit.confidence)
    ? unit.confidence
    : 1
}

function sanitizeUnits(units: SplitUnit[]): SplitUnit[] {
  return units
    .map((unit) => ({
      ...unit,
      text: normalizeSpaces(unit.text ?? ''),
    }))
    .filter((unit) => unit.text.length > 0)
    .slice(0, 3)
}

function parseSplitUnits(content: string): { units: SplitUnit[]; warning?: string } {
  let parsed: Record<string, unknown> = {}
  try {
    parsed = parseJsonObjectFromLlmContent(content, 'split_block')
  } catch {
    return { units: [], warning: content ? `LLM returned invalid JSON: ${content.slice(0, 400)}` : 'LLM returned empty content' }
  }

  if (parsed.cannot_split === true) {
    return { units: [], warning: 'LLM reported cannot_split' }
  }

  if (Array.isArray(parsed.units)) {
    const units = parsed.units
      .map((item): SplitUnit | null => {
        if (typeof item === 'string') return { text: item }
        if (!item || typeof item !== 'object') return null
        const row = item as Record<string, unknown>
        const text = typeof row.text === 'string' ? row.text : ''
        return {
          text,
          reason: typeof row.reason === 'string' ? row.reason : undefined,
          confidence: typeof row.confidence === 'number' ? row.confidence : undefined,
        }
      })
      .filter((unit): unit is SplitUnit => unit !== null)
    return {
      units: sanitizeUnits(units),
      warning: Array.isArray(parsed.warnings) && parsed.warnings.length > 0
        ? `LLM warnings: ${parsed.warnings.map(String).join('; ')}`
        : undefined,
    }
  }

  const ja1 = typeof parsed.ja1 === 'string' ? parsed.ja1.trim() : ''
  const ja2 = typeof parsed.ja2 === 'string' ? parsed.ja2.trim() : ''
  if (ja1 && ja2) {
    return { units: sanitizeUnits([{ text: ja1 }, { text: ja2 }]) }
  }

  return { units: [], warning: content ? `LLM returned unexpected format: ${content.slice(0, 400)}` : 'LLM returned empty content' }
}

// 日本語 transcript 向けの分割プロンプト。scripts/measureSeamOnlySplit.ts で実データ183件を
// 計測し、80.3%が「継ぎ目（ユニットの末尾）だけの言い切り修正」で安全に分割できることを
// 実証済み。本文の言い換え・要約・圧縮を許すと分割を拒否される率が跳ね上がるため、
// 計測時のプロンプトを一字一句そのまま使う（変更すると計測結果が効かなくなる）。
const JAPANESE_SPLIT_SYSTEM_PROMPT = `この日本語の講義書き起こしを、2〜3個の字幕単位に分割してください。

厳守事項:
- 各単位は原文の文字列をそのまま使うこと。語順の変更・言い換え・要約・語句の追加は禁止。
- 唯一許される変更は、各単位の末尾を完結した文にするための最小限の修正のみ。
  例: 「〜しておりますので、」→「〜しております。」
      「〜を理解し、」→「〜を理解します。」
- 本文の圧縮やフィラーの削除は禁止。原文の情報を落とさないこと。
- 各単位は文として完結していること（助詞や接続助詞で終わらない）。
- 安全に分割できない場合は {"cannot_split": true, "units": []} を返すこと。

出力はJSONのみ: {"units":[{"text":"..."}]}`

// 非日本語 transcript 向けの分割プロンプト。日本語版と同じ「継ぎ目のみ書き換え可」の
// 方針を英語で表現したもの（計測は日本語データでのみ行っているが、本文を書き換えさせず
// コード側の checkSeamOnlySplit で機械検査する設計自体は言語に依存しないため踏襲する）。
function buildSplitSystemPrompt(transcriptLabel: string): string {
  return (
    `Resegment this ${transcriptLabel} academic lecture transcript into 2 or 3 subtitle units. ` +
    'Each unit must reuse the source wording verbatim: no reordering, paraphrasing, summarizing, or added words. ' +
    'The only edit allowed is a minimal fix at the end of a unit so it reads as a complete sentence ' +
    '(for example, turning a trailing conjunction or connector into a period). ' +
    'Do not compress the text or drop filler; keep all information from the source. ' +
    'Each unit must be a complete sentence and must not end with a particle or conjunction. ' +
    'If the text cannot be split safely, return {"cannot_split": true, "units": []}. ' +
    'Respond only with JSON: {"units":[{"text":"..."}]}'
  )
}

// correct.ts の pickCorrectionBasePrompt と同じパターン。日本語 transcript には計測で
// 実証済みの日本語プロンプトをそのまま使い、それ以外は同じ趣旨の英語版にフォールバックする。
function pickSplitSystemPrompt(languages: LanguageProfileConfig): string {
  return languages.transcript.script === 'japanese'
    ? JAPANESE_SPLIT_SYSTEM_PROMPT
    : buildSplitSystemPrompt(languages.transcript.label)
}

async function splitJaText(
  jaText: string,
  settings: AdminSettings,
): Promise<SplitResult> {  // warning フィールドが設定される場合がある
  const model = requireChatModelForProvider(settings, settings.correctionModel || settings.translationModel, 'split block')
  const languages = loadLanguageProfileConfig(settings)

  const callResult = await llmCallWithMeta(
    {
      model,
      systemPrompt: pickSplitSystemPrompt(languages),
      userContent: jaText,
      temperature: 0.0,
      nodeName: 'split_block',
    },
    settings,
  )

  // API 失敗 → throw せず、句点ベースのフォールバックへ
  if (callResult.errorMessage) {
    const llmActual = `LLM call failed: ${callResult.errorMessage}`
    const warning = `split_block: could not use LLM units, fell back to sentence-boundary split. ${llmActual}`
    const fallback = fallbackSplitJa(jaText)
    if (fallback) return { ...fallback, warning }
    return { units: [], warning: `split_block: could not split (no sentence boundary). ${llmActual}` }
  }

  const parsed = parseSplitUnits(callResult.content)
  if (parsed.units.length > 0) return parsed

  // LLM が期待形式を返さなかった → 実レスポンスを記録して句点ベースのフォールバックへ
  const llmActual = parsed.warning ?? (callResult.content.length > 0
    ? `LLM returned: ${callResult.content.slice(0, 400)}`
    : 'LLM returned empty content')
  const warning = `split_block: could not use LLM units, fell back to sentence-boundary split. ${llmActual}`

  const fallback = fallbackSplitJa(jaText)
  if (fallback) return { ...fallback, warning }

  // フォールバックもダメ → throw せず、warning だけ返す（呼出元が cleanUnits.length<2 で拒否する）
  return { units: [], warning: `split_block: could not split (no sentence boundary). ${llmActual}` }
}

function buildSingleTranslateSystem(transcriptLabel: string, subtitleLabel: string): string {
  return (
    `Translate this ${transcriptLabel} subtitle text into natural ${subtitleLabel}. ` +
    'Keep technical terms, proper nouns, and formulas. Use casual-academic tone. Contractions are fine. ' +
    'The subtitle must make sense on its own. Do not start with This, That, It, or These when they refer to previous context. ' +
    'Repeat the noun when needed. Keep logical connectors, conditions, negations, numbers, and definitions. ' +
    'Use concise subtitle wording without adding explanations. ' +
    'Respond with JSON: {"text": "<translation>"}'
  )
}

async function translateSingle(
  jaText: string,
  settings: AdminSettings,
): Promise<{ text: string; errorMessage?: string }> {
  const model = requireChatModelForProvider(settings, resolveTranslateModelId(settings.translationModel), 'split block translation')
  const languages = loadLanguageProfileConfig(settings)
  const result = await callSubtitleLlm(
    {
      model,
      systemPrompt: buildSingleTranslateSystem(languages.transcript.label, languages.subtitle.label),
      userContent: jaText,
      temperature: 0.0,
      nodeName: 'split_block_translation',
    },
    settings,
  )
  return { text: result.text, errorMessage: result.errorMessage }
}

function buildFailurePatch(block: EnBlock, warning: string): TimelinePatch {
  return {
    replaceBlocks: [block],
    dirtyBlockIds: [String(block.id)],
    changed: false,
    warning,
  }
}

function validateSplitCandidates(
  original: EnBlock,
  candidates: EnBlock[],
  thresholds: PipelineThresholds & AgentThresholds,
): { ok: true; blocks: EnBlock[] } | { ok: false; warning: string } {
  const formatted = formatLines(candidates, thresholds)
  const originalMetrics = computeMetrics(formatLines([original], thresholds)[0])

  const invalid = formatted
    .map((block) => ({ block, metrics: computeMetrics(block) }))
    .find(({ metrics }) =>
      metrics.duration < thresholds.shortDurationSec ||
      metrics.cps > thresholds.verboseCps ||
      metrics.maxLineLen > thresholds.maxLineLen * 2
    )

  if (invalid) {
    return {
      ok: false,
      warning:
        `split_block: rejected candidate #${invalid.block.id}; ` +
        `duration=${invalid.metrics.duration.toFixed(2)}s, ` +
        `cps=${invalid.metrics.cps.toFixed(1)}, ` +
        `maxLine=${invalid.metrics.maxLineLen}`,
    }
  }

  const worstCps = Math.max(...formatted.map(block => computeMetrics(block).cps))
  const worstLine = Math.max(...formatted.map(block => computeMetrics(block).maxLineLen))
  const longestDuration = Math.max(...formatted.map(block => computeMetrics(block).duration))
  const improved =
    worstCps < originalMetrics.cps ||
    worstLine < originalMetrics.maxLineLen ||
    longestDuration < originalMetrics.duration

  if (!improved) {
    return {
      ok: false,
      warning: 'split_block: rejected candidate because it does not improve cps, line length, or duration',
    }
  }

  return { ok: true, blocks: formatted }
}

// JA テキストを安全に 2 unit 以上に分割できる最小文字数。
// これ未満は分割しても各 unit が短すぎ意味が成立しない（過去ログで「12文字 + 12文字」のような
// 短すぎ split が断片を生むケースが頻発したため、コード側でガード）。
const SPLIT_BLOCK_MIN_TRANSCRIPT_CHARS = 25

function normalizeForLengthCheck(text: string): string {
  return text.replace(/\s/g, '')
}

export const splitBlockTool: Tool = {
  name: 'split_block',
  description: 'Split Japanese into 2 semantic sentences. Re-translate each with proportional time.',

  canApply(ctx: DecisionContext): boolean {
    const m = buildMetrics(ctx, ctx.thresholds as PipelineThresholds & AgentThresholds)
    if (!m.splitViable) return false
    if (ctx.attemptHistory.some(a => a.strategy === 'split_block')) return false

    const block = ctx.block as { endsIncomplete?: boolean; jaText: string }
    const isDurationViolation =
      ctx.block.violation === 'long_segment' || ctx.block.violation === 'merged_long'

    // Phase1 detectIncompleteEnds で「末尾 mid-sentence」と判定済の場合、元々はここで
    // 一律に分割を止めていた（この種ブロックは LLM が「2 unit に分けられない」と返すのが既定で、
    // 無駄な API コールを避けつつログのノイズを減らす狙い。Day4 ログでは 305件 / 752件試行で発生）。
    // しかしこの前提はプロンプトが本文の書き換えを一切禁じていた頃のもので、継ぎ目（各ユニットの
    // 末尾）だけの言い切り修正を許した現在は成り立たない: 末尾が不完全なのは入力時点からであり、
    // 分割自体はそれを悪化させない（execute 側 checkSeamOnlySplit が継ぎ目以外の書き換えを検査する）。
    // 実際、このガードを外さないまま canApply を修復ループに繋いだ結果、実パイプライン再実行
    // （117分・839キュー）で尺違反56件中11件（最長35.1秒など、出力中で最も長い字幕群）が
    // 一度も分割を試みられなくなる退行を起こした。
    // 尺違反（long_segment/merged_long）は分割以外に手段がないため、endsIncomplete でも
    // 分割を試す。尺違反以外（cps_over/line_length_only の extreme tier）には引き続きガードを
    // 効かせる: そちらは圧縮という代替手段があり、無駄な API コールを避ける元の意図が今も有効。
    if (block.endsIncomplete === true && !isDurationViolation) return false

    // JA が短すぎる場合も同様。2 分割すると各 unit が 12 文字程度になり成立しない。
    if (normalizeForLengthCheck(block.jaText).length < SPLIT_BLOCK_MIN_TRANSCRIPT_CHARS) return false

    const isExtremeReadabilityViolation =
      (ctx.block.violation === 'cps_over' || ctx.block.violation === 'line_length_only') &&
      m.tier === 'extreme' &&
      normalizeForLengthCheck(block.jaText).length >= 45
    if (!isDurationViolation && !isExtremeReadabilityViolation) return false

    return true
  },

  async execute(
    block: EnBlock,
    _ctx: DecisionContext,
    settings: AdminSettings,
    thresholds: PipelineThresholds & AgentThresholds,
  ): Promise<TimelinePatch> {
    const { units, warning: splitWarning } = await splitJaText(block.jaText, settings)
    const cleanUnits = sanitizeUnits(units)

    if (cleanUnits.length < 2) {
      return buildFailurePatch(block, splitWarning ?? 'split_block: LLM returned fewer than 2 usable units')
    }

    const lowConfidence = cleanUnits.find(unit => confidenceOf(unit) < 0.65)
    if (lowConfidence) {
      return buildFailurePatch(block, 'split_block: rejected low-confidence split unit')
    }

    const languages = loadLanguageProfileConfig(settings)
    // 元のブロックの jaText が既に不完全な終わり方をしていた場合（助詞・接続表現で終わる等）、
    // 分割後の最後のユニットは必ず原文の末尾まで到達する（checkSeamOnlySplit が「最後のユニットが
    // tail_dropped でないこと」＝原文末尾に到達していることを保証している）。つまり最後のユニットの
    // 末尾の不完全さは分割が生んだものではなく入力から引き継いだものであり、分割を拒否しても
    // 不完全さは解消せず「長すぎる字幕が1枚残る」だけ悪化する。そのため最後のユニットに限り、
    // 「末尾が助詞・接続で終わる」判定を免除する（最小文字数の判定は免除しない）。
    // 最後のユニット以外は従来どおり全ての判定を適用する。
    const originalWasIncomplete = endsWithIncompleteJapanese(block.jaText)
    const badSource = cleanUnits.find((unit, index) => {
      const isLastUnit = index === cleanUnits.length - 1
      return isBadUnitForScript(unit.text, languages.transcript.script, {
        exemptTrailingParticle: isLastUnit && originalWasIncomplete,
      })
    })
    if (badSource) {
      return buildFailurePatch(
        block,
        `split_block: rejected incomplete or too-short ${languages.transcript.label} unit: ${badSource.text}`,
      )
    }

    // 2個目以降のユニットが接続表現で始まると、前のユニットに文脈依存する断片になる
    // （例:「ということを紹介したいと思います。」）。翻訳する前に弾いて無駄なAPI呼び出しを避ける。
    const connectiveStart = cleanUnits.find((unit, index) => index > 0 && startsWithConnectiveExpression(unit.text))
    if (connectiveStart) {
      return buildFailurePatch(block, `split_block: rejected unit starting with connective expression: ${connectiveStart.text}`)
    }

    // 継ぎ目（各ユニットの末尾）以外を書き換えていないかをコード側で機械的に検査する。
    // プロンプトで「本文を書き換えるな」と頼むだけでは守られないことが計測でわかっているため、
    // ここで不採用にする（scripts/measureSeamOnlySplit.ts で実データ183件を計測済み）。
    const seamCheck = checkSeamOnlySplit(block.jaText, cleanUnits.map(unit => unit.text))
    if (seamCheck.classification !== 'split_ok') {
      const detail = seamCheck.detail ? `: ${seamCheck.detail}` : ''
      return buildFailurePatch(block, `split_block: rejected non-seam-only split (${seamCheck.classification}${detail})`)
    }

    const translatedResults = await Promise.all(cleanUnits.map(unit => translateSingle(unit.text, settings)))
    const failedTranslation = translatedResults.find(r => r.errorMessage)
    if (failedTranslation) {
      return buildFailurePatch(block, `split_block: translation API failed: ${failedTranslation.errorMessage}`)
    }
    const translated = translatedResults.map(r => r.text)
    const badSubtitle = translated.find(text => isBadUnitForScript(text, languages.subtitle.script))
    if (badSubtitle) {
      return buildFailurePatch(
        block,
        `split_block: rejected fragment-like ${languages.subtitle.label} unit: ${badSubtitle}`,
      )
    }

    const gapMs = thresholds.minInterSubtitleGapMs
    const timing = allocateSplitTiming({
      parent: block,
      units: cleanUnits.map((unit, index) => ({ jaText: unit.text, enText: translated[index] })),
      script: languages.transcript.script,
      gapMs,
      maxClosableGapSec: settings.subtitleMaxGapSec,
      subtitleMinDurationSec: thresholds.subtitleMinDurationSec,
      shortDurationSec: thresholds.shortDurationSec,
      verboseCps: thresholds.verboseCps,
    })
    if (!timing) {
      return buildFailurePatch(block, 'split_block: rejected split because total duration cannot satisfy minimum display time')
    }

    const prevSplitDepth = (block as { splitDepth?: number }).splitDepth ?? 0
    const replaceBlocks = cleanUnits.map((unit, index): EnBlock => {
      const start = timing.units[index].start
      const end = timing.units[index].end
      const enText = translated[index]
      const enChars = countCpsChars(enText)
      const nextId = index === 0 ? block.id : block.id * 1000 + index + 1
      const nextBlock: EnBlock = {
        ...block,
        id: nextId,
        start,
        end,
        jaText: unit.text,
        jaChars: unit.text.replace(/\s/g, '').length,
        enText,
        enRaw: enText,
        enChars,
        cps: enChars / Math.max(0.001, end - start),
        maxLineLen: enText.length,
        compressCount: 0,
        expandCount: 0,
        enTextOriginal: block.enTextOriginal ?? block.enText,
        // 上の `...block` スプレッドで contextGroupId 等を親からそのまま引き継いでいた（元々は
        // id・start・end 等だけを上書きするつもりで、文脈グループ情報は素通りしていた）。
        // 親が単独の singleton グループならたまたま無害だったが、親が
        // incomplete_end_context_group 等で複数キューのグループだった場合、子が親の
        // contextGroupId とグループサイズ(>1)をそのまま引き継いでしまう。finalSafeMerge
        // (finalSafeMerge.ts) は sameContextGroup && contextGroupSize>1 を結合条件にしているため、
        // 「意図して分割した子」が直後に再結合されてしまう退行に繋がる
        // （実測: 拒否48件中3件は singleton 化という偶然だけで結合を免れていた＝設計として
        // 防げていなかった）。分割で生まれた子キューは実データ上も独立した文脈単位なので、
        // contextGrouping.ts の single_cue_context_group と同じ形（size=1, role='single'）で
        // 自分自身だけの新しい singleton グループを割り当てる。
        contextGroupId: `cg-${nextId}`,
        contextGroupIndex: 0,
        contextGroupSize: 1,
        contextGroupRole: 'single',
        contextGroupReason: 'split_block_singleton',
        contextGroupText: unit.text,
        contextGroupSourceIds: [nextId],
        words: timing.units[index].words?.map(word => ({ ...word })),
        alignConf: timing.units[index].alignConf,
        alignMatchRate: timing.units[index].alignMatchRate,
        sourceRefs: withCueSourceRelation(block.sourceRefs, 'correction_split'),
      }
      ;(nextBlock as unknown as Record<string, unknown>).splitDepth = prevSplitDepth + 1
      ;(nextBlock as unknown as Record<string, unknown>).splitFrom = block.id
      ;(nextBlock as unknown as Record<string, unknown>).splitIndex = index + 1
      return nextBlock
    })

    const validated = validateSplitCandidates(block, replaceBlocks, thresholds)
    if (!validated.ok) {
      return buildFailurePatch(block, validated.warning)
    }

    return {
      replaceBlocks: validated.blocks,
      dirtyBlockIds: validated.blocks.map(nextBlock => String(nextBlock.id)),
      changed: true,
      warning: splitWarning,
      splitTiming: timing.decision,
    }
  },
}

export const __testing = {
  buildSplitSystemPrompt,
  buildSingleTranslateSystem,
  pickSplitSystemPrompt,
  JAPANESE_SPLIT_SYSTEM_PROMPT,
}
