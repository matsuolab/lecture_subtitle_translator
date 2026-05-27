import type { PipelineLlmUsageRecord } from '@/types/pipeline'

/**
 * LLM 呼出 usage の収集 sink。pipeline 実行中に 1 つだけ生成され、
 * 各 LLM 呼出点で `push` される。pipeline 完了時に `records()` で配列化し、
 * PipelineRunDebug.llmUsage に格納する。
 *
 * 設計理由:
 *   - 各 LLM ノードが個別に usage を保存していると集計が破綻する（保存抜け・形式不揃い）
 *   - 単一 sink を pipeline 全体で共有することで、集計の単一情報源を保つ
 *   - undefined sink を許容することで、テスト・部分実行から呼べるようにする
 */
export interface LlmUsageSink {
  push: (record: Omit<PipelineLlmUsageRecord, 'at'> & { at?: number }) => void
  records: () => PipelineLlmUsageRecord[]
}

export function createLlmUsageSink(): LlmUsageSink {
  const buffer: PipelineLlmUsageRecord[] = []
  return {
    push: (record) => {
      buffer.push({
        ...record,
        at: record.at ?? Date.now(),
      })
    },
    records: () => buffer.slice(),
  }
}

/**
 * パイプライン実行中の現在の usage sink（module-level）。
 *
 * 設計判断: 各 LLM 呼出ヘルパー（translateEn / coverageRepairAgent / etc.）に sink を引数として
 * 渡すと 18 ファイルのシグネチャ変更が必要になり、テスト・将来の拡張が重くなる。
 * 一方でこのアプリは local desktop で 1 パイプライン同時実行のみ（React app の特性）なので、
 * module-level の current sink で十分安全に運用できる。
 *
 * 運用ルール:
 *   - パイプライン orchestrator は実行開始時に setCurrentLlmUsageSink(sink) する
 *   - 実行終了時（finally）に setCurrentLlmUsageSink(undefined) で確実にクリアする
 *   - 各 LLM 呼出箇所は safePush(getCurrentLlmUsageSink(), {...}) で push する
 */
let currentSink: LlmUsageSink | undefined

export function setCurrentLlmUsageSink(sink: LlmUsageSink | undefined): void {
  currentSink = sink
}

export function getCurrentLlmUsageSink(): LlmUsageSink | undefined {
  return currentSink
}

/**
 * 引数の sink が undefined の場合は no-op。LLM 呼出ヘルパが optional sink を受け取る際の
 * 呼出側ガード用。
 */
export function safePush(
  sink: LlmUsageSink | undefined,
  record: Omit<PipelineLlmUsageRecord, 'at'> & { at?: number },
): void {
  if (!sink) return
  // tokens 全部 0 / undefined の呼出は記録しない（API 失敗で usage 取れなかった場合など）
  const hasAny =
    record.promptTokens > 0 ||
    record.completionTokens > 0 ||
    (record.reasoningTokens ?? 0) > 0 ||
    (record.cachedInputTokens ?? 0) > 0
  if (!hasAny) return
  sink.push(record)
}

export interface AggregatedModelUsage {
  model: string
  calls: number
  promptTokens: number
  completionTokens: number
  reasoningTokens: number
  cachedInputTokens: number
  durationMs: number
}

/**
 * usage records を model ID 単位で集計する。
 * PipelineRunDebug.llmUsage から表示用テーブルを生成するのに使う。
 */
export function aggregateLlmUsageByModel(records: PipelineLlmUsageRecord[]): AggregatedModelUsage[] {
  const byModel = new Map<string, AggregatedModelUsage>()
  for (const r of records) {
    const existing = byModel.get(r.model) ?? {
      model: r.model,
      calls: 0,
      promptTokens: 0,
      completionTokens: 0,
      reasoningTokens: 0,
      cachedInputTokens: 0,
      durationMs: 0,
    }
    existing.calls += 1
    existing.promptTokens += r.promptTokens
    existing.completionTokens += r.completionTokens
    existing.reasoningTokens += r.reasoningTokens ?? 0
    existing.cachedInputTokens += r.cachedInputTokens ?? 0
    existing.durationMs += r.durationMs ?? 0
    byModel.set(r.model, existing)
  }
  return [...byModel.values()].sort((a, b) => b.promptTokens + b.completionTokens - (a.promptTokens + a.completionTokens))
}
