import { describe, expect, it } from 'vitest'
import {
  DEFAULT_WHISPERX_LANGUAGE,
  WHISPERX_LANGUAGES,
  isSupportedWhisperxLanguage,
  resolveWhisperxImage,
} from './whisperxLanguages'

describe('WHISPERX_LANGUAGES', () => {
  it('has exactly 41 languages', () => {
    expect(WHISPERX_LANGUAGES).toHaveLength(41)
  })

  it('has no duplicate codes', () => {
    const codes = WHISPERX_LANGUAGES.map((lang) => lang.code)
    expect(new Set(codes).size).toBe(codes.length)
  })

  it('includes ja and en', () => {
    const codes = WHISPERX_LANGUAGES.map((lang) => lang.code)
    expect(codes).toContain('ja')
    expect(codes).toContain('en')
  })

  it('starts with ja then en', () => {
    expect(WHISPERX_LANGUAGES[0]?.code).toBe('ja')
    expect(WHISPERX_LANGUAGES[1]?.code).toBe('en')
  })
})

describe('DEFAULT_WHISPERX_LANGUAGE', () => {
  it('is ja', () => {
    expect(DEFAULT_WHISPERX_LANGUAGE).toBe('ja')
  })
})

describe('isSupportedWhisperxLanguage', () => {
  it('accepts known codes', () => {
    expect(isSupportedWhisperxLanguage('ja')).toBe(true)
    expect(isSupportedWhisperxLanguage('en')).toBe(true)
  })

  it('rejects unknown codes', () => {
    expect(isSupportedWhisperxLanguage('xx')).toBe(false)
    expect(isSupportedWhisperxLanguage('')).toBe(false)
  })
})

describe('resolveWhisperxImage', () => {
  it('builds the expected tag for a supported language', () => {
    expect(resolveWhisperxImage('en')).toBe('ghcr.io/jim60105/whisperx:large-v3-en')
    expect(resolveWhisperxImage('ja')).toBe('ghcr.io/jim60105/whisperx:large-v3-ja')
  })

  it('throws for an unsupported code instead of falling back to the default', () => {
    expect(() => resolveWhisperxImage('xx')).toThrow()
  })
})
