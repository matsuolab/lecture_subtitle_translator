import type { AdminSettings } from '@/types/adminSettings'
import { createAiGateway } from '@/lib/aiGateway'
import type { EnBlock, PipelineThresholds } from './blockTypes'
import type { PipelineCorrectionAttemptSummary } from '@/types/pipeline'
import { checkCpsViolations } from './checkCpsViolations'
import { meetsConstraints } from './correctionAgent/patchUtils'
import { requireChatModelForProvider } from './aiProvider'
import { resolveCompressModelId } from './prompts'
import { loadLanguageProfileConfig, type LanguageProfileConfig } from './languageProfileConfig'
import { parseJsonObjectFromLlmContent } from './jsonResponse'
import { getCurrentLlmUsageSink } from './llmUsageSink'
import { mapWithConcurrency } from '@/lib/concurrency'

/**
 * 1リクエストあたりの修復対象ブロック数の上限。
 * 実測: 923ブロック全件を1リクエストにすると259,465トークンとなり、
 * TPM上限200,000を超えて必ず 429 になる（実機3回の実行すべてで発生。
 * 2026-08-03/04/05 の各実行ログ参照。errorMessage: "Requested 259465, Limit 200000"）。
 * 1ブロックあたり約280トークン（259465/923）なので、対象40件＋前後2件の文脈で
 * およそ (40 + 4) * 280 ≈ 1.2万トークン。上限200,000に対して十分な余裕がある。
 */
const MAX_TARGETS_PER_BATCH = 40

/**
 * バッチの対象ブロックの前後に含める隣接ブロック数（翻訳文脈のためだけに必要）。
 * 全ブロックを文脈として渡す必要はなく、直近の前後だけで十分（実際に対象選定は
 * violation のある block のみなので、直前直後の流れが分かれば言い換えの根拠になる）。
 */
const CONTEXT_NEIGHBORS = 2

/**
 * バッチ実行の並列度。
 * TPM（1分あたりのトークン上限）は時間窓での合算であり、settings.apiRequestConcurrency
 * （翻訳・拡張など他ノード向けの汎用並列度設定）をそのまま使うと、対象件数に応じて
 * バッチ数が増えるほど「合算トークン/分」も比例して増え、結局 429 を再発しかねない。
 * ここは他ノードの設定から独立させ、安全側に倒して固定値 2 とする。
 */
const BATCH_CONCURRENCY = 2

/**
 * 段階的 escalation のエフォート値。PoC の検証で low が大半、medium で残り、high で最後の救済の構造を確認済み。
 */
export type RepairEffort = 'low' | 'medium' | 'high'

/**
 * generalRepairMaxEffort 設定値からエスカレーション配列を構築する。
 * 'low': ['low'] / 'medium': ['low', 'medium'] / 'high': ['low', 'medium', 'high']
 */
export function buildEffortsFromMax(maxEffort: 'low' | 'medium' | 'high'): RepairEffort[] {
  if (maxEffort === 'low') return ['low']
  // Release cost guard: keep the final high-effort pass opt-in for later validation.
  // Existing saved settings may still contain "high", so cap both medium/high here.
  return ['low', 'medium']
}

/**
 * general_repair_agent のモデル選択。
 * 専用設定 generalRepairModel が空欄なら compressModel にフォールバック。
 */
function resolveGeneralRepairModelId(settings: AdminSettings): string {
  return settings.generalRepairModel?.trim() || resolveCompressModelId(settings)
}

/**
 * 1 attempt あたりのログ。effort / token / before-after を完全に記録する。
 */
