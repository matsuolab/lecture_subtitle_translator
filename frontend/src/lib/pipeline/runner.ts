/**
 * パイプラインランナー（v2 フェーズ設計）
 *
 * Phase 1（一回のみ）:
 *   correctJa → splitJa → mergeShort
 *
 * Phase 2（リトライループ, 最大 MAX_SPLIT_ATTEMPTS 回）:
 *   splitJa（ヒントあり・2回目以降）→ translateEn → formatLines → splitEn
 *   ├─ violations = 0 → Phase 3 へ
 *   └─ violations > 0 && attempt < max → SplitHint 更新してリトライ（mergeShort はスキップ）
 *
 * Phase 3（一回のみ）:
 *   finalQA（重複・ギャップ自動調整 + 優先度付き違反フラグ）
 *
 * mergeShort と splitJa リトライを同一ループに入れない（yo-yo 防止）。
 */

import type { TranscriptSegment, CorrectedSegment, PipelineInternalResult, SplitHint } from './types'
import type { JapaneseSentenceBlock, EnglishBlock, PipelineSubtitleBlock, CpsViolation } from './types'
import type { NodeContext, RunState } from './nodeContract'
import { createRunState, appendTrace, finalizeRunState } from './nodeContract'
import { correctJaNode } from './nodes/correctJa'
import { splitJaNode } from './nodes/splitJa'
import { mergeShortNode } from './nodes/mergeShort'
import { translateEnNode } from './nodes/translateEn'
import { formatLinesNode } from './nodes/formatLines'
import { splitEnNode } from './nodes/splitEn'
import { finalQaNode } from './nodes/finalQA'
import { exportSrtNode } from './nodes/exportSrt'
import type { EmbedProvider } from './providers/openaiEmbedProvider'
import type { CpsAttemptLog, PipelineRunLog } from '../../types/pipeline'

const MAX_SPLIT_ATTEMPTS = 3

export interface RunPipelineOptions {
  readonly embedProvider?: EmbedProvider  // 省略時は Embedding 乖離チェックをスキップ
  readonly sourceFile?: string            // ログ用ソースファイル名
  readonly startedAt?: number             // ログ用開始時刻（ms）。省略時は内部で記録
}

export interface RunPipelineResult {
  readonly result: PipelineInternalResult
  readonly srtContent: string
  readonly runState: RunState
  readonly log?: PipelineRunLog
}

// ---------------------------------------------------------------------------
// フルパイプライン: TranscriptSegment[] → SRT
// ---------------------------------------------------------------------------

export async function runPipeline(
  transcriptSegments: readonly TranscriptSegment[],
  ctx: NodeContext,
  options: RunPipelineOptions = {},
): Promise<RunPipelineResult> {
  const pipelineStartedAt = options.startedAt ?? Date.now()
  let runState = createRunState()

  // ── Phase 1-A: correctJa ──
  const correctStart = Date.now()
  let correctedSegments: readonly CorrectedSegment[]
  try {
    correctedSegments = await correctJaNode.run(
      { segments: transcriptSegments, embedProvider: options.embedProvider },
      ctx,
    )
    runState = appendTrace(runState, {
      nodeId: 'correctJa',
      status: 'success',
      durationMs: Date.now() - correctStart,
      attempt: 1,
      provider: 'openai',
      model: ctx.config.correctionModel,
      tokensIn: 0,
      tokensOut: 0,
    }, 0)
  } catch (err) {
    runState = appendTrace(runState, {
      nodeId: 'correctJa',
      status: 'failure',
      durationMs: Date.now() - correctStart,
      attempt: 1,
      provider: 'openai',
      model: ctx.config.correctionModel,
      tokensIn: 0,
      tokensOut: 0,
      error: String(err),
    }, 0)
    throw err
  }

  // ── Phase 1-B: splitJa（初回・ヒントなし） ──
  const splitJaStart = Date.now()
  const initialJaSentences: readonly JapaneseSentenceBlock[] = await splitJaNode.run(
    { correctedSegments, splitHints: [], attempt: 1 },
    ctx,
  )
  runState = appendTrace(runState, {
    nodeId: 'splitJa',
    status: 'success',
    durationMs: Date.now() - splitJaStart,
    attempt: 1,
    provider: 'local',
    model: '-',
    tokensIn: 0,
    tokensOut: 0,
  }, 0)

  // ── Phase 1-C: mergeShort（初回のみ） ──
  const mergeStart = Date.now()
  const mergedJaSentences: readonly JapaneseSentenceBlock[] = await mergeShortNode.run(
    initialJaSentences,
    ctx,
  )
  runState = appendTrace(runState, {
    nodeId: 'mergeShort',
    status: 'success',
    durationMs: Date.now() - mergeStart,
    attempt: 1,
    provider: 'local',
    model: '-',
    tokensIn: 0,
    tokensOut: 0,
  }, 0)

  // ── Phase 2: translateEn → formatLines → splitEn（リトライループ） ──
  const { blocks, runState: loopState, cpsAttempts } = await runTranslateLoop(
    correctedSegments,
    mergedJaSentences,
    ctx,
    runState,
  )
  runState = loopState

  // ── Phase 3: finalQA ──
  const qaStart = Date.now()
  const qaBlocks: readonly PipelineSubtitleBlock[] = await finalQaNode.run(blocks, ctx)
  runState = appendTrace(runState, {
    nodeId: 'finalQA',
    status: 'success',
    durationMs: Date.now() - qaStart,
    attempt: 1,
    provider: 'local',
    model: '-',
    tokensIn: 0,
    tokensOut: 0,
  }, 0)

  // ── exportSrt ──
  const exportStart = Date.now()
  const { srtContent } = await exportSrtNode.run(qaBlocks, ctx)
  runState = appendTrace(runState, {
    nodeId: 'exportSrt',
    status: 'success',
    durationMs: Date.now() - exportStart,
    attempt: 1,
    provider: 'local',
    model: '-',
    tokensIn: 0,
    tokensOut: 0,
  }, 0)

  const finalRunState = finalizeRunState(runState)
  const flaggedCorrections = correctedSegments.filter(s => s.correctionFlagged)

  const result: PipelineInternalResult = {
    subtitleBlocks: qaBlocks,
    flaggedCorrections,
    flaggedTranslations: [],
    srtPath: '',
  }

  const runId = `${options.sourceFile ?? 'unknown'}_${pipelineStartedAt}`
  const log: PipelineRunLog = {
    schemaVersion: '1.0',
    runId,
    startedAt: pipelineStartedAt,
    finishedAt: Date.now(),
    sourceFile: options.sourceFile ?? '',
    transcribeOutput: transcriptSegments,
    correctJaOutput: correctedSegments,
    cpsAttempts,
    finalBlocks: qaBlocks,
    nodeTraces: finalRunState.nodeTraces,
  }

  return {
    result,
    srtContent,
    runState: finalRunState,
    log,
  }
}

