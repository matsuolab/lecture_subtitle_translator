import { invoke, isTauri } from '@tauri-apps/api/core'

export interface TauriFetchOptions {
  method?: string
  headers?: Record<string, string>
  body?: string
  /** ローカルファイルパスをbodyとしてアップロード（Tauri専用、ブラウザでは無視） */
  filePath?: string
  /** 呼出元が独自に用意したキャンセル用シグナル。timeoutMs と併用可能（両方あれば合成される） */
  signal?: AbortSignal
  /**
   * リクエストタイムアウト（ミリ秒）。ブラウザ経路では AbortSignal.timeout で実現し、
   * Tauri経路では Rust 側の http_request コマンドに渡して reqwest のタイムアウトとして効かせる
   * （Tauri経路でも無視されない）。未指定時はどちらの経路でも無制限。
   */
  timeoutMs?: number
}

export interface TauriFetchResponse {
  ok: boolean
  status: number
  headers: Record<string, string>
  text(): Promise<string>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json<T = any>(): Promise<T>
}

interface RawTauriResponse {
  status: number
  headers: Record<string, string>
  body: string
}

/**
 * options.signal と timeoutMs 由来の AbortSignal.timeout を合成する。
 * AbortSignal.any が使えない実行環境向けに、手動合成のフォールバックを用意する。
 */
function combineSignals(signal: AbortSignal | undefined, timeoutMs: number | undefined): AbortSignal | undefined {
  const timeoutSignal = typeof timeoutMs === 'number' ? AbortSignal.timeout(timeoutMs) : undefined
  if (!signal && !timeoutSignal) return undefined
  if (!signal) return timeoutSignal
  if (!timeoutSignal) return signal

  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any([signal, timeoutSignal])
  }

  // AbortSignal.any 非対応環境向けフォールバック: どちらか先に abort した方を伝播する
  const controller = new AbortController()
  const abortWith = (source: AbortSignal) => controller.abort(source.reason)
  if (signal.aborted) abortWith(signal)
  else signal.addEventListener('abort', () => abortWith(signal), { once: true })
  if (timeoutSignal.aborted) abortWith(timeoutSignal)
  else timeoutSignal.addEventListener('abort', () => abortWith(timeoutSignal), { once: true })
  return controller.signal
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
      signal: combineSignals(options.signal, options.timeoutMs),
    })
    return {
      ok: res.ok,
      status: res.status,
      headers: Object.fromEntries(res.headers.entries()),
      text: () => res.text(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      json: <T = any>() => res.json() as Promise<T>,
    }
  }

  const raw = await invoke<RawTauriResponse>('http_request', {
    options: {
      url,
      method: options.method ?? 'GET',
      headers: options.headers ?? {},
      bodyText: options.body ?? null,
      bodyFile: options.filePath ?? null,
      timeoutMs: options.timeoutMs ?? null,
    },
  })

  return {
    ok: raw.status >= 200 && raw.status < 300,
    status: raw.status,
    headers: raw.headers,
    text: async () => raw.body,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    json: async <T = any>() => JSON.parse(raw.body) as T,
  }
}
