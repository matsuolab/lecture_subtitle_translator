import { describe, it, expect } from 'vitest'
import { secondsToSrtTimestamp, srtTimestampToSeconds, serializeToSrt } from '../utils/srtSerialize'

describe('secondsToSrtTimestamp', () => {
  it('0秒を正しく変換する', () => {
    expect(secondsToSrtTimestamp(0)).toBe('00:00:00,000')
  })

  it('1時間2分3秒456ミリ秒を変換する', () => {
    expect(secondsToSrtTimestamp(3723.456)).toBe('01:02:03,456')
  })

  it('59分59秒999ミリ秒を変換する', () => {
    expect(secondsToSrtTimestamp(3599.999)).toBe('00:59:59,999')
  })

  it('ミリ秒を正しく丸める', () => {
    expect(secondsToSrtTimestamp(1.0005)).toBe('00:00:01,001')
  })
})

describe('srtTimestampToSeconds', () => {
  it('00:00:00,000 を 0 に変換する', () => {
    expect(srtTimestampToSeconds('00:00:00,000')).toBe(0)
  })

  it('01:02:03,456 を秒に変換する', () => {
    expect(srtTimestampToSeconds('01:02:03,456')).toBeCloseTo(3723.456)
  })

  it('不正な形式はエラーを投げる', () => {
    expect(() => srtTimestampToSeconds('1:2:3')).toThrow()
  })
})

describe('serializeToSrt', () => {
  it('SRT ファイル形式に変換する', () => {
    const blocks = [
      { id: 1, start: 0, end: 2.5, text: 'Hello world' },
      { id: 2, start: 3.0, end: 5.0, text: 'Goodbye world' },
    ]
    const result = serializeToSrt(blocks)
    expect(result).toContain('1\n00:00:00,000 --> 00:00:02,500\nHello world')
    expect(result).toContain('2\n00:00:03,000 --> 00:00:05,000\nGoodbye world')
  })
})
