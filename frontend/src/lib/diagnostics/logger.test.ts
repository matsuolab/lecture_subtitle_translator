import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('./repository', () => ({
  appendDiagnosticLine: vi.fn().mockResolvedValue(undefined),
  resolveDiagnosticLogDir: vi.fn().mockResolvedValue('diagnostics'),
}))

describe('installDiagnosticLogging', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it('console.errorをラップしても元の呼び出しは維持される', async () => {
    const { installDiagnosticLogging } = await import('./logger')
    const originalError = console.error
    const spy = vi.fn()
    console.error = spy
    installDiagnosticLogging()

    console.error('boom', new Error('x'))
    expect(spy).toHaveBeenCalledWith('boom', new Error('x'))

    console.error = originalError
  })

  it('console.error呼び出しがdiagnosticsイベントとして記録される', async () => {
    const { installDiagnosticLogging } = await import('./logger')
    const { appendDiagnosticLine } = await import('./repository')
    installDiagnosticLogging()

    console.error('something failed')
    await vi.waitFor(() => {
      expect(appendDiagnosticLine).toHaveBeenCalledWith(
        'diagnostics',
        expect.any(String),
        expect.objectContaining({ kind: 'event', type: 'console_error', message: 'something failed' }),
      )
    })
  })

  it('resolveDiagnosticLogDirが起動直後に失敗しても、後続イベントは記録を再試行する', async () => {
    const { resolveDiagnosticLogDir, appendDiagnosticLine } = await import('./repository')
    // 起動直後の Tauri IPC ブリッジ未初期化を模したレース: 1回目は reject
    vi.mocked(resolveDiagnosticLogDir)
      .mockRejectedValueOnce(new TypeError("Cannot read properties of undefined (reading 'invoke')"))
      .mockResolvedValue('diagnostics')

    const { installDiagnosticLogging } = await import('./logger')
    installDiagnosticLogging()

    console.error('first: dir resolution fails')
    console.error('second: dir resolution recovers')

    // dirPromise が reject した1回目のイベント（'first: ...'）は記録されないが、
    // dirPromise を破棄して次回再解決するため2回目のイベントは記録される。
    await vi.waitFor(() => {
      expect(appendDiagnosticLine).toHaveBeenCalledWith(
        'diagnostics',
        expect.any(String),
        expect.objectContaining({ message: 'second: dir resolution recovers' }),
      )
    })
  })
})
