import fs from 'node:fs'
import path from 'node:path'

export interface EventLog {
  run_id: string
  chunk_id?: string
  event_id?: string
  timestamp?: string
  phase: string
  agent?: string
  event_type: string
  attempt?: number
  model?: string
  input_ref?: string
  output_ref?: string
  summary?: string
  metrics?: Record<string, unknown>
  data?: unknown
}

export class RunLogger {
  private seq = 0
  readonly baseDir: string

  constructor(readonly runId: string, resultsRoot: string) {
    this.baseDir = path.join(resultsRoot, runId)
    for (const dir of ['', 'prompts', 'responses', 'plans', 'traces', 'reports']) {
      fs.mkdirSync(path.join(this.baseDir, dir), { recursive: true })
    }
  }

  writeJson(relativePath: string, data: unknown): string {
    const fullPath = path.join(this.baseDir, relativePath)
    fs.mkdirSync(path.dirname(fullPath), { recursive: true })
    fs.writeFileSync(fullPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
    return relativePath.replace(/\\/g, '/')
  }

  writeText(relativePath: string, data: string): string {
    const fullPath = path.join(this.baseDir, relativePath)
    fs.mkdirSync(path.dirname(fullPath), { recursive: true })
    fs.writeFileSync(fullPath, data, 'utf8')
    return relativePath.replace(/\\/g, '/')
  }

  event(event: Omit<EventLog, 'run_id' | 'event_id' | 'timestamp'>): void {
    this.seq += 1
    const row: EventLog = {
      run_id: this.runId,
      event_id: `evt_${String(this.seq).padStart(6, '0')}`,
      timestamp: new Date().toISOString(),
      ...event,
    }
    fs.appendFileSync(path.join(this.baseDir, 'events.jsonl'), `${JSON.stringify(row)}\n`, 'utf8')
  }
}
