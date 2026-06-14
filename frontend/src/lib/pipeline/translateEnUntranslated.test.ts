import { describe, expect, it } from 'vitest'
import type { LanguageRoleProfile } from './languageProfileConfig'
import { __testing } from './translateEn'

const { looksUntranslated } = __testing

const EN_TARGET: LanguageRoleProfile = { label: 'English', script: 'latin' }
const JA_TARGET: LanguageRoleProfile = { label: 'Japanese', script: 'japanese' }
const CN_TARGET: LanguageRoleProfile = {
  label: '中文',
  script: 'generic',
  translatedCharPattern: '[\\u4e00-\\u9fff]',
}

describe('looksUntranslated — 日本語→英語（既存方向のセーフティネット維持）', () => {
  it('英語に訳せていれば未翻訳ではない', () => {
    expect(looksUntranslated('機械学習とは何ですか。', 'What is machine learning?', EN_TARGET)).toBe(false)
  })

  it('日本語が残っていれば（英字略語混じりでも）未翻訳と判定する', () => {
    expect(looksUntranslated('これはRAGです。', 'これはRAGです。', EN_TARGET)).toBe(true)
  })

  it('同一文字列はリトライ対象', () => {
    expect(looksUntranslated('Hello', 'Hello', EN_TARGET)).toBe(true)
  })
})

describe('looksUntranslated — 英語→日本語（バグBの本質修正）', () => {
  it('日本語に訳せていれば未翻訳ではない', () => {
    expect(looksUntranslated('I love this library.', 'このライブラリが大好きです。', JA_TARGET)).toBe(false)
  })

  it('英字略語を含む自然な日本語は未翻訳ではない', () => {
    expect(looksUntranslated('We use RAG and LSTM.', 'RAGとLSTMを使う', JA_TARGET)).toBe(false)
  })

  it('漢字のみの固有名詞訳も未翻訳ではない', () => {
    expect(looksUntranslated('University of Tokyo', '東京大学', JA_TARGET)).toBe(false)
  })

  it('英語のままなら未翻訳と判定する', () => {
    expect(looksUntranslated('I love this library.', 'I love this library.', JA_TARGET)).toBe(true)
  })
})

describe('looksUntranslated — 英語→中国語（translatedCharPattern によるデータ駆動判定）', () => {
  it('中国語に訳せていれば未翻訳ではない', () => {
    expect(looksUntranslated('We use RAG.', '我们使用RAG。', CN_TARGET)).toBe(false)
  })

  it('英語のままなら未翻訳と判定する', () => {
    expect(looksUntranslated('We use it.', 'We use it.', CN_TARGET)).toBe(true)
  })
})
