/**
 * OS keychain へのアクセスラッパー。
 *
 * Rust 側の set_secret / get_secret / delete_secret コマンドを呼び出す。
 * Tauri 環境外（ブラウザ dev など）では呼び出しが失敗するため、
 * 呼び出し元で catch して graceful fallback すること。
 *
 * Windows: Windows Credential Manager
 * macOS:   Keychain Access
 * Linux:   libsecret / KWallet
 */

import { invoke } from '@tauri-apps/api/core'

// tauri.conf.json の identifier に合わせる
const SERVICE = 'jp.matsuolab.subtitle-editor'

export async function setSecret(account: string, secret: string): Promise<void> {
  await invoke<void>('set_secret', { service: SERVICE, account, secret })
}

export async function getSecret(account: string): Promise<string | null> {
  return await invoke<string | null>('get_secret', { service: SERVICE, account })
}

export async function deleteSecret(account: string): Promise<void> {
  await invoke<void>('delete_secret', { service: SERVICE, account })
}
