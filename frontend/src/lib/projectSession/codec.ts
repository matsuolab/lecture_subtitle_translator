import type { PipelineRunResult } from '@/types/pipeline'
import type { SubtitleBlock } from '@/types/subtitle'
import type { WorkLogExport } from '@/lib/worklog/types'
import {
  PROJECT_DOCUMENT_SCHEMA,
  PROJECT_DOCUMENT_VERSION,
  type DecodeProjectDocumentResult,
  type MaterializedProjectSession,
  type ProjectDocumentV3,
  type ProjectRunRecordV3,
  type ProjectSessionV3,
} from './types'

type JsonObject = Record<string, unknown>

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function ownRest(value: JsonObject, keys: readonly string[]): Record<string, unknown> | undefined {
  const rest = Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)))
  return Object.keys(rest).length > 0 ? rest : undefined
}

function mergeExtensions(
  explicit: unknown,
  discovered: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const base = isObject(explicit) ? explicit : {}
  const merged = { ...base, ...(discovered ?? {}) }
  return Object.keys(merged).length > 0 ? merged : undefined
}

function normalizeLegacyBlock(value: unknown): SubtitleBlock | null {
  if (!isObject(value)) return null
  const { source, target, english, japanese, ...rest } = value
  return {
    ...rest,
    subtitle: value.subtitle ?? source ?? english ?? '',
    transcript: value.transcript ?? target ?? japanese ?? '',
  } as unknown as SubtitleBlock
}

function normalizeBlocks(value: unknown): SubtitleBlock[] | null {
  if (!Array.isArray(value)) return null
  const blocks = value.map(normalizeLegacyBlock)
  return blocks.every((block): block is SubtitleBlock => block !== null) ? blocks : null
}

function isWorkLogExport(value: unknown): value is WorkLogExport {
  if (!isObject(value) || !isObject(value.header) || !Array.isArray(value.events)) return false
  return typeof value.header.sessionId === 'string'
}

function runIdentityKey(run: PipelineRunResult): string | undefined {
  const runId = run.runId?.trim()
  const startedAt = typeof run.startedAt === 'number' ? run.startedAt : undefined
  if (runId && startedAt !== undefined) return `runId:${runId}:startedAt:${startedAt}`
  if (startedAt !== undefined) return `startedAt:${startedAt}:${run.sourceName ?? ''}`
  if (runId) return `runId:${runId}`
  return undefined
}

function createRunTable(
  currentRun: PipelineRunResult | undefined,
  history: PipelineRunResult[],
): {
  runs: ProjectRunRecordV3[]
  currentRunRef?: string
  historyRunRefs?: string[]
} {
  const records: ProjectRunRecordV3[] = []
  const byIdentity = new Map<string, string>()
  const usedRefs = new Set<string>()

  const add = (run: PipelineRunResult): string => {
    const key = runIdentityKey(run)
    const existing = key ? byIdentity.get(key) : undefined
    if (existing) return existing

    const base = run.runId?.trim() || `run-${records.length + 1}`
    let ref = base
    let suffix = 2
    while (usedRefs.has(ref)) ref = `${base}#${suffix++}`
    usedRefs.add(ref)
    if (key) byIdentity.set(key, ref)
    records.push({ ref, run })
    return ref
  }

  const currentRunRef = currentRun ? add(currentRun) : undefined
  const historyRunRefs = history.length > 0 ? history.map(add) : undefined
  return { runs: records, currentRunRef, historyRunRefs }
}