// ---------------------------------------------------------------------------
// 部分実行: CorrectedSegment[] からのみ実行（テスト・デバッグ用）
// ---------------------------------------------------------------------------

export async function runPipelineFromCorrection(
  correctedSegments: readonly CorrectedSegment[],
  ctx: NodeContext,
): Promise<RunPipelineResult> {
  let runState = createRunState()

  // splitJa（初回）
  const splitJaStart = Date.now()
  const initialJaSentences = await splitJaNode.run(
    { correctedSegments, splitHints: [], attempt: 1 },
    ctx,
  )
  runState = appendTrace(runState, {
    nodeId: 'splitJa', status: 'success',
    durationMs: Date.now() - splitJaStart,
    attempt: 1, provider: 'local', model: '-', tokensIn: 0, tokensOut: 0,
  }, 0)

  // mergeShort
  const mergeStart = Date.now()
  const mergedJaSentences = await mergeShortNode.run(initialJaSentences, ctx)
  runState = appendTrace(runState, {
    nodeId: 'mergeShort', status: 'success',
    durationMs: Date.now() - mergeStart,
    attempt: 1, provider: 'local', model: '-', tokensIn: 0, tokensOut: 0,
  }, 0)

  const { blocks, runState: loopState } = await runTranslateLoop(
    correctedSegments, mergedJaSentences, ctx, runState,
  )
  runState = loopState

  // finalQA
  const qaStart = Date.now()
  const qaBlocks = await finalQaNode.run(blocks, ctx)
  runState = appendTrace(runState, {
    nodeId: 'finalQA', status: 'success',
    durationMs: Date.now() - qaStart,
    attempt: 1, provider: 'local', model: '-', tokensIn: 0, tokensOut: 0,
  }, 0)

  const exportStart = Date.now()
  const { srtContent } = await exportSrtNode.run(qaBlocks, ctx)
  runState = appendTrace(runState, {
    nodeId: 'exportSrt', status: 'success',
    durationMs: Date.now() - exportStart,
    attempt: 1, provider: 'local', model: '-', tokensIn: 0, tokensOut: 0,
  }, 0)

  const result: PipelineInternalResult = {
    subtitleBlocks: qaBlocks,
    flaggedCorrections: [],
    flaggedTranslations: [],
    srtPath: '',
  }

  return { result, srtContent, runState: finalizeRunState(runState) }
}

// ---------------------------------------------------------------------------
// 翻訳ループ（translateEn → formatLines → splitEn）
// Phase 2 リトライ: CPS 違反ブロックの JA 元ブロックを splitJa で再分割して再試行
// mergeShort はスキップ（yo-yo 防止）
// ---------------------------------------------------------------------------

