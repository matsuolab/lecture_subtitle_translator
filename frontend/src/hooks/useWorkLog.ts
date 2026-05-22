import { useCallback, useRef } from 'react'
import type { SubtitleBlock } from '@/types/subtitle'
import type { TranscriptSegment } from '@/lib/pipeline/types'
import {
  WORK_LOG_SCHEMA_VERSION,
  type WorkLogBaseline,
  type WorkLogBaselineOrigin,
  type WorkLogEvent,
  type WorkLogEventCategory,
  type WorkLogExport,
  type WorkLogHeader,
  type WorkLogMarker,
} from '@/lib/worklog/types'
import { appendWorkLogLine, getWorkLogDir, readWorkLogSession } from '@/lib/worklog/repository'

export interface StartSessionOptions {
  origin: WorkLogBaselineOrigin
  video: { name: string; path?: string } | null
  settingsSnapshot?: Record<string, unknown>
  initialBlocks: SubtitleBlock[]
  transcriptSegments?: TranscriptSegment[]
}

export interface RecordEventInput {
  category: WorkLogEventCategory
  type: string
  /** イベント発生時刻。省略時は記録時の現在時刻 */
  at?: string
  blockId?: number
  before?: Record<string, unknown>
  after?: Record<string, unknown>
  parentBlockId?: number
  childBlockIds?: number[]
  parentBlockIds?: number[]
  childBlockId?: number
  meta?: Record<string, unknown>
}

interface ActiveSession {
  sessionId: string
  /** セッション開始時に解決した保管場所（途中で設定変更しても固定 = 案ア） */
  dir: string
  header: WorkLogHeader
  baseline?: WorkLogBaseline
  events: Array<WorkLogEvent | WorkLogMarker>
  seq: number
}

/** 再起動時の継続再開のため、進行中セッションIDを localStorage に保持する */
const ACTIVE_SESSION_KEY = 'subtitle-editor.worklog-active-session.v1'

function rememberActiveSessionId(sessionId: string): void {
  try {
    localStorage.setItem(ACTIVE_SESSION_KEY, sessionId)
  } catch {
    // localStorage 不可環境は無視
  }
}

function readActiveSessionId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_SESSION_KEY)
  } catch {
    return null
  }
}

function generateSessionId(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
    + `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  return `${stamp}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * 追記専用ワークログのセッション管理フック。
 * - 編集対象（ブロック集合）が確定するたびに startSession で新セッション
 * - イベントは発生のたびに即ファイル追記（中断耐性）
 * - 再起動時は resumeSession で同じファイルへ継続追記
 */
export function useWorkLog() {
  const sessionRef = useRef<ActiveSession | null>(null)
  // 追記をシリアライズして書き込み競合を防ぐキュー
  const queueRef = useRef<Promise<void>>(Promise.resolve())

  const enqueue = useCallback((task: () => Promise<void>) => {
    queueRef.current = queueRef.current.catch(() => {}).then(task)
  }, [])

  const startSession = useCallback(async (
    opts: StartSessionOptions,
    customDir?: string,
  ): Promise<string> => {
    const dir = await getWorkLogDir(customDir)
    const sessionId = generateSessionId()
    const now = new Date().toISOString()
    const header: WorkLogHeader = {
      kind: 'header',
      schemaVersion: WORK_LOG_SCHEMA_VERSION,
      sessionId,
      startedAt: now,
      video: opts.video,
      settingsSnapshot: opts.settingsSnapshot,
    }
    const baseline: WorkLogBaseline = {
      kind: 'baseline',
      at: now,
      origin: opts.origin,
      initialBlocks: opts.initialBlocks,
      transcriptSegments: opts.transcriptSegments,
    }
    sessionRef.current = { sessionId, dir, header, baseline, events: [], seq: 0 }
    rememberActiveSessionId(sessionId)
    enqueue(() => appendWorkLogLine(dir, sessionId, header))
    enqueue(() => appendWorkLogLine(dir, sessionId, baseline))
    return sessionId
  }, [enqueue])

  /** 再起動時、保存済み sessionId のファイルへ継続追記する */
  const resumeSession = useCallback(async (
    sessionId: string,
    customDir?: string,
  ): Promise<boolean> => {
    const dir = await getWorkLogDir(customDir)
    const lines = await readWorkLogSession(dir, sessionId)
    const header = lines.find((l): l is WorkLogHeader => l.kind === 'header')
    if (!header) return false
    const baseline = lines.find((l): l is WorkLogBaseline => l.kind === 'baseline')
    const events = lines.filter(
      (l): l is WorkLogEvent | WorkLogMarker => l.kind === 'event' || l.kind === 'marker',
    )
    const maxSeq = events.reduce((m, e) => (e.kind === 'event' && e.seq > m ? e.seq : m), 0)
    const marker: WorkLogMarker = { kind: 'marker', at: new Date().toISOString(), type: 'resumed' }
    sessionRef.current = {
      sessionId,
      dir,
      header,
      baseline,
      events: [...events, marker],
      seq: maxSeq,
    }
    rememberActiveSessionId(sessionId)
    enqueue(() => appendWorkLogLine(dir, sessionId, marker))
    return true
  }, [enqueue])

  /** localStorage に保存された進行中セッションIDがあれば継続再開する */
  const resumeFromPersisted = useCallback(async (customDir?: string): Promise<boolean> => {
    const sessionId = readActiveSessionId()
    if (!sessionId) return false
    return resumeSession(sessionId, customDir)
  }, [resumeSession])

  const recordEvent = useCallback((input: RecordEventInput): void => {
    const session = sessionRef.current
    if (!session) return
    session.seq += 1
    const event: WorkLogEvent = {
      kind: 'event',
      seq: session.seq,
      at: input.at ?? new Date().toISOString(),
      category: input.category,
      type: input.type,
      blockId: input.blockId,
      before: input.before,
      after: input.after,
      parentBlockId: input.parentBlockId,
      childBlockIds: input.childBlockIds,
      parentBlockIds: input.parentBlockIds,
      childBlockId: input.childBlockId,
      meta: input.meta,
    }
    session.events.push(event)
    const { dir, sessionId } = session
    enqueue(() => appendWorkLogLine(dir, sessionId, event))
  }, [enqueue])

  const getExport = useCallback((): WorkLogExport | null => {
    const session = sessionRef.current
    if (!session) return null
    return {
      header: session.header,
      baseline: session.baseline,
      events: [...session.events],
    }
  }, [])

  const getActiveSessionId = useCallback((): string | null => {
    return sessionRef.current?.sessionId ?? null
  }, [])

  return {
    startSession,
    resumeSession,
    resumeFromPersisted,
    recordEvent,
    getExport,
    getActiveSessionId,
  }
}
