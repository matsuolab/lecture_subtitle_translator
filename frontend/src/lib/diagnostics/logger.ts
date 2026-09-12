import { appendDiagnosticLine, resolveDiagnosticLogDir } from './repository'
import { DIAGNOSTIC_LOG_SCHEMA_VERSION, type DiagnosticEventType, type DiagnosticLogLine } from './types'

let queue: Promise<void> = Promise.resolve()
let runId: string | null = null
let dirPromise: Promise<string> | null = null

function ensureRun(): { runId: string; dir: Promise<string> } {
  if (!runId) {
    runId = new Date().toISOString().replace(/[:.]/g, '-')
    dirPromise = resolveDiagnosticLogDir()
    const header: DiagnosticLogLine = {
      kind: 'header',
      schemaVersion: DIAGNOSTIC_LOG_SCHEMA_VERSION,
      runId,
      startedAt: new Date().toISOString(),
      appVersion: (import.meta.env.VITE_APP_VERSION as string | undefined) || 'dev',
      platform: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
    }
    enqueue(header)
  }
  return { runId, dir: dirPromise! }
}

function enqueue(line: DiagnosticLogLine): void {
  const { runId: id, dir } = runId ? { runId, dir: dirPromise! } : ensureRun()
  queue = queue.then(async () => {
    const resolvedDir = await dir
    await appendDiagnosticLine(resolvedDir, id, line)
  })
}

/** 診断イベントを1行追記する。書き込みは直列化され、失敗してもアプリ本体を止めない。 */
export function logDiagnosticEvent(
  type: DiagnosticEventType,
  message: string,
  detail?: Record<string, unknown>,
): void {
  enqueue({ kind: 'event', at: new Date().toISOString(), type, message, detail })
}

/**
 * 起動時に1回だけ呼ぶ: console のフックと longtask 計測をセットアップする。
 *
 * window の 'error'/'unhandledrejection' は main.tsx が既に処理しており、その中で
 * console.error を呼んでいる（`console.error('Unhandled error', ...)` 等）。
 * console.error をここでラップすれば unhandled_error/unhandled_rejection 相当は
 * console_error として自動的に記録されるため、ここで重ねて window リスナーを
 * 登録すると同じ事象を二重に記録することになる。type に unhandled_error/
 * unhandled_rejection を残しているのは、将来 main.tsx 側で `detail` 付きの
 * 専用イベントとして記録したくなった場合の受け皿として。
 */
export function installDiagnosticLogging(): void {
  ensureRun()

  const originalError = console.error
  console.error = (...args: unknown[]) => {
    logDiagnosticEvent('console_error', stringifyArgs(args))
    originalError(...args)
  }

  const originalWarn = console.warn
  console.warn = (...args: unknown[]) => {
    logDiagnosticEvent('console_warn', stringifyArgs(args))
    originalWarn(...args)
  }

  if (typeof PerformanceObserver !== 'undefined') {
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          logDiagnosticEvent('long_task', `${Math.round(entry.duration)}ms`, {
            startTime: entry.startTime,
            duration: entry.duration,
          })
        }
      })
      observer.observe({ entryTypes: ['longtask'] })
    } catch {
      // longtask 未対応の WebView では静かに諦める（対応状況未検証のため必須にしない）
    }
  }
}

/** 冗長な引数列を1行のメッセージへ落とす（Error は message、それ以外は String） */
function stringifyArgs(args: unknown[]): string {
  return args
    .map((arg) => (arg instanceof Error ? arg.message : typeof arg === 'string' ? arg : safeStringify(arg)))
    .join(' ')
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