interface TranslateLoopResult {
  blocks: PipelineInternalResult['subtitleBlocks']
  runState: RunState
  cpsAttempts: readonly CpsAttemptLog[]
}

async function runTranslateLoop(
  correctedSegments: readonly CorrectedSegment[],
  initialJaSentences: readonly JapaneseSentenceBlock[],
  ctx: NodeContext,
  initialRunState: RunState,
): Promise<TranslateLoopResult> {
  let runState = initialRunState
  let jaSentences = initialJaSentences
  let splitHints: SplitHint[] = []
  let lastBlocks: PipelineInternalResult['subtitleBlocks'] = []
  // 最良attempt の結果を保持（violations が増加するリトライを無駄に使わない）
  let bestBlocks: PipelineInternalResult['subtitleBlocks'] = []
  let bestViolationCount = Infinity
  const cpsAttempts: CpsAttemptLog[] = []

  for (let attempt = 1; attempt <= MAX_SPLIT_ATTEMPTS; attempt++) {
    const attemptStart = Date.now()
    ctx.onProgress(`[${attempt}/${MAX_SPLIT_ATTEMPTS}] translateEn → formatLines → splitEn`)

    // 2回目以降: splitJa を再実行（ヒント付き・mergeShort はスキップ）
    if (attempt > 1) {
      const splitJaStart = Date.now()
      jaSentences = await splitJaNode.run(
        { correctedSegments, splitHints, attempt },
        ctx,
      )
      runState = appendTrace(runState, {
        nodeId: 'splitJa',
        status: 'success',
        durationMs: Date.now() - splitJaStart,
        attempt,
        provider: 'local',
        model: '-',
        tokensIn: 0,
        tokensOut: 0,
      }, 0)
    }

    // translateEn
    const translateStart = Date.now()
    const enBlocks: readonly EnglishBlock[] = await translateEnNode.run(jaSentences, ctx)
    runState = appendTrace(runState, {
      nodeId: 'translateEn',
      status: 'success',
      durationMs: Date.now() - translateStart,
      attempt,
      provider: 'openai',
      model: ctx.config.translationModel,
      tokensIn: 0,
      tokensOut: 0,
    }, 0)

    // formatLines
    const formatStart = Date.now()
    const formattedBlocks: readonly EnglishBlock[] = await formatLinesNode.run(enBlocks, ctx)
    runState = appendTrace(runState, {
      nodeId: 'formatLines',
      status: 'success',
      durationMs: Date.now() - formatStart,
      attempt,
      provider: 'local',
      model: '-',
      tokensIn: 0,
      tokensOut: 0,
    }, 0)

    // splitEn
    const splitEnStart = Date.now()
    const { blocks, violations }: { blocks: readonly PipelineSubtitleBlock[]; violations: readonly CpsViolation[] } =
      await splitEnNode.run(formattedBlocks, ctx)
    runState = appendTrace(runState, {
      nodeId: 'splitEn',
      status: 'success',
      durationMs: Date.now() - splitEnStart,
      attempt,
      provider: 'local',
      model: '-',
      tokensIn: 0,
      tokensOut: 0,
    }, 0)

    lastBlocks = blocks

    // 最良結果を更新（violations が少ない attempt を採用）
    if (violations.length < bestViolationCount) {
      bestBlocks = blocks
      bestViolationCount = violations.length
    }

    // リトライ対象: CPS超過 かつ duration > 0.1s のブロックのみ
    // 行長違反（cps <= maxCps, line > maxChars）は JA分割で解決できないため除外
    // duration=0 の違反はタイムスタンプ崩壊が原因 → 分割しても改善しない
    const meaningfulViolations = violations.filter(v =>
      v.cps > v.maxCps && (v.end - v.start) > 0.1
    )
    const isLastAttempt = attempt === MAX_SPLIT_ATTEMPTS

    // 前回より悪化した場合は早期終了（リトライが逆効果）
    const isWorse = attempt > 1 && violations.length >= (cpsAttempts[attempt - 2]?.violations.length ?? Infinity)
    const shouldRetry = meaningfulViolations.length > 0 && !isLastAttempt && !isWorse

    const attemptResult: CpsAttemptLog['result'] =
      violations.length === 0
        ? 'pass'
        : shouldRetry
          ? 'retry'
          : 'max_attempts_reached'

    cpsAttempts.push({
      attempt,
      splitHints,
      splitJaOutput: jaSentences,
      translateEnOutput: enBlocks,
      splitEnOutput: blocks,
      violations,
      result: attemptResult,
      durationMs: Date.now() - attemptStart,
    })

    if (violations.length === 0 || !shouldRetry) break

    splitHints = meaningfulViolations.map(v => ({
      start: v.start,
      end: v.end,
      reason: 'cps_violation' as const,
    }))
  }

  // 最良 attempt の結果を返す（最後の attempt ではなく violations が最も少ないもの）
  return { blocks: bestBlocks, runState, cpsAttempts }
}
