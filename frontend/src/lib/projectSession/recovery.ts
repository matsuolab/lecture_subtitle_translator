import type { AdminSettings } from '@/types/adminSettings'
import type { PipelineRunResult } from '@/types/pipeline'
import type { SubtitleBlock } from '@/types/subtitle'

export const RECOVERY_SNAPSHOT_SCHEMA = 'matsuo.subtitle-recovery' as const
export const RECOVERY_SNAPSHOT_VERSION = 3 as const
export const RECOVERY_STORAGE_KEY = 'matsuo-subtitle-recovery-v3' as const

export type PipelineRunSummary = Omit<PipelineRunResult, 'debug'>

export interface RecoverySnapshotSessionV3 {
  videoSource?: { name: string; path?: string } | null
  adminSettings?: Partial<AdminSettings>
  pipelineRun?: PipelineRunSummary
  pipelineHistory?: PipelineRunSummary[]
  activeWorkLogSessionId?: string
}

export interface RecoverySnapshotV3 {
  schema: typeof RECOVERY_SNAPSHOT_SCHEMA
  version: typeof RECOVERY_SNAPSHOT_VERSION
  revision: number
  savedAt: string
  blocks: SubtitleBlock[]
  session?: RecoverySnapshotSessionV3
}

export interface RecoverySnapshotInput {
  savedAt: string
  blocks: SubtitleBlock[]
  session?: RecoverySnapshotSessionV3
}

export interface RecoverySessionInput {
  savedAt: string
  blocks: SubtitleBlock[]
  videoSource?: RecoverySnapshotSessionV3['videoSource']
  adminSettings?: Partial<AdminSettings>
  pipelineRun?: PipelineRunResult
  pipelineHistory?: PipelineRunResult[]
  activeWorkLogSessionId?: string
}

export interface RecoveryStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export interface RecoverySaveError {
  name: string
  message: string
}

export type RecoverySaveResult =
  | { ok: true; revision: number }
  | { ok: false; revision: number; error: RecoverySaveError }

export type RecoveryLoadResult =
  | { status: 'empty' }
  | { status: 'ok'; snapshot: RecoverySnapshotV3 }
  | { status: 'unsupported_newer'; foundVersion: number; supportedVersion: typeof RECOVERY_SNAPSHOT_VERSION }
  | { status: 'invalid'; error: string }

const LOCAL_ONLY_ADMIN_SETTING_KEYS = new Set<keyof AdminSettings>([
  'serviceAuthToken',
  'hfToken',
  'openaiApiKey',
  'geminiApiKey',
  'workLogDir',
])

function omitLocalOnlyAdminSettings(settings: Partial<AdminSettings>): Partial<AdminSettings> {
  return Object.fromEntries(
    Object.entries(settings).filter(([key]) => !LOCAL_ONLY_ADMIN_SETTING_KEYS.has(key as keyof AdminSettings)),
  ) as Partial<AdminSettings>
}

function toRunSummary(run: PipelineRunResult | undefined): PipelineRunSummary | undefined {
  if (!run) return undefined
  const summary: Partial<PipelineRunResult> = { ...run }
  delete summary.debug
  return summary as PipelineRunSummary
}

/** 完全Project Sessionから巨大な証拠を除いたRecovery入力を作る。 */
export function createRecoverySnapshotInput(input: RecoverySessionInput): RecoverySnapshotInput {
  const hasSession = input.videoSource !== undefined
    || input.adminSettings !== undefined
    || input.pipelineRun !== undefined
    || input.pipelineHistory !== undefined
    || input.activeWorkLogSessionId !== undefined
  return {
    savedAt: input.savedAt,
    blocks: input.blocks,
    session: hasSession ? {
      videoSource: input.videoSource,
      adminSettings: input.adminSettings
        ? omitLocalOnlyAdminSettings(input.adminSettings)
        : undefined,
      pipelineRun: toRunSummary(input.pipelineRun),
      pipelineHistory: input.pipelineHistory?.flatMap(run => {
        const summary = toRunSummary(run)
        return summary ? [summary] : []
      }),
      activeWorkLogSessionId: input.activeWorkLogSessionId,
    } : undefined,
  }
}

/**
 * Project側の設定を復元する際、端末にだけ存在する秘密値と
 * WorkLog保管場所は必ず現端末の値を保つ。
 */
export function mergeImportedAdminSettings(
  current: AdminSettings,
  imported: Partial<AdminSettings> | undefined,
): AdminSettings {
  if (!imported) return current
  const safeImported = omitLocalOnlyAdminSettings(imported)
  return { ...current, ...safeImported }
}

function asError(error: unknown): RecoverySaveError {
  if (error instanceof Error || error instanceof DOMException) {
    return { name: error.name || 'Error', message: error.message }
  }
  return { name: 'Error', message: String(error) }
}

function decodeRecoverySnapshot(raw: string): RecoveryLoadResult {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (error) {
    return { status: 'invalid', error: error instanceof Error ? error.message : 'invalid JSON' }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { status: 'invalid', error: 'recovery snapshot must be an object' }
  }
  const candidate = value as Record<string, unknown>
  const version = Number(candidate.version)
  if (Number.isFinite(version) && version > RECOVERY_SNAPSHOT_VERSION) {
    return { status: 'unsupported_newer', foundVersion: version, supportedVersion: RECOVERY_SNAPSHOT_VERSION }
  }
  if (candidate.schema !== RECOVERY_SNAPSHOT_SCHEMA || version !== RECOVERY_SNAPSHOT_VERSION) {
    return { status: 'invalid', error: 'unsupported recovery snapshot schema' }
  }
  if (!Number.isInteger(candidate.revision) || Number(candidate.revision) < 1) {
    return { status: 'invalid', error: 'revision must be a positive integer' }
  }
  if (!Array.isArray(candidate.blocks)) {
    return { status: 'invalid', error: 'blocks must be an array' }
  }
  return { status: 'ok', snapshot: candidate as unknown as RecoverySnapshotV3 }
}

/** localStorageの1 keyに1種類の軽量snapshotだけを保存するAdapter。 */
export class LocalStorageRecoveryStore {
  readonly key: string
  private readonly storage: RecoveryStorage

  constructor(
    storage: RecoveryStorage,
    key = RECOVERY_STORAGE_KEY,
  ) {
    this.storage = storage
    this.key = key
  }

  load(): RecoveryLoadResult {
    let raw: string | null
    try {
      raw = this.storage.getItem(this.key)
    } catch (error) {
      return { status: 'invalid', error: asError(error).message }
    }
    return raw === null ? { status: 'empty' } : decodeRecoverySnapshot(raw)
  }

  save(input: RecoverySnapshotInput): RecoverySaveResult {
    const loaded = this.load()
    if (loaded.status === 'unsupported_newer') {
      return {
        ok: false,
        revision: 0,
        error: {
          name: 'UnsupportedRecoveryVersion',
          message: `Recovery version ${loaded.foundVersion} is newer than supported version ${loaded.supportedVersion}`,
        },
      }
    }
    const previousRevision = loaded.status === 'ok' ? loaded.snapshot.revision : 0
    const revision = previousRevision + 1
    const snapshot: RecoverySnapshotV3 = {
      schema: RECOVERY_SNAPSHOT_SCHEMA,
      version: RECOVERY_SNAPSHOT_VERSION,
      revision,
      savedAt: input.savedAt,
      blocks: input.blocks,
      session: input.session,
    }
    try {
      this.storage.setItem(this.key, JSON.stringify(snapshot))
      return { ok: true, revision }
    } catch (error) {
      return { ok: false, revision: previousRevision, error: asError(error) }
    }
  }
}
