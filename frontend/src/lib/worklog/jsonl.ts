import type { WorkLogLine } from './types'

/** 1イベントを JSONL の1行（改行なし）にシリアライズ */
export function serializeLine(line: WorkLogLine): string {
  return JSON.stringify(line)
}

/** JSONL テキストを行ごとにパース。壊れた行（クラッシュ時の最終行など）はスキップ */
export function parseJsonl(text: string): WorkLogLine[] {
  const out: WorkLogLine[] = []
  for (const raw of text.split('\n')) {
    const trimmed = raw.trim()
    if (!trimmed) continue
    try {
      out.push(JSON.parse(trimmed) as WorkLogLine)
    } catch {
      // 破損行はスキップ（JSONL なので他の行に影響しない）
    }
  }
  return out
}
