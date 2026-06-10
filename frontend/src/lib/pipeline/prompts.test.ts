import { describe, expect, it } from 'vitest'
import type { AdminSettings } from '@/types/adminSettings'
import {
  FT_SYSTEM_PROMPT_SHORT,
  FULL_SYSTEM_PROMPT_V08,
  buildFtTranslateSystemPrompt,
  buildFullTranslateSystemPrompt,
  resolveCompressSystemPrompt,
  resolveExpandSystemPrompt,
} from './prompts'
import { DEFAULT_LANGUAGE_PROFILE_CONFIG, type LanguageProfileConfig } from './languageProfileConfig'
import { __testing as correctTesting } from './correct'

// #136 対応前にハードコードされていた既定プロンプト。
// 言語ラベルのパラメータ化後も、既定構成（Japanese→English）では完全一致を保証する。
const LEGACY_FULL_SYSTEM_PROMPT_V08 =
  'You are a subtitle translator for academic lectures. Translate each Japanese block into natural English.\n' +
  '\n' +
  'Input format: {"segments": ["seg0", "seg1", "..."]}\n' +
  'Output format: {"translations": ["trans0", "trans1", "..."]}\n' +
  '\n' +
  'MAPPING:\n' +
  '- Output exactly one translation per input block\n' +
  '- Never merge or split blocks\n' +
  '- Output array length must equal input array length\n' +
  '\n' +
  'STYLE:\n' +
  '- casual-academic tone; contractions are fine\n' +
  '- subject and verb first\n' +
  '- avoid front-heavy phrasing and nominalizations\n' +
  '- do not start a block with This/That/It/These if they refer to the previous block\n' +
  '- keep technical terms, proper nouns, formulas, and logical connectors\n' +
  '- restore katakana technical terms to original spelling when obvious\n' +
  '\n' +
  'CONCISENESS:\n' +
  '- omit filler phrases that carry no information: "it seems that", "apparently", "in this manner", "By the way"\n' +
  '- convert 5W1H noun clauses to simple nouns: "how many layers to have" → "the number of layers"\n' +
  '- replace idioms and metaphors with direct wording; non-native readers need immediate clarity\n' +
  '- slides are not visible to viewers: replace vague references with concrete terms when the Japanese names them\n' +
  '- brief informal asides from the lecturer ("This might seem complicated") may be kept to preserve lecture tone\n' +
  '\n' +
  'FAITHFULNESS (anti-hallucination):\n' +
  '- never invent proper nouns (person names, organization names, place names) that are not in the source\n' +
  '- only use a specific person name if it is explicitly written in the source Japanese\n' +
  '- when the Japanese says "I" / "私" / "先生" or refers to a role without naming, render it as "I" / "the lecturer" / etc., NOT a made-up name\n' +
  '- do not add facts, numbers, dates, or technical details that are not in the source\n' +
  '- do not infer beyond what the source states; preserve the lecturer\'s level of specificity'

const LEGACY_FT_SYSTEM_PROMPT_SHORT =
  'Translate Japanese lecture subtitles into concise English. Keep one output per input. ' +
  'Do not merge or split blocks. Use natural casual-academic wording. Preserve technical terms. ' +
  'Never invent proper nouns or facts not in the source Japanese.'

const LEGACY_JAPANESE_CORRECTION_PROMPT =
  'あなたは日本語書き起こしテキストの校正専門家です。\n' +
  '\n' +
  'Input format:  {"segments": [{"id": N, "text": "..."}]}\n' +
  'Output format: {"corrections": [{"id": N, "text": "..."}]}\n' +
  '\n' +
  '修正ルール:\n' +
  '1. フィラー語を除去（えー、ええ、あの、あのー、えーと、そのー、まあ、ちょっと等）\n' +
  '2. 専門用語リストにある誤認識を正しい表記に修正\n' +
  '3. 口語表現を自然な書き言葉に整える\n' +
  '4. ASR由来の明らかな誤変換・同音異義語ミス・文脈上不自然な語を、自然で意味の通る日本語に修正する\n' +
  '5. 数量・件数・時制・主語述語の対応を文脈に合わせて整える\n' +
  '6. 文の意味・情報量は変えない（要約・追加は禁止）\n' +
  '\n' +
  'ASR誤変換の扱い:\n' +
  '- 文として意味が通らない場合は、最も尤もらしい元の表現へ修正してよい\n' +
  '- 例: 誤字、脱字、助詞抜け、同音異義語、専門語の聞き間違い、漢字変換ミス\n' +
  '- ただし推測で新情報を足さない。文脈から強く支持される修正だけ行う\n' +
  '\n' +
  'CRITICAL: Output EXACTLY one correction per input segment. Array length MUST equal input array length.\n' +
  '意味を大きく変える修正は絶対にしないこと。'

const FRENCH_GERMAN_PROFILE: LanguageProfileConfig = {
  subtitle: { label: 'French', script: 'latin' },
  transcript: { label: 'German', script: 'latin' },
}

function makeSettings(overrides: Partial<AdminSettings> = {}): AdminSettings {
  return {
    enMaxCharsPerLine: 42,
    enMaxLines: 2,
    enMaxCps: 17,
    subtitleLanguageLabel: 'English',
    transcriptLanguageLabel: 'Japanese',
    languageProfileConfigJson: '',
    correctionAdditionalInstructions: '',
    correctionFewShotJson: '',
    ...overrides,
  } as AdminSettings
}

