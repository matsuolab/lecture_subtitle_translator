/**
 * パイプラインランナー。
 * WhisperX 書き起こし結果から SRT まで全ステップを実行する。
 *
 *   correctJa（日本語補正）
 *     ↓
 *   [CPSループ: 最大 MAX_SPLIT_ATTEMPTS 回]
 *     splitJa(splitHints)   ← 再試行時は SplitHint を渡す
 *     translateEn
 *     splitEn
 *     ├─ violations = 0 → 完了
 *     └─ violations > 0, attempt < max → SplitHint 更新してリトライ
 *                         attempt = max → violations を flagged で返す
 *     ↓
 *   exportSrt
 */

import type { TranscriptSegment, CorrectedSegment, PipelineInternalResult, SplitHint } from './types'
import type { JapaneseSentenceBlock, EnglishBlock, PipelineSubtitleBlock, CpsViolation } from './types'
import type { NodeContext, RunState } from './nodeContract'
import { createRunState, appendTrace, finalizeRunState } from './nodeContract'
import { correctJaNode } from './nodes/correctJa'
import { splitJaNode } from './nodes/splitJa'
import { translateEnNode } from './nodes/translateEn'
import { splitEnNode } from './nodes/splitEn'
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

  // --- correctJa ---
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

  // --- CPSループ: splitJa → translateEn → splitEn ---
  const { blocks, runState: loopState, cpsAttempts } = await runSplitLoop(
    correctedSegments,
    ctx,
    runState,
  )

  runState = loopState

  // --- exportSrt ---
  const exportStart = Date.now()
  const { srtContent } = await exportSrtNode.run(blocks, ctx)
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
    subtitleBlocks: blocks,
    flaggedCorrections,
    flaggedTranslations: [],   // TODO: translateEn の Embedding チェック実装後に設定
    srtPath: '',               // ファイル書き込みは呼び出し元が担当
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
    finalBlocks: blocks,
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

  const { blocks, runState: loopState } = await runSplitLoop(
    correctedSegments,
    ctx,
    runState,
  )
  runState = loopState

  const exportStart = Date.now()
  const { srtContent } = await exportSrtNode.run(blocks, ctx)
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

  const result: PipelineInternalResult = {
    subtitleBlocks: blocks,
    flaggedCorrections: [],
    flaggedTranslations: [],
    srtPath: '',
  }

  return { result, srtContent, runState: finalizeRunState(runState) }
}

// ---------------------------------------------------------------------------
// CPS ループ（内部）
// ---------------------------------------------------------------------------

interface SplitLoopResult {
  blocks: PipelineInternalResult['subtitleBlocks']
  runState: RunState
  cpsAttempts: readonly CpsAttemptLog[]
}

async function runSplitLoop(
  correctedSegments: readonly CorrectedSegment[],
  ctx: NodeContext,
  initialRunState: RunState,
): Promise<SplitLoopResult> {
  let runState = initialRunState
  let splitHints: SplitHint[] = []
  let lastBlocks: PipelineInternalResult['subtitleBlocks'] = []
  const cpsAttempts: CpsAttemptLog[] = []

  for (let attempt = 1; attempt <= MAX_SPLIT_ATTEMPTS; attempt++) {
    const attemptStart = Date.now()
    ctx.onProgress(`[${attempt}/${MAX_SPLIT_ATTEMPTS}] splitJa → translateEn → splitEn`)

    // splitJa
    const splitJaStart = Date.now()
    const jaSentences: readonly JapaneseSentenceBlock[] = await splitJaNode.run(
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

    // splitEn
    const splitEnStart = Date.now()
    const { blocks, violations }: { blocks: readonly PipelineSubtitleBlock[]; violations: readonly CpsViolation[] } =
      await splitEnNode.run(enBlocks, ctx)
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

    // duration=0 の違反はタイムスタンプ崩壊が原因 → 分割しても改善しないのでリトライしない
    const meaningfulViolations = violations.filter(v => (v.end - v.start) > 0.1)
    const isLastAttempt = attempt === MAX_SPLIT_ATTEMPTS
    const shouldRetry = meaningfulViolations.length > 0 && !isLastAttempt

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

  return { blocks: lastBlocks, runState, cpsAttempts }
}
