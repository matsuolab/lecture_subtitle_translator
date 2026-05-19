import { describe, expect, it } from 'vitest'
import { buildMacAssetUrl } from './macAssetUrl'

describe('buildMacAssetUrl', () => {
  it('keeps slash delimiters for plain absolute paths', () => {
    expect(buildMacAssetUrl('/Users/foo/bar.mp4').url).toBe('asset://localhost/Users/foo/bar.mp4')
  })

  it('encodes precomposed Japanese path segments', () => {
    expect(buildMacAssetUrl('/Users/x/翻訳/DL_day4.mp4').url).toBe(
      'asset://localhost/Users/x/%E7%BF%BB%E8%A8%B3/DL_day4.mp4',
    )
  })

  it('encodes spaces inside segments', () => {
    expect(buildMacAssetUrl('/Users/x/My Videos/a.mp4').url).toBe(
      'asset://localhost/Users/x/My%20Videos/a.mp4',
    )
  })

  it('encodes URL special characters inside segments', () => {
    expect(buildMacAssetUrl('/Users/x/a+b#c%d.mp4').url).toBe(
      'asset://localhost/Users/x/a%2Bb%23c%25d.mp4',
    )
  })

  it('preserves NFC accent bytes by encoding them as given', () => {
    expect(buildMacAssetUrl('/Users/x/café.mp4').url).toBe(
      'asset://localhost/Users/x/caf%C3%A9.mp4',
    )
  })

  it('preserves NFD accent bytes by encoding them as given', () => {
    expect(buildMacAssetUrl('/Users/x/cafe\u0301.mp4').url).toBe(
      'asset://localhost/Users/x/cafe%CC%81.mp4',
    )
  })

  it('documents current behavior for backslash input', () => {
    expect(buildMacAssetUrl('C:\\Users\\x\\a.mp4').url).toBe(
      'asset://localhostC%3A/Users/x/a.mp4',
    )
  })

  it('documents current behavior for double leading slashes', () => {
    expect(buildMacAssetUrl('//Users/x/a.mp4').url).toBe('asset://localhost//Users/x/a.mp4')
  })

  it('documents current behavior for trailing slash', () => {
    expect(buildMacAssetUrl('/Users/x/').url).toBe('asset://localhost/Users/x/')
  })
})