describe('translate system prompts', () => {
  it('既定の言語プロファイルでは従来のハードコードプロンプトと完全一致する', () => {
    expect(buildFullTranslateSystemPrompt(DEFAULT_LANGUAGE_PROFILE_CONFIG)).toBe(LEGACY_FULL_SYSTEM_PROMPT_V08)
    expect(FULL_SYSTEM_PROMPT_V08).toBe(LEGACY_FULL_SYSTEM_PROMPT_V08)
    expect(buildFtTranslateSystemPrompt(DEFAULT_LANGUAGE_PROFILE_CONFIG)).toBe(LEGACY_FT_SYSTEM_PROMPT_SHORT)
    expect(FT_SYSTEM_PROMPT_SHORT).toBe(LEGACY_FT_SYSTEM_PROMPT_SHORT)
  })

  it('非日本語プロファイルでは設定の言語ラベルが注入され、日本語固有行は含まれない', () => {
    const prompt = buildFullTranslateSystemPrompt(FRENCH_GERMAN_PROFILE)
    expect(prompt).toContain('Translate each German block into natural French.')
    expect(prompt).toContain('explicitly written in the source German')
    expect(prompt).not.toContain('Japanese')
    expect(prompt).not.toContain('katakana')
    expect(prompt).not.toContain('私')

    const ftPrompt = buildFtTranslateSystemPrompt(FRENCH_GERMAN_PROFILE)
    expect(ftPrompt).toContain('Translate German lecture subtitles into concise French.')
    expect(ftPrompt).not.toContain('Japanese')
  })
})

describe('compress / expand system prompts', () => {
  it('既定設定では従来文字列と完全一致する', () => {
    expect(resolveCompressSystemPrompt(makeSettings())).toBe(
      'You are a subtitle editor. This subtitle is too long and must be shortened. ' +
      'It must fit on 2 lines of 42 characters each when displayed. ' +
      'Shorten the English text while preserving the key meaning. Make it as concise as possible. ' +
      'Do not include line breaks in your response. ' +
      'Respond with JSON: {"text": "<shortened subtitle>"}',
    )
    expect(resolveExpandSystemPrompt(makeSettings())).toBe(
      'You are a subtitle translator. This subtitle is over-compressed and too brief compared to the Japanese source. ' +
      'It will be displayed on 2 lines of 42 characters each at 17 CPS. ' +
      'Expand it to be more complete and natural while staying concise. ' +
      'Do not include line breaks in your response. ' +
      'Respond with JSON: {"text": "<expanded subtitle>"}',
    )
  })

  it('言語ラベル設定がプロンプトへ反映される', () => {
    const settings = makeSettings({ subtitleLanguageLabel: 'French', transcriptLanguageLabel: 'German' })
    expect(resolveCompressSystemPrompt(settings)).toContain('Shorten the French text')
    expect(resolveExpandSystemPrompt(settings)).toContain('compared to the German source')
  })

  it('override 指定時は override がそのまま使われる', () => {
    expect(resolveCompressSystemPrompt(makeSettings(), '  custom  ')).toBe('custom')
    expect(resolveExpandSystemPrompt(makeSettings(), 'custom expand')).toBe('custom expand')
  })
})

describe('correction system prompt', () => {
  it('transcript が日本語スクリプトの構成では従来の日本語プロンプトと完全一致する', () => {
    expect(correctTesting.buildCorrectionSystemPrompt(makeSettings())).toBe(LEGACY_JAPANESE_CORRECTION_PROMPT)
  })

  it('correctionAdditionalInstructions は従来同様に末尾へ連結される', () => {
    const settings = makeSettings({ correctionAdditionalInstructions: '追加ルール' })
    expect(correctTesting.buildCorrectionSystemPrompt(settings)).toBe(
      `${LEGACY_JAPANESE_CORRECTION_PROMPT}\n\n追加ルール`,
    )
  })

  it('非日本語プロファイルでは transcript ラベル入りの汎用プロンプトへ分岐する', () => {
    const settings = makeSettings({
      subtitleLanguageLabel: 'French',
      transcriptLanguageLabel: 'German',
      languageProfileConfigJson: JSON.stringify(FRENCH_GERMAN_PROFILE),
    })
    const prompt = correctTesting.buildCorrectionSystemPrompt(settings)
    expect(prompt).toContain('You are an expert proofreader for German ASR (speech recognition) transcripts.')
    expect(prompt).toContain('Output EXACTLY one correction per input segment.')
    expect(prompt).not.toContain('日本語')
  })

  it('few-shot: 日本語構成では組み込み例、非日本語構成ではユーザー指定が無ければ空', () => {
    expect(correctTesting.resolveCorrectionFewShotMessages(makeSettings())).toHaveLength(2)

    const germanSettings = makeSettings({
      transcriptLanguageLabel: 'German',
      languageProfileConfigJson: JSON.stringify(FRENCH_GERMAN_PROFILE),
    })
    expect(correctTesting.resolveCorrectionFewShotMessages(germanSettings)).toHaveLength(0)

    const withCustom = makeSettings({
      transcriptLanguageLabel: 'German',
      languageProfileConfigJson: JSON.stringify(FRENCH_GERMAN_PROFILE),
      correctionFewShotJson: JSON.stringify({
        segments: [{ id: 1, text: 'ähm, das ist ein Test' }],
        corrections: [{ id: 1, text: 'Das ist ein Test.' }],
      }),
    })
    expect(correctTesting.resolveCorrectionFewShotMessages(withCustom)).toHaveLength(2)
  })
})
