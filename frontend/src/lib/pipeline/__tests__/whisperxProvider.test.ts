import { describe, it, expect } from 'vitest'
import { z } from 'zod'

// whisperxProvider の Zod スキーマを直接テスト（HTTP 呼び出しなし）
// スキーマを再定義してユニットテスト可能にする

const WordSchema = z.object({
  word: z.string(),
  start: z.number(),
  end: z.number(),
  score: z.number().optional(),
})

const SegmentSchema = z.object({
  start: z.number(),
  end: z.number(),
  text: z.string(),
  words: z.array(WordSchema).optional().default([]),
})

const WhisperXResponseSchema = z.object({
  segments: z.array(SegmentSchema),
})

describe('WhisperX レスポンス Zod バリデーション', () => {
  it('正常なレスポンスをパースする', () => {
    const raw = {
      segments: [
        {
          start: 0.0,
          end: 1.5,
          text: '松尾研の講義へようこそ。',
          words: [
            { word: '松尾', start: 0.1, end: 0.4, score: 0.95 },
            { word: '研', start: 0.4, end: 0.6, score: 0.98 },
          ],
        },
      ],
    }
    const result = WhisperXResponseSchema.safeParse(raw)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.segments).toHaveLength(1)
      expect(result.data.segments[0].words).toHaveLength(2)
    }
  })

  it('words が省略されていてもデフォルト空配列になる', () => {
    const raw = {
      segments: [
        { start: 0.0, end: 2.0, text: 'テスト' },
      ],
    }
    const result = WhisperXResponseSchema.safeParse(raw)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.segments[0].words).toEqual([])
    }
  })

  it('score が省略されていてもパースできる', () => {
    const raw = {
      segments: [
        {
          start: 0.0,
          end: 1.0,
          text: 'テスト',
          words: [{ word: 'テスト', start: 0.0, end: 1.0 }],
        },
      ],
    }
    const result = WhisperXResponseSchema.safeParse(raw)
    expect(result.success).toBe(true)
  })

  it('segments が欠けているとバリデーションエラー', () => {
    const raw = { result: 'ok' }
    const result = WhisperXResponseSchema.safeParse(raw)
    expect(result.success).toBe(false)
  })

  it('start/end が数値でないとバリデーションエラー', () => {
    const raw = {
      segments: [{ start: 'abc', end: 1.0, text: 'test' }],
    }
    const result = WhisperXResponseSchema.safeParse(raw)
    expect(result.success).toBe(false)
  })

  it('空の segments 配列は有効', () => {
    const raw = { segments: [] }
    const result = WhisperXResponseSchema.safeParse(raw)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.segments).toHaveLength(0)
    }
  })
})
