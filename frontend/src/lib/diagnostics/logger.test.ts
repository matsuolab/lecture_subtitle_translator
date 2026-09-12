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
})