export interface GeneralRepairLogEntry {
  attempt: number
  effort: RepairEffort
  blocksTargetedIds: number[]
  blocksBefore: Array<{ blockId: number; jaSpan: string; en: string; violation: string }>
  blocksAfter: Array<{ blockId: number; jaSpan: string; en: string; violation: string }>
  changedBlockIds: number[]
  violationsBefore: number
  violationsAfter: number
  status: 'improved' | 'improved_partial' | 'no_change' | 'reverted' | 'llm_error' | 'parse_error'
  rationale?: string
  errorMessage?: string
  promptTokens?: number
  completionTokens?: number
  reasoningTokens?: number
  model: string
  /**
   * 部分採用で除外された rewrite。LLM の提案数のうち、自分の block で hard regression を
   * 起こすため採用しなかったもの、およびバッチ単位で違反数が増えたため丸ごと破棄した
   * ものを記録する。0 件なら全採用、>=1 件なら partial。
   */
  droppedRewrites?: DroppedRewrite[]
  /** このattemptで実行したバッチ数 */
  batchCount: number
  /** そのうちLLM呼び出しに成功したバッチ数 */
  batchesSucceeded: number
  /** そのうち採用されたバッチ数（違反数が増えなかったもの）*/
  batchesApplied: number
  /** バッチごとのエラー（あれば）。全バッチ失敗の切り分け用 */
  batchErrors: string[]
}

/**
 * general_repair_agent の最終結果。Pipeline trace に保存（snapshot 経由）。
 */
export interface GeneralRepairResult {
  enabled: boolean
  /** 修復対象の初期違反数（block 単位）*/
  initialViolatingBlocks: number
  finalViolatingBlocks: number
  attemptedEfforts: RepairEffort[]
  blocks: EnBlock[]
  entries: GeneralRepairLogEntry[]
}

interface LlmRewrite {
  blockId: number
  en: string
  /**
   * LLM がプロンプトの指示に反して ja_span を返してくることがあるため型としては受け取るが、
   * `applyRewrites` では一切使わない（日本語は書き換えさせない。理由はファイル冒頭コメント参照）。
   */
  jaSpan?: string
}

interface LlmResponse {
  rewrites: LlmRewrite[]
  rationale: string
}

// transcript（元言語=校正済みソース）のラベルはプロンプトへ注入する。
// 既定構成（transcript=Japanese）では従来のハードコード文字列とバイト一致する（generalRepairAgent.test.ts で固定）。
function buildSystemPrompt(transcriptLabel: string): string {
  return `You are GeneralRepairAgent — the LAST repair pass for academic lecture subtitles.

The pipeline has already tried rule-based corrections. What remains are the hardest cases.
You get one more chance per effort level (low → medium → high). If you cannot fix it, the block
goes to manual_review.

You will be given:
- chunk_blocks: all blocks for the current chunk, in time order, with current violations and correction history.
- residual_violations: per-block violations (cps_over, line_length_only, long_segment, etc.).
- constraints: hard limits (max_cps, max_chars_per_line, max_segment_chars, min_duration, etc.). MUST respect.

Your job: rewrite the affected cues' en text to resolve as many violations as possible.

Rules:
- Return JSON only: { "rationale": "...", "rewrites": [{ "block_id": N, "en": "..." }] }
- Only return rewrites for the cues you want to change. Other cues stay as-is.
- You may modify en ONLY (to fix CPS/line/length). The ja_span (source ${transcriptLabel}) is fixed
  and must NOT be changed — it is shown to you only as translation context.
- Preserve the cue's start/end timing (you do NOT modify timing).
- Compute allowed en chars as floor(duration_sec × max_cps). Stay within this budget.
- Respect max_chars_per_line per line and max_segment_chars total.
- Do not add content not in the source ${transcriptLabel}.
- Preserve technical terms / formulas exactly (post-correctJa form).
- Do not invent proper nouns (person names, organization names) that are not in source.
- Use correction_attempts history to AVOID repeating strategies that already failed.
- If you cannot repair a cue without violating constraints, leave it out of rewrites and explain in rationale.`
}

interface RepairPromptInput {
  chunkBlocks: EnBlock[]
  affectedBlockIds: Set<number>
  thresholds: PipelineThresholds
}

function summarizeCorrectionAttempts(
  attempts: PipelineCorrectionAttemptSummary[] | undefined,
): Array<Record<string, unknown>> | undefined {
  if (!attempts || attempts.length === 0) return undefined
  return attempts.map((a) => ({
    strategy: a.strategy,
    changed: a.changed,
    before_chars: a.beforeChars,
    after_chars: a.afterChars,
    before_violation: a.beforeViolation,
    after_violation: a.afterViolation,
    rationale: a.rationale,
    semantic_similarity: a.semanticSimilarity,
    semantic_outcome: a.semanticOutcome,
  }))
}

