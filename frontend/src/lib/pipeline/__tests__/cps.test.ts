import { describe, it, expect } from 'vitest'
import { calcCps, isCpsOk, checkBlock } from '../utils/cps'

describe('calcCps', () => {
  it('文字数 / 秒数 を小数点1桁で返す', () => {
    expect(calcCps(40, 4)).toBe(10)
    expect(calcCps(30, 2)).toBe(15)
    expect(calcCps(15, 1)).toBe(15)
  })

  it('duration が 0 以下なら 0 を返す', () => {
    expect(calcCps(40, 0)).toBe(0)
    expect(calcCps(40, -1)).toBe(0)
  })

  it('小数点1桁に丸める', () => {
    expect(calcCps(10, 3)).toBe(3.3)
    expect(calcCps(20, 3)).toBe(6.7)
  })
})

describe('isCpsOk', () => {
  it('CPS と文字数が両方制約内なら true', () => {
    expect(isCpsOk(30, 3, 15, 40)).toBe(true)   // CPS=10, chars=30
  })

  it('CPS が超えていたら false', () => {
    expect(isCpsOk(40, 2, 15, 40)).toBe(false)   // CPS=20
  })

  it('文字数が超えていたら false', () => {
    expect(isCpsOk(42, 10, 15, 40)).toBe(false)  // chars=42 > maxChars=40
  })
})

describe('checkBlock', () => {
  it('制約内のブロックは cpsOk=true', () => {
    const result = checkBlock('Hello world', 2, 15, 40)
    expect(result.charCount).toBe(11)
    expect(result.cps).toBe(5.5)
    expect(result.cpsOk).toBe(true)
  })

  it('40文字超えは cpsOk=false', () => {
    const longText = 'A'.repeat(41)
    const result = checkBlock(longText, 10, 15, 40)
    expect(result.cpsOk).toBe(false)
  })
})
