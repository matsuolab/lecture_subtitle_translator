import { isTauri } from '@tauri-apps/api/core'
import type { HunspellDictionary } from './dictionaryRegistry'

// 一般用語辞書インポートで投入された hunspell 辞書（.aff/.dic）を、
// アプリのデータ領域（AppData/spell-dictionaries/<label>/）に保存・読込する。
// ライセンス都合で配布物には含めず、ユーザーが各自投入する（ADR 0003 §9）。
// Tauri webview 専用（fs プラグイン）。非 Tauri 環境では no-op。

const ROOT = 'spell-dictionaries'

/** ラベルをフォルダ名に使える形へ正規化 */
function slug(label: string): string {
  return label.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'dict'
}

function affPath(label: string): string { return `${ROOT}/${slug(label)}/index.aff` }
function dicPath(label: string): string { return `${ROOT}/${slug(label)}/index.dic` }

export function userDictionariesAvailable(): boolean {
  return isTauri()
}

export async function saveUserDictionary(label: string, aff: string, dic: string): Promise<void> {
  if (!isTauri()) throw new Error('ユーザー辞書の保存はデスクトップ版でのみ利用できます')
  const { writeTextFile, mkdir, exists, BaseDirectory } = await import('@tauri-apps/plugin-fs')
  const dir = `${ROOT}/${slug(label)}`
  if (!(await exists(dir, { baseDir: BaseDirectory.AppData }))) {
    await mkdir(dir, { baseDir: BaseDirectory.AppData, recursive: true })
  }
  await writeTextFile(affPath(label), aff, { baseDir: BaseDirectory.AppData })
  await writeTextFile(dicPath(label), dic, { baseDir: BaseDirectory.AppData })
}

export async function loadUserDictionary(label: string): Promise<HunspellDictionary | undefined> {
  if (!isTauri()) return undefined
  const { readTextFile, exists, BaseDirectory } = await import('@tauri-apps/plugin-fs')
  if (!(await exists(affPath(label), { baseDir: BaseDirectory.AppData }))) return undefined
  const [aff, dic] = await Promise.all([
    readTextFile(affPath(label), { baseDir: BaseDirectory.AppData }),
    readTextFile(dicPath(label), { baseDir: BaseDirectory.AppData }),
  ])
  return { aff, dic }
}

export async function removeUserDictionary(label: string): Promise<void> {
  if (!isTauri()) return
  const { remove, exists, BaseDirectory } = await import('@tauri-apps/plugin-fs')
  const dir = `${ROOT}/${slug(label)}`
  if (await exists(dir, { baseDir: BaseDirectory.AppData })) {
    await remove(dir, { baseDir: BaseDirectory.AppData, recursive: true })
  }
}
