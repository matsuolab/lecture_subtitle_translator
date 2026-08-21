import { isTauri } from '@tauri-apps/api/core'
import type { WorkLogLine, WorkLogWriteError, WorkLogWriteResult } from './types'
import { WORK_LOG_FILE_EXT } from './types'
import { parseJsonl, serializeLine } from './jsonl'

const WORKLOG_SUBDIR = 'worklogs'

/**
 * ブラウザ（非Tauri）実行時のフォールバック: メモリ保持のみ。
 * リロードで消える。実運用は Tauri ビルドのため開発時の割り切り。
 */
const memoryStore = new Map<string, WorkLogLine[]>()

/** 実ファイルへ永続化できる環境か（= Tauri デスクトップアプリ） */
export function isWorkLogPersistent(): boolean {
  return isTauri()
}

/** 既定の保管場所: <appLocalDataDir>/worklogs */
export async function resolveDefaultWorkLogDir(): Promise<string> {
  const { appLocalDataDir, join } = await import('@tauri-apps/api/path')
  return join(await appLocalDataDir(), WORKLOG_SUBDIR)
}

/** 設定のカスタム保管場所、未指定なら既定を返す */
export async function getWorkLogDir(customDir?: string): Promise<string> {
  const trimmed = customDir?.trim()
  if (trimmed) return trimmed
  // ブラウザ実行時はメモリ保持のみ。ディレクトリは使われないのでプレースホルダを返す
  if (!isTauri()) return WORKLOG_SUBDIR
  return resolveDefaultWorkLogDir()
}

async function ensureDir(dir: string): Promise<void> {
  const { exists, mkdir } = await import('@tauri-apps/plugin-fs')
  if (!(await exists(dir))) {
    await mkdir(dir, { recursive: true })
  }
}

async function sessionFilePath(dir: string, sessionId: string): Promise<string> {
  const { join } = await import('@tauri-apps/api/path')
  return join(dir, `${sessionId}${WORK_LOG_FILE_EXT}`)
}

/** 1行を JSONL ファイルへ即追記（Tauri）。非Tauri 時はメモリへ追記 */
export async function appendWorkLogLine(
  dir: string,
  sessionId: string,
  line: WorkLogLine,
): Promise<WorkLogWriteResult> {
  try {
    if (!isTauri()) {
      const arr = memoryStore.get(sessionId) ?? []
      arr.push(line)
      memoryStore.set(sessionId, arr)
      return { ok: true }
    }
    const { writeTextFile } = await import('@tauri-apps/plugin-fs')
    await ensureDir(dir)
    const path = await sessionFilePath(dir, sessionId)
    await writeTextFile(path, `${serializeLine(line)}\n`, { append: true })
    return { ok: true }
  } catch (error) {
    const detail: WorkLogWriteError = error instanceof Error
      ? { name: error.name || 'Error', message: error.message }
      : { name: 'Error', message: String(error) }
    return { ok: false, error: detail }
  }
}

/** セッションの全行を読み出す（再開時の seq 復元・破損チェック用） */
export async function readWorkLogSession(
  dir: string,
  sessionId: string,
): Promise<WorkLogLine[]> {
  if (!isTauri()) {
    return memoryStore.get(sessionId) ?? []
  }
  const { exists, readTextFile } = await import('@tauri-apps/plugin-fs')
  const path = await sessionFilePath(dir, sessionId)
  if (!(await exists(path))) return []
  return parseJsonl(await readTextFile(path))
}

/** 保管場所フォルダを OS 既定のファイラーで開く */
export async function openWorkLogDir(dir: string): Promise<void> {
  if (!isTauri()) {
    throw new Error('フォルダを開く機能はデスクトップアプリでのみ利用できます')
  }
  await ensureDir(dir)
  const { open } = await import('@tauri-apps/plugin-shell')
  await open(dir)
}