function buildRepairUserPrompt(input: RepairPromptInput): string {
  const isAffected = (id: number): boolean => input.affectedBlockIds.has(id)
  const formatBlock = (b: EnBlock): Record<string, unknown> => ({
    block_id: b.id,
    start: b.start,
    end: b.end,
    duration_sec: Math.round((b.end - b.start) * 1000) / 1000,
    ja_span: b.jaText,
    en: b.enText,
    en_chars: b.enChars,
    cps: b.cps,
    max_line_len: b.maxLineLen,
    current_violation: b.violation,
    align_conf: b.alignConf,
    context_group_id: b.contextGroupId,
    context_group_role: b.contextGroupRole,
    context_group_index: b.contextGroupIndex,
    context_group_size: b.contextGroupSize,
    context_group_text: b.contextGroupText,
    compress_count: b.compressCount,
    expand_count: b.expandCount,
    is_target: isAffected(b.id),
    correction_attempts: isAffected(b.id) ? summarizeCorrectionAttempts(b.correctionAttempts) : undefined,
  })

  const perBlockViolations = input.chunkBlocks
    .filter((b) => isAffected(b.id) && !meetsConstraints(b))
    .map((b) => ({
      block_id: b.id,
      violation: b.violation,
      en_chars: b.enChars,
      cps: b.cps,
      max_line_len: b.maxLineLen,
    }))

  return JSON.stringify({
    chunk_blocks: input.chunkBlocks.map(formatBlock),
    residual_violations: {
      per_block: perBlockViolations,
    },
    constraints: {
      max_cps: input.thresholds.verboseCps,
      max_chars_per_line: input.thresholds.maxLineLen,
      max_segment_chars: input.thresholds.maxLineLen * 2,
      slow_cps: input.thresholds.slowCps,
      short_duration_sec: input.thresholds.shortDurationSec,
      long_duration_sec: input.thresholds.longDurationSec,
    },
    instruction:
      'Rewrite the en text of the target blocks (is_target=true) to resolve remaining violations. ' +
      'Use correction_attempts to avoid repeating failed strategies. ' +
      'Keep timing and ja_span unchanged. Respect constraints.',
  })
}

/**
 * 対象 block を MAX_TARGETS_PER_BATCH 件ずつのバッチに分割する。
 * blocks（時系列順）内の出現順で affectedBlockIds をソートしてから分割することで、
 * バッチ内の block が時間的に隣接しやすくなる（buildBatchChunkBlocks の前後文脈と整合させるため）。
 */
function buildTargetBatches(blocks: EnBlock[], affectedBlockIds: Set<number>): number[][] {
  const orderedIds = blocks.filter((b) => affectedBlockIds.has(b.id)).map((b) => b.id)
  const batches: number[][] = []
  for (let i = 0; i < orderedIds.length; i += MAX_TARGETS_PER_BATCH) {
    batches.push(orderedIds.slice(i, i + MAX_TARGETS_PER_BATCH))
  }
  return batches
}

/**
 * バッチの chunk_blocks を「対象ブロック＋前後 CONTEXT_NEIGHBORS 件」に絞り込む。
 * 全 923 ブロックを毎回まとめて送っていたことが 429 (TPM 超過) の直接原因だったため
 * （ファイル冒頭の MAX_TARGETS_PER_BATCH コメント参照）、文脈として本当に必要な範囲だけに絞る。
 */
function buildBatchChunkBlocks(blocks: EnBlock[], targetIds: number[]): EnBlock[] {
  const indexById = new Map<number, number>()
  blocks.forEach((b, idx) => indexById.set(b.id, idx))
  const includedIndices = new Set<number>()
  for (const id of targetIds) {
    const idx = indexById.get(id)
    if (idx === undefined) continue
    for (let offset = -CONTEXT_NEIGHBORS; offset <= CONTEXT_NEIGHBORS; offset += 1) {
      const neighborIdx = idx + offset
      if (neighborIdx >= 0 && neighborIdx < blocks.length) includedIndices.add(neighborIdx)
    }
  }
  return [...includedIndices].sort((a, b) => a - b).map((idx) => blocks[idx])
}

