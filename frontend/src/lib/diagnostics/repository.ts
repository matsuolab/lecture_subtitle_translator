import { isTauri } from '@tauri-apps/api/core'
import type { DiagnosticLogLine } from './types'
import { DIAGNOSTIC_LOG_FILE_EXT } from './types'

const DIAGNOSTICS_SUBDIR = 'diagnostics'

/**
 * ブラウザ（非Tauri）実行時のフォールバック: メモリ保持のみ。
 * リロードで消える。実運用は Tauri ビルドのため開発時の割り切り。
 */
const memoryStore: DiagnosticLogLine[] = []

/** 実ファイルへ永続化できる環境か（= Tauri デスクトップアプリ） */
export function isDiagnosticLogPersistent(): boolean {
  return isTauri()
}

/** 既定の保管場所: <appLocalDataDir>/diagnostics（非Tauri実行時はプレースホルダ、実ファイルには使わない） */
export async function resolveDiagnosticLogDir(): Promise<string> {
  if (!isTauri()) return DIAGNOSTICS_SUBDIR
  const { appLocalDataDir, join } = await import('@tauri-apps/api/path')
  return join(await appLocalDataDir(), DIAGNOSTICS_SUBDIR)
}

async function ensureDir(dir: string): Promise<void> {
  const { exists, mkdir } = await import('@tauri-apps/plugin-fs')
  if (!(await exists(dir))) {
    await mkdir(dir, { recursive: true })
  }
}

async function runFilePath(dir: string, runId: string): Promise<string> {
  const { join } = await import('@tauri-apps/api/path')
  return join(dir, `${runId}${DIAGNOSTIC_LOG_FILE_EXT}`)
}

/** 1行を JSONL ファイルへ即追記（Tauri）。非Tauri 時はメモリへ追記 */
export async function appendDiagnosticLine(dir: string, runId: string, line: DiagnosticLogLine): Promise<void> {
  try {
    if (!isTauri()) {
      memoryStore.push(line)
      return
    }
    const { writeTextFile } = await import('@tauri-apps/plugin-fs')
    await ensureDir(dir)
    const path = await runFilePath(dir, runId)
    await writeTextFile(path, `${JSON.stringify(line)}\n`, { append: true })
  } catch {
    // 診断ログ自身の書き込み失敗でアプリ本体の動作を止めない。記録は諦める。
  }
}

/** 保管場所フォルダを OS 既定のファイラーで開く */
export async function openDiagnosticLogDir(dir: string): Promise<void> {
  if (!isTauri()) {
    throw new Error('フォルダを開く機能はデスクトップアプリでのみ利用できます')
  }
  await ensureDir(dir)
  const { open } = await import('@tauri-apps/plugin-shell')
  await open(dir)
}