function migrateLegacyProject(raw: JsonObject, version: 1 | 2): DecodeProjectDocumentResult {
  const blocks = normalizeBlocks(raw.blocks)
  if (!blocks) return { status: 'invalid', error: 'blocks must be an array of objects' }

  const legacySession = isObject(raw.session) ? raw.session : undefined
  if (raw.session !== undefined && !legacySession) {
    return { status: 'invalid', error: 'session must be an object' }
  }
  if (legacySession?.pipelineRun !== undefined && !isObject(legacySession.pipelineRun)) {
    return { status: 'invalid', error: 'session.pipelineRun must be an object' }
  }
  if (legacySession?.pipelineHistory !== undefined && (
    !Array.isArray(legacySession.pipelineHistory) || !legacySession.pipelineHistory.every(isObject)
  )) {
    return { status: 'invalid', error: 'session.pipelineHistory must be an array of objects' }
  }
  if (legacySession?.adminSettings !== undefined && !isObject(legacySession.adminSettings)) {
    return { status: 'invalid', error: 'session.adminSettings must be an object' }
  }
  if (legacySession?.videoSource !== undefined && legacySession.videoSource !== null && (
    !isObject(legacySession.videoSource) || typeof legacySession.videoSource.name !== 'string'
  )) {
    return { status: 'invalid', error: 'session.videoSource must be null or an object with a name' }
  }
  if (legacySession?.workLog !== undefined && !isWorkLogExport(legacySession.workLog)) {
    return { status: 'invalid', error: 'session.workLog must be a WorkLog export' }
  }
  if (legacySession?.workLogs !== undefined && (
    !Array.isArray(legacySession.workLogs) || !legacySession.workLogs.every(isWorkLogExport)
  )) {
    return { status: 'invalid', error: 'session.workLogs must be an array of WorkLog exports' }
  }
  if (legacySession?.activeWorkLogSessionId !== undefined
    && typeof legacySession.activeWorkLogSessionId !== 'string') {
    return { status: 'invalid', error: 'session.activeWorkLogSessionId must be a string' }
  }
  const currentRun = legacySession && isObject(legacySession.pipelineRun)
    ? legacySession.pipelineRun as unknown as PipelineRunResult
    : undefined
  const history = legacySession && Array.isArray(legacySession.pipelineHistory)
    ? legacySession.pipelineHistory.filter(isObject) as unknown as PipelineRunResult[]
    : []
  const runTable = createRunTable(currentRun, history)

  let session: ProjectSessionV3 | undefined
  if (legacySession) {
    const workLog = isWorkLogExport(legacySession.workLog)
      ? legacySession.workLog
      : undefined
    const importedWorkLogs = Array.isArray(legacySession.workLogs)
      ? legacySession.workLogs.filter(isWorkLogExport)
      : []
    const workLogs = [...importedWorkLogs]
    if (workLog && !workLogs.some(log => log.header?.sessionId === workLog.header.sessionId)) {
      workLogs.push(workLog)
    }
    session = {
      videoSource: legacySession.videoSource as ProjectSessionV3['videoSource'],
      adminSettings: isObject(legacySession.adminSettings)
        ? legacySession.adminSettings as ProjectSessionV3['adminSettings']
        : undefined,
      currentRunRef: runTable.currentRunRef,
      historyRunRefs: runTable.historyRunRefs,
      workLogs: workLogs.length > 0 ? workLogs : undefined,
      activeWorkLogSessionId: typeof legacySession.activeWorkLogSessionId === 'string'
        ? legacySession.activeWorkLogSessionId
        : workLog?.header.sessionId,
      extensions: mergeExtensions(legacySession.extensions, ownRest(legacySession, [
        'videoSource', 'adminSettings', 'pipelineRun', 'pipelineHistory', 'workLog',
        'workLogs', 'activeWorkLogSessionId', 'extensions',
      ])),
    }
  }

  return {
    status: 'ok',
    migratedFrom: version,
    document: {
      schema: PROJECT_DOCUMENT_SCHEMA,
      version: PROJECT_DOCUMENT_VERSION,
      savedAt: typeof raw.savedAt === 'string' ? raw.savedAt : new Date(0).toISOString(),
      appVersion: typeof raw.appVersion === 'string' ? raw.appVersion : undefined,
      blocks,
      session,
      runs: runTable.runs,
      extensions: mergeExtensions(
        raw.extensions,
        ownRest(raw, ['version', 'savedAt', 'appVersion', 'blocks', 'session', 'extensions']),
      ),
    },
  }
}