/** number | undefined の配列を合算する。全件 undefined なら undefined を返す（usage 未取得時の区別のため）。 */
function sumDefined(values: Array<number | undefined>): number | undefined {
  const defined = values.filter((v): v is number => typeof v === 'number')
  return defined.length > 0 ? defined.reduce((a, b) => a + b, 0) : undefined
}

interface LlmCallResult {
  parsed: LlmResponse | null
  errorMessage?: string
  promptTokens?: number
  completionTokens?: number
  reasoningTokens?: number
}

async function callRepairLlm(
  prompt: string,
  settings: AdminSettings,
  model: string,
  effort: RepairEffort,
  languages: LanguageProfileConfig,
): Promise<LlmCallResult> {
  const resolvedModel = requireChatModelForProvider(settings, model, 'general repair')

  try {
    const result = await createAiGateway(settings).chatText({
      nodeName: `generalRepairAgent[effort=${effort}]`,
      model: resolvedModel,
      reasoningEffort: effort,
      responseFormat: undefined,
      usageSink: getCurrentLlmUsageSink(),
      messages: [
        { role: 'system', content: buildSystemPrompt(languages.transcript.label) },
        { role: 'user', content: prompt },
      ],
    })

    if (result.errorMessage) {
      return {
        parsed: null,
        errorMessage: `general_repair API failed: ${result.errorMessage}`,
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
        reasoningTokens: result.reasoningTokens,
      }
    }

    try {
      const obj = parseJsonObjectFromLlmContent(result.content, 'general_repair')
      const rationale = typeof obj.rationale === 'string' ? obj.rationale : ''
      const rewritesRaw = Array.isArray(obj.rewrites) ? obj.rewrites : []
      const rewrites: LlmRewrite[] = []
      for (const r of rewritesRaw) {
        if (!r || typeof r !== 'object') continue
        const row = r as Record<string, unknown>
        const blockId = typeof row.block_id === 'number' ? row.block_id : null
        const en = typeof row.en === 'string' ? row.en : null
        if (blockId === null || en === null) continue
        // ja_span が返ってきても記録だけはするが（診断用）、applyRewrites では使わない。
        const jaSpan = typeof row.ja_span === 'string' ? row.ja_span : undefined
        rewrites.push({ blockId, en, jaSpan })
      }
      return {
        parsed: { rewrites, rationale },
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
        reasoningTokens: result.reasoningTokens,
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return {
        parsed: null,
        errorMessage: `general_repair JSON parse failed: ${msg}`,
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
        reasoningTokens: result.reasoningTokens,
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { parsed: null, errorMessage: `general_repair fetch failed: ${msg}` }
  }
}

/**
 * LLM の rewrite を block へ適用する。
 * 日本語（jaText / jaChars）は一切更新しない — LLM が ja_span を返してきても無視する
 * （このパイプラインは coverage を自動修復の判断に使わない方針のため。ファイル冒頭コメント参照）。
 */
function applyRewrites(blocks: EnBlock[], rewrites: LlmRewrite[]): EnBlock[] {
  if (rewrites.length === 0) return blocks
  const byId = new Map<number, LlmRewrite>()
  for (const r of rewrites) byId.set(r.blockId, r)
  return blocks.map((b) => {
    const r = byId.get(b.id)
    if (!r) return b
    return {
      ...b,
      enText: r.en,
      enRaw: r.en,
      enTextOriginal: b.enTextOriginal ?? b.enText,
    }
  })
}

function snapshotAffected(blocks: EnBlock[], affectedIds: Set<number>): Array<{ blockId: number; jaSpan: string; en: string; violation: string }> {
  return blocks
    .filter((b) => affectedIds.has(b.id))
    .map((b) => ({ blockId: b.id, jaSpan: b.jaText, en: b.enText, violation: b.violation }))
}

function countViolatingBlocks(blocks: EnBlock[]): number {
  return blocks.filter((b) => !meetsConstraints(b)).length
}

export function hasHardMetricRegression(
  beforeBlocks: EnBlock[],
  afterBlocks: EnBlock[],
  changedIds: number[],
  thresholds: PipelineThresholds,
): boolean {
  for (const id of changedIds) {
    const before = beforeBlocks.find((b) => b.id === id)
    const after = afterBlocks.find((b) => b.id === id)
    if (!before || !after) continue

    const beforeWasWithinCps = before.cps <= thresholds.verboseCps
    if (beforeWasWithinCps && after.cps > thresholds.verboseCps) return true

    const maxSegmentChars = thresholds.maxLineLen * 2
    const beforeWasWithinSegmentChars = before.enChars <= maxSegmentChars
    if (beforeWasWithinSegmentChars && after.enChars > maxSegmentChars) return true
  }

  return false
}

export interface DroppedRewrite {
  blockId: number
  reason: string
}

/**
 * rewrite を block 単位で safety judge する。
 * 元設計は「attempt 単位の all-or-nothing accept/reject」だったが、
 * 動画全体一括投入では 1 件の hard regression で数十件の improvement を捨てるため
 * 部分採用へ移行する。各 rewrite を独立評価し、自分の block で hard regression を
 * 起こさないものだけ採用する。
 */
export function partitionRewritesBySafety(
  beforeBlocks: EnBlock[],
  proposedBlocks: EnBlock[],
  rewrites: Array<{ blockId: number; jaSpan?: string; en: string }>,
  thresholds: PipelineThresholds,
): { safe: Array<{ blockId: number; jaSpan?: string; en: string }>; dropped: DroppedRewrite[] } {
  const safe: Array<{ blockId: number; jaSpan?: string; en: string }> = []
  const dropped: DroppedRewrite[] = []
  const maxSegmentChars = thresholds.maxLineLen * 2

  for (const r of rewrites) {
    const before = beforeBlocks.find((b) => b.id === r.blockId)
    const after = proposedBlocks.find((b) => b.id === r.blockId)
    if (!before || !after) {
      dropped.push({ blockId: r.blockId, reason: 'block not found in before/after snapshot' })
      continue
    }
    const beforeWasWithinCps = before.cps <= thresholds.verboseCps
    if (beforeWasWithinCps && after.cps > thresholds.verboseCps) {
      dropped.push({
        blockId: r.blockId,
        reason: `cps regression: ${before.cps.toFixed(1)} -> ${after.cps.toFixed(1)} (limit ${thresholds.verboseCps})`,
      })
      continue
    }
    const beforeWasWithinSegmentChars = before.enChars <= maxSegmentChars
    if (beforeWasWithinSegmentChars && after.enChars > maxSegmentChars) {
      dropped.push({
        blockId: r.blockId,
        reason: `total chars regression: ${before.enChars} -> ${after.enChars} (limit ${maxSegmentChars})`,
      })
      continue
    }
    safe.push(r)
  }

  return { safe, dropped }
}

interface RepairBatchOutcome {
  targetIds: number[]
  /**
   * error: LLM 呼出自体が失敗（fetch 失敗 / HTTP エラー / JSON parse 失敗）。
   * no_change: LLM が rewrite を1件も返さなかった（変更不要と判断した）。
   * rejected: rewrite はあったが、block 単位 hard regression、またはバッチ内で
   *   違反数が増えたため丸ごと破棄した。
   * applied: rewrite の一部または全部を採用した。
   */
  status: 'error' | 'no_change' | 'rejected' | 'applied'
  /** status === 'applied' のときのみ非空。採用された rewrite。 */
  rewrites: LlmRewrite[]
  droppedRewrites: DroppedRewrite[]
  rationale?: string
  errorMessage?: string
  promptTokens?: number
  completionTokens?: number
  reasoningTokens?: number
}

/**
 * 1 バッチ（対象 block <= MAX_TARGETS_PER_BATCH 件 ＋ 前後 CONTEXT_NEIGHBORS 件の文脈）分の
 * repair を実行する。他バッチと独立に動くため、baseBlocks は attempt 開始時点のスナップショット
 * （このバッチの実行中に他バッチの結果で更新されることはない）を渡す。
 */
async function runRepairBatch(
  targetIds: number[],
  baseBlocks: EnBlock[],
  settings: AdminSettings,
  model: string,
  effort: RepairEffort,
  languages: LanguageProfileConfig,
  thresholds: PipelineThresholds,
): Promise<RepairBatchOutcome> {
  const targetIdSet = new Set(targetIds)
  const chunkBlocks = buildBatchChunkBlocks(baseBlocks, targetIds)
  const prompt = buildRepairUserPrompt({ chunkBlocks, affectedBlockIds: targetIdSet, thresholds })
  const llmResult = await callRepairLlm(prompt, settings, model, effort, languages)
  const tokenFields = {
    promptTokens: llmResult.promptTokens,
    completionTokens: llmResult.completionTokens,
    reasoningTokens: llmResult.reasoningTokens,
  }

  if (!llmResult.parsed) {
    return { targetIds, status: 'error', rewrites: [], droppedRewrites: [], errorMessage: llmResult.errorMessage, ...tokenFields }
  }

  // 文脈として渡した is_target:false のブロック（他バッチの対象かもしれない）への rewrite が
  // 誤って返ってきても無視する。バッチは対象 block を互いに素に分割しているため、これを許すと
  // 並列実行時に別バッチの結果と衝突しうる。
  const rewrites = llmResult.parsed.rewrites.filter((r) => targetIdSet.has(r.blockId))

  if (rewrites.length === 0) {
    return { targetIds, status: 'no_change', rewrites: [], droppedRewrites: [], rationale: llmResult.parsed.rationale, ...tokenFields }
  }

  const rewrittenAll = applyRewrites(baseBlocks, rewrites)
  const proposedAll = checkCpsViolations(rewrittenAll, thresholds)
  const { safe, dropped } = partitionRewritesBySafety(baseBlocks, proposedAll, rewrites, thresholds)

  if (safe.length === 0) {
    return { targetIds, status: 'rejected', rewrites: [], droppedRewrites: dropped, rationale: llmResult.parsed.rationale, ...tokenFields }
  }

  // バッチ単位の採否判定: このバッチの対象 block だけを見て、違反数が増えていなければ採用する。
  // 増えていればバッチごと（block 単位の安全チェックを通過した rewrite も含めて）破棄する。
  const beforeViolationsInBatch = baseBlocks.filter((b) => targetIdSet.has(b.id) && !meetsConstraints(b)).length
  const safeApplied = applyRewrites(baseBlocks, safe)
  const proposed = checkCpsViolations(safeApplied, thresholds)
  const afterViolationsInBatch = proposed.filter((b) => targetIdSet.has(b.id) && !meetsConstraints(b)).length

  if (afterViolationsInBatch > beforeViolationsInBatch) {
    const batchDropped: DroppedRewrite[] = safe.map((r) => ({
      blockId: r.blockId,
      reason: `batch discarded: violations within batch increased ${beforeViolationsInBatch} -> ${afterViolationsInBatch}`,
    }))
    return {
      targetIds,
      status: 'rejected',
      rewrites: [],
      droppedRewrites: [...dropped, ...batchDropped],
      rationale: llmResult.parsed.rationale,
      ...tokenFields,
    }
  }

  return { targetIds, status: 'applied', rewrites: safe, droppedRewrites: dropped, rationale: llmResult.parsed.rationale, ...tokenFields }
}

/**
 * general_repair_agent のメインエントリ。
 *
 * - settings.generalRepairEnabled === false の場合は何もせず blocks をそのまま返す
 * - block 単位の違反が無ければ何もしない（coverage の重なり率は判断材料にしない。
 *   理由: sourceTextLexicalOverlap.ts 冒頭コメント参照。書き換えられた日本語を
 *   「欠落」と誤認して不要な repair を走らせていた過去の構造を廃止したため）
 * - 各 effort で 1 回ずつ LLM 呼出……ではなく、対象 block を MAX_TARGETS_PER_BATCH 件ずつの
 *   バッチに分割し、バッチごとに 1 回 LLM 呼出する（923 件全件を 1 リクエストに詰めて
 *   TPM 上限超過で 429 になっていた実測の不具合を修正するため。ファイル冒頭コメント参照）。
 *   バッチは BATCH_CONCURRENCY（固定 2）の並列度で実行し、1 バッチが失敗（LLM エラー含む）
 *   しても他のバッチは続行する。
 * - 各 attempt で:
 *   - バッチごとに LLM 呼出 → 提案 rewrites（en のみ）を仮適用 → バッチ単位で採否判定
 *   - 採用された全バッチの rewrite をまとめて適用し、attempt 全体の違反数を再計算
 *   - 「違反数 < 元」なら採用、そうでなければ revert
 *   - 全違反解消なら break（後続 effort 不要）
 * - 全バッチが失敗（LLM 呼出が1件も成功しない）ときだけ status: 'llm_error'。
 *   一部でも成功すれば、採用の有無に応じた通常のステータス（improved 系 / no_change / reverted）になる。
 * - 全 attempt 失敗時も blocks の violation は残ったまま → 後段で manual_review 確定
 */
export async function runGeneralRepairAgent(
  blocks: EnBlock[],
  settings: AdminSettings,
  thresholds: PipelineThresholds,
  effortsParam?: RepairEffort[],
): Promise<GeneralRepairResult> {
  // settings.generalRepairMaxEffort から escalation 配列を構築（明示引数があればそちらを優先）
  const efforts: RepairEffort[] = effortsParam ?? buildEffortsFromMax(settings.generalRepairMaxEffort)
  const initialViolatingBlocks = countViolatingBlocks(blocks)

  if (!settings.generalRepairEnabled) {
    return {
      enabled: false,
      initialViolatingBlocks,
      finalViolatingBlocks: initialViolatingBlocks,
      attemptedEfforts: [],
      blocks,
      entries: [],
    }
  }

  if (initialViolatingBlocks === 0) {
    return {
      enabled: true,
      initialViolatingBlocks: 0,
      finalViolatingBlocks: 0,
      attemptedEfforts: [],
      blocks,
      entries: [],
    }
  }

  const model = resolveGeneralRepairModelId(settings)
  const languages = loadLanguageProfileConfig(settings)
  let currentBlocks = blocks
  const entries: GeneralRepairLogEntry[] = []
  const attemptedEfforts: RepairEffort[] = []

  for (let attemptIdx = 0; attemptIdx < efforts.length; attemptIdx += 1) {
    const effort = efforts[attemptIdx]
    attemptedEfforts.push(effort)

    // 対象 block: 違反のある block を集める（coverage は対象選定に使わない）
    const affectedBlockIds = new Set<number>()
    for (const b of currentBlocks) {
      if (!meetsConstraints(b)) affectedBlockIds.add(b.id)
    }

    if (affectedBlockIds.size === 0) {
      // 全部解消済み（理屈上は前 attempt で break しているはずだが念のため）
      break
    }

    const beforeViolations = countViolatingBlocks(currentBlocks)
    const beforeSnapshot = snapshotAffected(currentBlocks, affectedBlockIds)
    // このバッチ群の間、他バッチの結果で状態が変わらないよう固定した「attempt 開始時点」の
    // スナップショット。バッチは並列実行されるため、逐次的に currentBlocks を更新しながら
    // 次のバッチに渡すことはしない（対象 block は互いに素なので、この設計でも結果は変わらない）。
    const attemptBaseBlocks = currentBlocks

    const targetBatches = buildTargetBatches(attemptBaseBlocks, affectedBlockIds)

    const batchOutcomes = await mapWithConcurrency(
      targetBatches.length,
      BATCH_CONCURRENCY,
      (index) => runRepairBatch(targetBatches[index], attemptBaseBlocks, settings, model, effort, languages, thresholds),
    )

    const batchCount = batchOutcomes.length
    const batchesSucceeded = batchOutcomes.filter((o) => o.status !== 'error').length
    const batchesApplied = batchOutcomes.filter((o) => o.status === 'applied').length
    const batchErrors = batchOutcomes
      .filter((o) => o.status === 'error')
      .map((o) => `blocks ${o.targetIds.join(',')}: ${o.errorMessage ?? 'unknown error'}`)

    const promptTokens = sumDefined(batchOutcomes.map((o) => o.promptTokens))
    const completionTokens = sumDefined(batchOutcomes.map((o) => o.completionTokens))
    const reasoningTokens = sumDefined(batchOutcomes.map((o) => o.reasoningTokens))
    const rationale = batchOutcomes.map((o) => o.rationale).filter((r): r is string => !!r).join(' | ') || undefined
    const droppedRewrites = batchOutcomes.flatMap((o) => o.droppedRewrites)

    const baseEntry: Omit<GeneralRepairLogEntry, 'status'> = {
      attempt: attemptIdx + 1,
      effort,
      blocksTargetedIds: [...affectedBlockIds],
      blocksBefore: beforeSnapshot,
      blocksAfter: beforeSnapshot,
      changedBlockIds: [],
      violationsBefore: beforeViolations,
      violationsAfter: beforeViolations,
      model,
      promptTokens,
      completionTokens,
      reasoningTokens,
      rationale,
      droppedRewrites: droppedRewrites.length > 0 ? droppedRewrites : undefined,
      batchCount,
      batchesSucceeded,
      batchesApplied,
      batchErrors,
    }

    // 全バッチが失敗（LLM 呼出が1件も成功しない）ときだけ llm_error。
    // 1件でも成功していれば、以下の通常フロー（採用の有無に応じた improved / no_change / reverted）に進む。
    if (batchesSucceeded === 0) {
      entries.push({ ...baseEntry, status: 'llm_error', errorMessage: batchErrors.join('; ') })
      continue
    }

    const appliedRewrites = batchOutcomes.filter((o) => o.status === 'applied').flatMap((o) => o.rewrites)

    if (appliedRewrites.length === 0) {
      // 採用されたバッチが1つも無い: 全バッチが no_change（変更不要）か rejected（破棄）のいずれか。
      const anyRejected = batchOutcomes.some((o) => o.status === 'rejected')
      entries.push({ ...baseEntry, status: anyRejected ? 'reverted' : 'no_change' })
      continue
    }

    // 採用された全バッチの rewrite をまとめて適用し、attempt 全体（全 block）で違反数を再計算する。
    // バッチ単位の採否判定は各バッチ自身の対象 block だけを見て行われるため、ここで改めて
    // 「attempt 全体として本当に改善したか」を最終確認する（元の全件一括判定と同じ安全網）。
    const rewrittenBlocks = applyRewrites(attemptBaseBlocks, appliedRewrites)
    const proposedBlocks = checkCpsViolations(rewrittenBlocks, thresholds)
    const afterViolations = countViolatingBlocks(proposedBlocks)

    if (afterViolations >= beforeViolations) {
      // 個々のバッチは「バッチ内では違反が増えていない」と判定して採用したが、attempt 全体で見ると
      // 改善していない（起こりうるのは理論上まれだが、安全側に倒して丸ごと revert する）。
      entries.push({
        ...baseEntry,
        status: 'reverted',
        blocksAfter: snapshotAffected(proposedBlocks, affectedBlockIds),
        violationsAfter: afterViolations,
        rationale: rationale
          ? `${rationale}; reverted: no net improvement after batch adoption`
          : 'reverted: no net improvement after batch adoption',
      })
      continue
    }

    currentBlocks = proposedBlocks
    const afterSnapshot = snapshotAffected(proposedBlocks, affectedBlockIds)
    const changedIds = appliedRewrites
      .map((r) => r.blockId)
      .filter((id) => {
        const before = attemptBaseBlocks.find((b) => b.id === id)
        const after = proposedBlocks.find((b) => b.id === id)
        if (!before || !after) return false
        return before.enText !== after.enText
      })
    // 一部でも「失敗 / 破棄 / 未採用」のバッチがあれば partial（全バッチが applied で初めて非 partial）。
    const isPartial = batchesApplied < batchCount || droppedRewrites.length > 0

    entries.push({
      ...baseEntry,
      status: isPartial ? 'improved_partial' : 'improved',
      blocksAfter: afterSnapshot,
      changedBlockIds: changedIds,
      violationsAfter: afterViolations,
    })
    if (afterViolations === 0) break
  }

  return {
    enabled: true,
    initialViolatingBlocks,
    finalViolatingBlocks: countViolatingBlocks(currentBlocks),
    attemptedEfforts,
    blocks: currentBlocks,
    entries,
  }
}

export const __testing = {
  buildSystemPrompt,
}
