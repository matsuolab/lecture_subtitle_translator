import { invoke, isTauri } from '@tauri-apps/api/core'

export interface TauriFetchOptions {
  method?: string
  headers?: Record<string, string>
  body?: string
  /** ローカルファイルパスをbodyとしてアップロード（Tauri専用、ブラウザでは無視） */
  filePath?: string
  /** ブラウザfetch互換用。Tauri経路では現状無視される */
  signal?: AbortSignal
}

export interface TauriFetchResponse {
  ok: boolean
  status: number
  headers: Record<string, string>
  text(): Promise<string>
  json<T = unknown>(): Promise<T>
}

interface RawTauriResponse {
  status: number
  headers: Record<string, string>
  body: string
}

/**
 * Tauri環境ではRust(reqwest)経由でHTTPリクエストを送る。
 * ブラウザのCORS/WebKit制限を回避するための共通ラッパー。
 * ブラウザ環境ではネイティブfetchにフォールバック。
 */
export async function tauriFetch(url: string, options: TauriFetchOptions = {}): Promise<TauriFetchResponse> {
  if (!isTauri()) {
    const res = await fetch(url, {
      method: options.method,
      headers: options.headers,
      body: options.body,
      signal: options.signal,
    })
    return {
      ok: res.ok,
      status: res.status,
      headers: Object.fromEntries(res.headers.entries()),
      text: () => res.text(),
      json: <T,>() => res.json() as Promise<T>,
    }
  }

  const raw = await invoke<RawTauriResponse>('http_request', {
    options: {
      url,
      method: options.method ?? 'GET',
      headers: options.headers ?? {},
      bodyText: options.body ?? null,
      bodyFile: options.filePath ?? null,
    },
  })

  return {
    ok: raw.status >= 200 && raw.status < 300,
    status: raw.status,
    headers: raw.headers,
    text: async () => raw.body,
    json: async <T,>() => JSON.parse(raw.body) as T,
  }
}
