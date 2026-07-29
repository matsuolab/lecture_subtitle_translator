import { describe, expect, it } from 'vitest'
import type { GlossaryEntry } from '@/context/GlossaryContext'
import { DEFAULT_LANGUAGE_PROFILE_CONFIG, type LanguageProfileConfig } from '@/lib/pipeline/languageProfileConfig'
import {
  DEFAULT_GLOSSARY_ROLES,
  findMatchedGlossaryEntries,
  findMissingTranslations,
  findTypoCandidates,
  resolveGlossaryRoles,
  toSubtitleTerms,
  toTranscriptTerms,
} from './glossaryApply'

const EN_TO_JA_LANGUAGES: LanguageProfileConfig = {
  subtitle: { label: 'Japanese', script: 'japanese' },
  transcript: { label: 'English', script: 'latin' },
}

const EN_TO_JA_ROLES = resolveGlossaryRoles(EN_TO_JA_LANGUAGES)

function entry(partial: Partial<GlossaryEntry> & Pick<GlossaryEntry, 'ja' | 'en'>): GlossaryEntry {
  return {
    id: `${partial.ja}-${partial.en}`,
    abbr: undefined,
    confirmed: true,
    ...partial,
  } as GlossaryEntry
}

const GLOSSARY: GlossaryEntry[] = [
  entry({ ja: '機械学習', en: 'machine learning' }),
  entry({ ja: '誤差逆伝播法', en: 'backpropagation' }),
  entry({ ja: '学習', en: 'learning' }),
]

describe('resolveGlossaryRoles', () => {
  it('既定（日→英）では subtitle=en / transcript=ja', () => {
    expect(resolveGlossaryRoles(DEFAULT_LANGUAGE_PROFILE_CONFIG)).toEqual(DEFAULT_GLOSSARY_ROLES)
    expect(DEFAULT_GLOSSARY_ROLES).toEqual({ subtitle: 'en', transcript: 'ja' })
  })

  it('英→日では入れ替わる', () => {
    expect(EN_TO_JA_ROLES).toEqual({ subtitle: 'ja', transcript: 'en' })
  })

  it('未知言語の字幕は既定にフォールバックする', () => {
    expect(resolveGlossaryRoles({
      subtitle: { label: '中文', script: 'generic' },
      transcript: { label: 'English', script: 'latin' },
    })).toEqual(DEFAULT_GLOSSARY_ROLES)
  })
})

describe('findMatchedGlossaryEntries — 既定（日→英）', () => {
  it('字幕=英語 / 書きおこし=日本語 の両方でマッチする', () => {
    const matched = findMatchedGlossaryEntries(
      'We apply machine learning here.',
      'ここで機械学習を使います。',
      GLOSSARY,
    )
    const ml = matched.find(m => m.entry.en === 'machine learning')
    expect(ml?.inSubtitle).toBe(true)
    expect(ml?.inTranscript).toBe(true)
  })

  it('字幕ペインには英語表記、書きおこしペインには日本語表記を出す', () => {
    const matched = findMatchedGlossaryEntries(
      'We apply machine learning here.',
      'ここで機械学習を使います。',
      GLOSSARY,
    )
    expect(toSubtitleTerms(matched).map(t => t.word)).toContain('machine learning')
    expect(toTranscriptTerms(matched).map(t => t.word)).toContain('機械学習')
  })
})

describe('findMatchedGlossaryEntries — 英→日', () => {
  it('字幕=日本語 / 書きおこし=英語 でマッチする', () => {
    const matched = findMatchedGlossaryEntries(
      'ここで機械学習を使います。',
      'We apply machine learning here.',
      GLOSSARY,
      EN_TO_JA_ROLES,
    )
    const ml = matched.find(m => m.entry.en === 'machine learning')
    expect(ml?.inSubtitle).toBe(true)
    expect(ml?.inTranscript).toBe(true)
  })

  it('日本語用語は単語境界なしで検出する（\\b では一致しないため）', () => {
    // 役割入れ替え前は字幕(日本語)に \b つき正規表現を当てており、常に不一致だった。
    const matched = findMatchedGlossaryEntries(
      '誤差逆伝播法を適用します。',
      'We apply backpropagation.',
      GLOSSARY,
      EN_TO_JA_ROLES,
    )
    const bp = matched.find(m => m.entry.en === 'backpropagation')
    expect(bp?.inSubtitle).toBe(true)
  })

  it('ペイン表記も入れ替わる', () => {
    const matched = findMatchedGlossaryEntries(
      'ここで機械学習を使います。',
      'We apply machine learning here.',
      GLOSSARY,
      EN_TO_JA_ROLES,
    )
    expect(toSubtitleTerms(matched).map(t => t.word)).toContain('機械学習')
    expect(toTranscriptTerms(matched).map(t => t.word)).toContain('machine learning')
  })
})

describe('findMissingTranslations — 既定（日→英）', () => {
  it('書きおこしにある用語が字幕に無ければ検出する', () => {
    const missing = findMissingTranslations(
      'ここで機械学習を使います。',
      'We use it here.',
      GLOSSARY,
    )
    expect(missing.map(m => m.entry.en)).toContain('machine learning')
  })

  it('字幕に対応語があれば検出しない', () => {
    const missing = findMissingTranslations(
      'ここで機械学習を使います。',
      'We use machine learning here.',
      GLOSSARY,
    )
    expect(missing.map(m => m.entry.en)).not.toContain('machine learning')
  })

  it('長い用語を優先し、部分一致する短い用語を二重検出しない', () => {
    // 「機械学習」がヒットした後に「学習」が別途 flag されないこと
    const missing = findMissingTranslations(
      'ここで機械学習を使います。',
      'We use it here.',
      GLOSSARY,
    )
    expect(missing.map(m => m.entry.ja)).toEqual(['機械学習'])
  })
})

describe('findMissingTranslations — 英→日', () => {
  it('英語書きおこしの用語が日本語字幕に無ければ検出する', () => {
    const missing = findMissingTranslations(
      'We use machine learning here.',
      'ここで使います。',
      GLOSSARY,
      EN_TO_JA_ROLES,
    )
    expect(missing.map(m => m.entry.ja)).toContain('機械学習')
  })

  it('日本語字幕に対応語があれば検出しない', () => {
    const missing = findMissingTranslations(
      'We use machine learning here.',
      'ここで機械学習を使います。',
      GLOSSARY,
      EN_TO_JA_ROLES,
    )
    expect(missing.map(m => m.entry.ja)).not.toContain('機械学習')
  })
})

describe('findTypoCandidates', () => {
  it('英語字幕では従来どおりタイポを検出する', () => {
    const candidates = findTypoCandidates('We use mashine learning here.', GLOSSARY, 'en')
    expect(candidates.length).toBeGreaterThan(0)
  })

  it('field 未指定でも英語として扱う（後方互換）', () => {
    expect(findTypoCandidates('We use mashine learning here.', GLOSSARY).length).toBeGreaterThan(0)
  })

  it('日本語字幕では検出しない（綴りの概念が無いため）', () => {
    expect(findTypoCandidates('ここで機械学習を使います。', GLOSSARY, 'ja')).toEqual([])
  })
})
