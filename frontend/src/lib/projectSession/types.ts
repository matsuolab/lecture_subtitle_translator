import type { AdminSettings } from '@/types/adminSettings'
import type { PipelineRunResult } from '@/types/pipeline'
import type { SubtitleBlock } from '@/types/subtitle'
import type { WorkLogExport } from '@/lib/worklog/types'

export const PROJECT_DOCUMENT_SCHEMA = 'matsuo.subtitle-project' as const
export const PROJECT_DOCUMENT_VERSION = 3 as const

export interface ProjectRunRecordV3 {
  ref: string
  run: PipelineRunResult
}

export interface ProjectSessionV3 {
  videoSource?: { name: string; path?: string } | null
  adminSettings?: Partial<AdminSettings>
  currentRunRef?: string
  historyRunRefs?: string[]
  workLogs?: WorkLogExport[]
  activeWorkLogSessionId?: string
  extensions?: Record<string, unknown>
}

/**
 * 人手で編集するためのプロジェクト全体。
 * Recovery Snapshotと異なり、run debugとWorkLogを省略しない。
 */
export interface ProjectDocumentV3 {
  schema: typeof PROJECT_DOCUMENT_SCHEMA
  version: typeof PROJECT_DOCUMENT_VERSION
  savedAt: string
  appVersion?: string
  blocks: SubtitleBlock[]
  session?: ProjectSessionV3
  /** run本体は1度だけ保持し、sessionからrefで参照する */
  runs: ProjectRunRecordV3[]
  /** 旧形式の未知フィールドも、値を捨てず往復させる */
  extensions?: Record<string, unknown>
}

export interface MaterializedProjectSession {
  blocks: SubtitleBlock[]
  videoSource?: ProjectSessionV3['videoSource']
  adminSettings?: Partial<AdminSettings>
  pipelineRun?: PipelineRunResult
  pipelineHistory?: PipelineRunResult[]
  workLogs?: WorkLogExport[]
  activeWorkLogSessionId?: string
  extensions?: Record<string, unknown>
  sessionExtensions?: Record<string, unknown>
}

export type DecodeProjectDocumentResult =
  | { status: 'ok'; document: ProjectDocumentV3; migratedFrom?: 1 | 2 }
  | { status: 'unsupported_newer'; foundVersion: number; supportedVersion: typeof PROJECT_DOCUMENT_VERSION }
  | { status: 'invalid'; error: string }
