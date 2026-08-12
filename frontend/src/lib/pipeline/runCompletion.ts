import type { PipelineLlmErrorRecord, PipelineLlmUsageRecord, PipelineRunMetrics } from '@/types/pipeline'
import type { SubtitleBlock } from '@/types/subtitle'

export interface CompletedPipelineRunSummary {
  status: 'success' | 'warning'
  message: string
  metrics: PipelineRunMetrics
}

export interface CompletedPipelineRunInput {
  blocks: readonly SubtitleBlock[]
  startedAt: number
  finishedAt: number
  maxCps: number
  maxCharsPerLine: number
  llmUsage?: readonly PipelineLlmUsageRecord[]
  llmErrors?: readonly PipelineLlmErrorRecord[]
}

function sumUsage(
  records: readonly PipelineLlmUsageRecord[],
  select: (record: PipelineLlmUsageRecord) => number | undefined,
): number {
  return records.reduce((sum, record) => sum + (select(record) ?? 0), 0)
}

/**
 * 字幕を生成できたrunの最終状態と集計を決める。
 * quota切れを字幕生成失敗と混同せず、通常成功にも埋没させない。
 */
export function summarizeCompletedPipelineRun(input: CompletedPipelineRunInput): CompletedPipelineRunSummary {
  const totalBlocks = Math.max(1, input.blocks.length)
  const usage = input.llmUsage ?? []
  const quotaExhausted = input.llmErrors?.some(error => error.errorCode === 'quota_exhausted') ?? false
  const status = quotaExhausted ? 'warning' : 'success'

  return {
    status,
    message: quotaExhausted
      ? `API残高不足により一部のAI処理が未完了（${input.blocks.length}ブロック生成・要確認）`
      : `パイプライン完了（${input.blocks.length}ブロック）`,
    metrics: {
      quality: {
        totalBlocks,
        cpsViolationRate: input.blocks.filter(block => block.cps > input.maxCps).length / totalBlocks,
        overLengthRate: input.blocks.filter(block =>
          block.subtitle.split('\n').some(line => line.length > input.maxCharsPerLine),
        ).length / totalBlocks,
        flaggedCount: input.blocks.filter(block => block.status === 'flagged').length,
      },
      cost: {
        inputTokens: sumUsage(usage, record => record.promptTokens),
        outputTokens: sumUsage(usage, record => record.completionTokens),
        reasoningTokens: sumUsage(usage, record => record.reasoningTokens),
        cachedInputTokens: sumUsage(usage, record => record.cachedInputTokens),
        // モデル別・時点別価格表がまだないため、誤った金額を出さない。
        estimatedUsd: null,
        durationMs: Math.max(0, input.finishedAt - input.startedAt),
      },
    },
  }
}
