import { describe, expect, it } from 'vitest'
import { appendDiagnosticLine, isDiagnosticLogPersistent } from './repository'
import type { DiagnosticLogLine } from './types'

describe('diagnostics repository (non-Tauri fallback)', () => {
  it('非Tauri環境ではisDiagnosticLogPersistentがfalseを返す', () => {
    expect(isDiagnosticLogPersistent()).toBe(false)
  })

  it('appendDiagnosticLineは非Tauri環境でも例外を投げない（メモリへ積むだけ）', async () => {
    const line: DiagnosticLogLine = {
      kind: 'event',
      at: '2026-09-12T00:00:00.000Z',
      type: 'console_error',
      message: 'test',
    }
    await expect(appendDiagnosticLine('diagnostics', 'run-1', line)).resolves.toBeUndefined()
  })
})
