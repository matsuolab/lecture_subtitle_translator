import type { SubtitleBlock } from '@/types/subtitle'
import type { TranscriptSegment } from '@/lib/pipeline/types'

export const WORK_LOG_SCHEMA_VERSION = 1

/** ワークログのファイル拡張子（1行1イベントの JSON Lines） */
export const WORK_LOG_FILE_EXT = '.jsonl'

export type WorkLogEventCategory =
  | 'transcription'
  | 'ai_correction'
  | 'manual_edit'
  | 'lineage'

/** セッション（編集対象のブロック集合）が確定したきっかけ */
export type WorkLogBaselineOrigin = 'transcription' | 'srt_import' | 'json_import'

/** JSONL 1行目: セッションヘッダ */
export interface WorkLogHeader {
  kind: 'header'
  schemaVersion: number
  sessionId: string
  startedAt: string
  video: { name: string; path?: string } | null
  settingsSnapshot?: Record<string, unknown>
}

/** JSONL 2行目: 編集のスタート地点（1セッションに1回） */
export interface WorkLogBaseline {
  kind: 'baseline'
  at: string
  origin: WorkLogBaselineOrigin
  initialBlocks: SubtitleBlock[]
  transcriptSegments?: TranscriptSegment[]
}

/** 作業イベント（書き起こし進捗・AI修正・手動編集・ブロック系譜） */
export interface WorkLogEvent {
  kind: 'event'
  seq: number
  at: string
  category: WorkLogEventCategory
  type: string
  blockId?: number
  before?: Record<string, unknown>
  after?: Record<string, unknown>
  /** lineage(split): 分割元 / lineage(merge): 結合先 */
  parentBlockId?: number
  childBlockIds?: number[]
  /** lineage(merge): 結合元 / lineage(split): 分割先 */
  parentBlockIds?: number[]
  childBlockId?: number
  meta?: Record<string, unknown>
}

/** マーカー（再起動など、時系列の切れ目を示す） */
export interface WorkLogMarker {
  kind: 'marker'
  at: string
  type: 'resumed' | string
  meta?: Record<string, unknown>
}

export type WorkLogLine = WorkLogHeader | WorkLogBaseline | WorkLogEvent | WorkLogMarker

/** 「JSON保存」ボタンでプロジェクトJSONに同梱する現セッション分のワークログ */
export interface WorkLogExport {
  header: WorkLogHeader
  baseline?: WorkLogBaseline
  events: Array<WorkLogEvent | WorkLogMarker>
}
