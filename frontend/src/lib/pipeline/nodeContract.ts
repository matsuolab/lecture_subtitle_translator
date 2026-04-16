/**
 * DAG パイプラインの基盤型。
 * Python PoC の system_design.md REQ-ARCH-01〜04 に対応。
 */

import type { PipelineConfig } from './config'
import type { GlossaryItem } from './types'

// ---------------------------------------------------------------------------
// ノード実行コンテキスト
// ---------------------------------------------------------------------------

export interface LLMUsage {
  readonly tokensIn: number
  readonly tokensOut: number
  readonly model: string
  readonly provider: string
}

export interface NodeContext {
  readonly config: PipelineConfig
  readonly glossary: readonly GlossaryItem[]
  readonly onProgress: (label: string) => void
  reportUsage(usage: LLMUsage): void
}

// ---------------------------------------------------------------------------
// NodeContract: 全ノードが実装すべき共通インターフェース
// ---------------------------------------------------------------------------

export interface NodeContract<TInput, TOutput> {
  readonly id: string
  readonly schemaVersion: string
  run(input: TInput, ctx: NodeContext): Promise<TOutput>
}

// ---------------------------------------------------------------------------
// 実行トレース（ノードごとの記録）
// ---------------------------------------------------------------------------

export interface NodeTrace {
  readonly nodeId: string
  readonly status: 'success' | 'failure'
  readonly durationMs: number
  readonly attempt: number
  readonly provider: string
  readonly model: string
  readonly tokensIn: number
  readonly tokensOut: number
  readonly error?: string
  readonly summary?: string
}

// ---------------------------------------------------------------------------
// RunState: パイプライン全体の実行状態
// ---------------------------------------------------------------------------

export interface RunState {
  readonly nodeTraces: readonly NodeTrace[]
  readonly totalTokens: { readonly in: number; readonly out: number }
  readonly totalCostUsd: number
  readonly startedAt: number
  readonly finishedAt?: number
}

export function createRunState(): RunState {
  return {
    nodeTraces: [],
    totalTokens: { in: 0, out: 0 },
    totalCostUsd: 0,
    startedAt: Date.now(),
  }
}

export function appendTrace(state: RunState, trace: NodeTrace, costUsd: number): RunState {
  return {
    ...state,
    nodeTraces: [...state.nodeTraces, trace],
    totalTokens: {
      in: state.totalTokens.in + trace.tokensIn,
      out: state.totalTokens.out + trace.tokensOut,
    },
    totalCostUsd: state.totalCostUsd + costUsd,
  }
}

export function finalizeRunState(state: RunState): RunState {
  return { ...state, finishedAt: Date.now() }
}