function validateV3(raw: JsonObject): DecodeProjectDocumentResult {
  if (raw.schema !== PROJECT_DOCUMENT_SCHEMA) {
    return { status: 'invalid', error: `schema must be ${PROJECT_DOCUMENT_SCHEMA}` }
  }
  const blocks = normalizeBlocks(raw.blocks)
  if (!blocks) return { status: 'invalid', error: 'blocks must be an array of objects' }
  if (!Array.isArray(raw.runs) || !raw.runs.every(record => (
    isObject(record) && typeof record.ref === 'string' && isObject(record.run)
  ))) {
    return { status: 'invalid', error: 'runs must be an array of run records' }
  }
  if (raw.session !== undefined && !isObject(raw.session)) {
    return { status: 'invalid', error: 'session must be an object' }
  }
  const refs = new Set((raw.runs as Array<{ ref: string }>).map(record => record.ref))
  if (refs.size !== raw.runs.length) {
    return { status: 'invalid', error: 'run refs must be unique' }
  }
  const session = raw.session as JsonObject | undefined
  if (session?.videoSource !== undefined && session.videoSource !== null && (
    !isObject(session.videoSource) || typeof session.videoSource.name !== 'string'
  )) {
    return { status: 'invalid', error: 'session.videoSource must be null or an object with a name' }
  }
  if (session?.adminSettings !== undefined && !isObject(session.adminSettings)) {
    return { status: 'invalid', error: 'session.adminSettings must be an object' }
  }
  if (session?.currentRunRef !== undefined && typeof session.currentRunRef !== 'string') {
    return { status: 'invalid', error: 'session.currentRunRef must be a string' }
  }
  if (session?.historyRunRefs !== undefined && (
    !Array.isArray(session.historyRunRefs)
    || !session.historyRunRefs.every(ref => typeof ref === 'string')
  )) {
    return { status: 'invalid', error: 'session.historyRunRefs must be an array of strings' }
  }
  if (session?.workLogs !== undefined && (
    !Array.isArray(session.workLogs) || !session.workLogs.every(isWorkLogExport)
  )) {
    return { status: 'invalid', error: 'session.workLogs must be an array of WorkLog exports' }
  }
  if (session?.activeWorkLogSessionId !== undefined
    && typeof session.activeWorkLogSessionId !== 'string') {
    return { status: 'invalid', error: 'session.activeWorkLogSessionId must be a string' }
  }
  const referenced = [
    typeof session?.currentRunRef === 'string' ? session.currentRunRef : undefined,
    ...(Array.isArray(session?.historyRunRefs) ? session.historyRunRefs.filter((ref): ref is string => typeof ref === 'string') : []),
  ].filter((ref): ref is string => ref !== undefined)
  if (referenced.some(ref => !refs.has(ref))) {
    return { status: 'invalid', error: 'session contains an unknown run reference' }
  }

  return {
    status: 'ok',
    document: { ...raw, blocks } as unknown as ProjectDocumentV3,
  }
}

/** JSON text/objectを副作用なしで検証し、v1/v2をv3へ移行する。 */
export function decodeProjectDocument(input: string | unknown): DecodeProjectDocumentResult {
  let parsed: unknown = input
  if (typeof input === 'string') {
    try {
      parsed = JSON.parse(input)
    } catch (error) {
      return { status: 'invalid', error: error instanceof Error ? error.message : 'invalid JSON' }
    }
  }
  if (!isObject(parsed)) return { status: 'invalid', error: 'project must be an object' }

  const numericVersion = Number(parsed.version ?? 1)
  if (!Number.isInteger(numericVersion) || numericVersion < 1) {
    return { status: 'invalid', error: 'version must be a positive integer' }
  }
  if (numericVersion > PROJECT_DOCUMENT_VERSION) {
    return {
      status: 'unsupported_newer',
      foundVersion: numericVersion,
      supportedVersion: PROJECT_DOCUMENT_VERSION,
    }
  }
  if (numericVersion === PROJECT_DOCUMENT_VERSION) return validateV3(parsed)
  return migrateLegacyProject(parsed, numericVersion as 1 | 2)
}

/** Project JSONは容量が大きいためindentせず、v3だけを書き出す。 */
export function serializeProjectDocument(document: ProjectDocumentV3): string {
  if (document.schema !== PROJECT_DOCUMENT_SCHEMA || document.version !== PROJECT_DOCUMENT_VERSION) {
    throw new Error('Only ProjectDocumentV3 can be serialized')
  }
  return JSON.stringify(document)
}

/** ref構造をAppが1度に復元できる形へ解決する。 */
export function materializeProjectDocument(document: ProjectDocumentV3): MaterializedProjectSession {
  const runs = new Map(document.runs.map(record => [record.ref, record.run]))
  return {
    blocks: document.blocks,
    videoSource: document.session?.videoSource,
    adminSettings: document.session?.adminSettings,
    pipelineRun: document.session?.currentRunRef
      ? runs.get(document.session.currentRunRef)
      : undefined,
    pipelineHistory: document.session?.historyRunRefs?.flatMap(ref => {
      const run = runs.get(ref)
      return run ? [run] : []
    }),
    workLogs: document.session?.workLogs,
    activeWorkLogSessionId: document.session?.activeWorkLogSessionId,
    extensions: document.extensions,
    sessionExtensions: document.session?.extensions,
  }
}

/** 既存AppのSessionExportData相当をv3へ変換するための互換Adapter。 */
export function migrateLegacyProjectDocument(input: unknown): ProjectDocumentV3 {
  const result = decodeProjectDocument(input)
  if (result.status !== 'ok') {
    throw new Error(result.status === 'invalid'
      ? result.error
      : `Project version ${result.foundVersion} is newer than supported version ${result.supportedVersion}`)
  }
  return result.document
}
