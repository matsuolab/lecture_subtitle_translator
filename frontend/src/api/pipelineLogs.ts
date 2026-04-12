/**
 * パイプライン実行ログの永続化（Tauri $APPCONFIG/pipeline_logs/）。
 * ブラウザ環境では import が失敗するため、全操作を try/catch で包む。
 */

import type { PipelineRunLog } from '@/types/pipeline'

const LOGS_DIR = 'pipeline_logs'

function safeRunId(runId: string): string {
  return runId.replace(/[/\\:*?"<>|]/g, '_')
}

/** ログを1件ディスクに保存する。古いログが retentionCount を超えた場合は削除。 */
export async function savePipelineLog(
  log: PipelineRunLog,
  retentionCount: number | null,
): Promise<void> {
  try {
    const { writeTextFile, mkdir, readDir, remove } = await import('@tauri-apps/plugin-fs')
    const { appConfigDir } = await import('@tauri-apps/api/path')
    const base = await appConfigDir()
    const dir = `${base}/${LOGS_DIR}`
    await mkdir(dir, { recursive: true })

    const filename = `${safeRunId(log.runId)}.json`
    await writeTextFile(`${dir}/${filename}`, JSON.stringify(log))

    // retentionCount が設定されている場合、古いものを削除
    if (retentionCount !== null) {
      const entries = await readDir(dir)
      const jsonFiles = entries
        .filter(e => e.name?.endsWith('.json'))
        .map(e => ({ name: e.name ?? '' }))
        .sort((a, b) => a.name.localeCompare(b.name))

      const excess = jsonFiles.length - retentionCount
      if (excess > 0) {
        for (const file of jsonFiles.slice(0, excess)) {
          await remove(`${dir}/${file.name}`)
        }
      }
    }
  } catch {
    // Tauri 環境以外（ブラウザ開発時）では無視
  }
}

/** ディスクから全ログを読み込む（起動時の履歴復元用）。 */
export async function loadPipelineLogs(): Promise<PipelineRunLog[]> {
  try {
    const { readTextFile, readDir } = await import('@tauri-apps/plugin-fs')
    const { appConfigDir } = await import('@tauri-apps/api/path')
    const base = await appConfigDir()
    const dir = `${base}/${LOGS_DIR}`

    const entries = await readDir(dir)
    const jsonFiles = entries
      .filter(e => e.name?.endsWith('.json'))
      .map(e => e.name ?? '')
      .sort()

    const logs: PipelineRunLog[] = []
    for (const file of jsonFiles) {
      try {
        const text = await readTextFile(`${dir}/${file}`)
        const parsed = JSON.parse(text) as PipelineRunLog
        if (parsed.schemaVersion === '1.0') {
          logs.push(parsed)
        }
      } catch {
        // 破損ファイルはスキップ
      }
    }
    return logs
  } catch {
    return []
  }
}
