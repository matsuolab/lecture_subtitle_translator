import { describe, expect, it } from 'vitest'
import type { AdminSettings } from '@/types/adminSettings'
import type { EnBlock, PipelineThresholds } from './blockTypes'
import {
  DEFAULT_LANGUAGE_PROFILE_CONFIG,
  type LanguageProfileConfig,
} from './languageProfileConfig'
import { buildSubtitleEditUserContent } from './correctionAgent/tools/subtitleEditPrompt'
import { __testing as splitBlockTesting } from './correctionAgent/tools/splitBlock'
import { __testing as semanticSplitTesting } from './semanticSplitJa'
import { __testing as decisionTesting } from './correctionAgent/decisionNode'
import { __testing as translateTesting } from './translate'
import { __testing as translateEnTesting } from './translateEn'
import { __testing as correctTesting } from './correct'
import { __testing as generalRepairTesting } from './generalRepairAgent'
import { buildReviewItemsForBlock } from './reviewDiagnostics'
import type { AgentThresholds, CorrectionStrategy, DecisionContext } from './correctionAgent/types'

// #136 と同じ方針: 設定の言語プロファイルからプロンプトを組み立てるが、
// 既定構成（Japanese→English, transcript.script='japanese'）では従来のハードコード文字列とバイト一致する。
const FRENCH_GERMAN_PROFILE: LanguageProfileConfig = {
  subtitle: { label: 'French', script: 'latin' },
  transcript: { label: 'German', script: 'latin' },
}

describe('compress 系 user content（subtitleEditPrompt）', () => {
  it('既定構成では従来のハードコード文字列とバイト一致する', () => {
    expect(
      buildSubtitleEditUserContent(DEFAULT_LANGUAGE_PROFILE_CONFIG, 'jaText', 'enLine', '\n\nbudgetHint'),
    ).toBe('Japanese source:\njaText\n\nCurrent English subtitle:\nenLine\n\nbudgetHint')
  })

  it('tail 省略時は末尾の追記なし（compress_micro の removedHint 空ケース）', () => {
    expect(
      buildSubtitleEditUserContent(DEFAULT_LANGUAGE_PROFILE_CONFIG, 'jaText', 'enLine'),
    ).toBe('Japanese source:\njaText\n\nCurrent English subtitle:\nenLine')
  })

  it('言語ラベルが注入される', () => {
    expect(
      buildSubtitleEditUserContent(FRENCH_GERMAN_PROFILE, 'src', 'sub', ''),
    ).toBe('German source:\nsrc\n\nCurrent French subtitle:\nsub')
  })
})

describe('split_block プロンプト', () => {
  it('日本語 transcript では計測済みの「継ぎ目のみ書き換え可」プロンプトをそのまま使う', () => {
    expect(splitBlockTesting.pickSplitSystemPrompt(DEFAULT_LANGUAGE_PROFILE_CONFIG)).toBe(
      splitBlockTesting.JAPANESE_SPLIT_SYSTEM_PROMPT,
    )
    expect(splitBlockTesting.JAPANESE_SPLIT_SYSTEM_PROMPT).toBe(
      'この日本語の講義書き起こしを、2〜3個の字幕単位に分割してください。\n' +
      '\n' +
      '厳守事項:\n' +
      '- 各単位は原文の文字列をそのまま使うこと。語順の変更・言い換え・要約・語句の追加は禁止。\n' +
      '- 唯一許される変更は、各単位の末尾を完結した文にするための最小限の修正のみ。\n' +
      '  例: 「〜しておりますので、」→「〜しております。」\n' +
      '      「〜を理解し、」→「〜を理解します。」\n' +
      '- 本文の圧縮やフィラーの削除は禁止。原文の情報を落とさないこと。\n' +
      '- 各単位は文として完結していること（助詞や接続助詞で終わらない）。\n' +
      '- 安全に分割できない場合は {"cannot_split": true, "units": []} を返すこと。\n' +
      '\n' +
      '出力はJSONのみ: {"units":[{"text":"..."}]}',
    )
    expect(splitBlockTesting.buildSingleTranslateSystem('Japanese', 'English')).toBe(
      'Translate this Japanese subtitle text into natural English. ' +
      'Keep technical terms, proper nouns, and formulas. Use casual-academic tone. Contractions are fine. ' +
      'The subtitle must make sense on its own. Do not start with This, That, It, or These when they refer to previous context. ' +
      'Repeat the noun when needed. Keep logical connectors, conditions, negations, numbers, and definitions. ' +
      'Use concise subtitle wording without adding explanations. ' +
      'Respond with JSON: {"text": "<translation>"}',
    )
  })

  it('非日本語 transcript では継ぎ目のみ書き換え可の英語版プロンプトを使う', () => {
    const prompt = splitBlockTesting.pickSplitSystemPrompt(FRENCH_GERMAN_PROFILE)
    expect(prompt).toBe(splitBlockTesting.buildSplitSystemPrompt('German'))
    expect(prompt).toContain('Resegment this German academic lecture transcript')
    expect(prompt).toContain('reuse the source wording verbatim')
    expect(prompt).not.toBe(splitBlockTesting.JAPANESE_SPLIT_SYSTEM_PROMPT)
  })

  it('言語ラベルが注入される', () => {
    expect(splitBlockTesting.buildSplitSystemPrompt('German')).toContain('Resegment this German academic lecture transcript')
    expect(splitBlockTesting.buildSingleTranslateSystem('German', 'French')).toContain('Translate this German subtitle text into natural French.')
  })
})

describe('semanticSplit プロンプト', () => {
  it('既定構成（日本語）ではカタカナ保持ルールと日本語例示を含む', () => {
    const prompt = semanticSplitTesting.buildSemanticSplitPrompt([], DEFAULT_LANGUAGE_PROFILE_CONFIG)
    expect(prompt).toContain('Split corrected Japanese lecture transcript')
    expect(prompt).toContain('Each unit should be a natural Japanese phrase/sentence')
    expect(prompt).toContain('Keep technical terms and katakana words intact.')
    expect(prompt).toContain('自然な日本語の意味単位')
  })

  it('非日本語構成ではカタカナ保持ルールと日本語例示を含まない', () => {
    const prompt = semanticSplitTesting.buildSemanticSplitPrompt([], FRENCH_GERMAN_PROFILE)
    expect(prompt).toContain('Split corrected German lecture transcript')
    expect(prompt).toContain('Each unit should be a natural German phrase/sentence')
    expect(prompt).toContain('Keep technical terms intact.')
    expect(prompt).not.toContain('katakana')
    expect(prompt).not.toContain('自然な日本語の意味単位')
  })
})

describe('translate（レガシー）システムプロンプト', () => {
  it('既定構成では従来文字列とバイト一致する', () => {
    expect(translateTesting.buildTranslateSystemPrompt(DEFAULT_LANGUAGE_PROFILE_CONFIG)).toBe(
      'You are a subtitle translator for academic lectures. Translate each Japanese segment into natural English.\n' +
      '\n' +
      'Input format:  {"segments": ["seg0", "seg1", ...]}\n' +
      'Output format: {"translations": ["trans0", "trans1", ...]}\n' +
      '\n' +
      'MAPPING (CRITICAL):\n' +
      '- translations[i] is the English translation of segments[i]\n' +
      '- Output EXACTLY one translation per input segment\n' +
      '- NEVER merge or split segments\n' +
      '- Output array length MUST equal input array length\n' +
      '\n' +
      'STYLE (BBC/Netflix subtitle standards):\n' +
      '- casual-academic tone; contractions are fine (we\'ll, it\'s, don\'t)\n' +
      '- Short sentences; subject and verb first\n' +
      '- Avoid front-heavy structures — NOT "To solve X, we..." → "We solved X by..."\n' +
      '- Never use "What we do is..." / "What this means is..." patterns\n' +
      '- Avoid nominalizations: "use" not "utilization", "show" not "demonstrate"\n' +
      '\n' +
      'STANDALONE RULE:\n' +
      '- Each block appears alone on screen; the viewer cannot look back\n' +
      '- Never start a block with "This", "That", "It", or "These" referring to the previous block — repeat the noun instead\n' +
      '\n' +
      'TERMINOLOGY:\n' +
      '- Preserve technical terms exactly as-is: RAG, HyDE, LLM, ReAct, etc.\n' +
      '- Never translate framework, algorithm, or product names\n' +
      '- Katakana-rendered terms: restore to original form (ハイド → HyDE, リアクト → ReAct)',
    )
    expect(translateTesting.buildTranslateFewShot(DEFAULT_LANGUAGE_PROFILE_CONFIG)).toHaveLength(2)
  })

  it('非日本語構成ではカタカナ復元行と日本語 few-shot を含まない', () => {
    const prompt = translateTesting.buildTranslateSystemPrompt(FRENCH_GERMAN_PROFILE)
    expect(prompt).toContain('Translate each German segment into natural French.')
    expect(prompt).not.toContain('Katakana')
    expect(translateTesting.buildTranslateFewShot(FRENCH_GERMAN_PROFILE)).toHaveLength(0)
  })
})

const LEGACY_GENERAL_REPAIR_PROMPT = `You are GeneralRepairAgent — the LAST repair pass for academic lecture subtitles.

The pipeline has already tried rule-based corrections. What remains are the hardest cases.
You get one more chance per effort level (low → medium → high). If you cannot fix it, the block
goes to manual_review.

You will be given:
- chunk_blocks: all blocks for the current chunk, in time order, with current violations and correction history.
- residual_violations: per-block violations (cps_over, line_length_only, long_segment, etc.).
- constraints: hard limits (max_cps, max_chars_per_line, max_segment_chars, min_duration, etc.). MUST respect.

Your job: rewrite the affected cues' en text to resolve as many violations as possible.

Rules:
- Return JSON only: { "rationale": "...", "rewrites": [{ "block_id": N, "en": "..." }] }
- Only return rewrites for the cues you want to change. Other cues stay as-is.
- You may modify en ONLY (to fix CPS/line/length). The ja_span (source Japanese) is fixed
  and must NOT be changed — it is shown to you only as translation context.
- Preserve the cue's start/end timing (you do NOT modify timing).
- Compute allowed en chars as floor(duration_sec × max_cps). Stay within this budget.
- Respect max_chars_per_line per line and max_segment_chars total.
- Do not add content not in the source Japanese.
- Preserve technical terms / formulas exactly (post-correctJa form).
- Do not invent proper nouns (person names, organization names) that are not in source.
- Use correction_attempts history to AVOID repeating strategies that already failed.
- If you cannot repair a cue without violating constraints, leave it out of rewrites and explain in rationale.`

describe('repair agent システムプロンプト', () => {
  it('既定構成では従来の日本語前提プロンプトとバイト一致する', () => {
    expect(generalRepairTesting.buildSystemPrompt('Japanese')).toBe(LEGACY_GENERAL_REPAIR_PROMPT)
  })

  it('transcript ラベルが注入され Japanese が残らない', () => {
    const general = generalRepairTesting.buildSystemPrompt('German')
    expect(general).toContain('Do not add content not in the source German.')
    expect(general).not.toContain('Japanese')
  })
})

const thresholds: PipelineThresholds & AgentThresholds = {
  shortDurationSec: 1.5,
  longDurationSec: 10,
  mergedLongDurationSec: 7,
  overCompressedRatio: 0.25,
  overCompressedJaChars: 15,
  verboseCps: 16.9,
  maxLineLen: 42,
  slowCps: 3,
  maxExpandPerBlock: 3,
  maxCompressPerBlock: 5,
  maxCorrectionRounds: 4,
  minMeaningfulChars: 20,
  minInterSubtitleGapMs: 80,
  minUsefulBorrowMs: 250,
  maxLeadMs: 300,
  maxLagMs: 700,
  minReductionDeltaChars: 4,
  minReductionDeltaRatio: 0.03,
  subtitleMinDurationSec: 0.833,
  maxSplitDepth: 1,
  enableOffloadNeighbor: false,
  useAgentDecision: false,
}

function makeSettings(overrides: Partial<AdminSettings> = {}): AdminSettings {
  return {
    subtitleLanguageLabel: 'English',
    transcriptLanguageLabel: 'Japanese',
    languageProfileConfigJson: '',
    ...overrides,
  } as AdminSettings
}

function makeDecisionContext(settings: AdminSettings): DecisionContext {
  const block: EnBlock = {
    id: 1,
    start: 0,
    end: 4,
    jaText: '日本語のテキスト',
    jaChars: 8,
    enText: 'English subtitle text',
    enRaw: 'English subtitle text',
    enChars: 21,
    cps: 5,
    maxLineLen: 21,
    violation: 'cps_over',
    alignConf: 'exact',
    merged: false,
    expandCount: 0,
    compressCount: 0,
  }
  return {
    block,
    blockIndex: 0,
    gapBeforeMs: 0,
    gapAfterMs: 0,
    physicalMaxChars: 60,
    neighborSlack: {},
    attemptHistory: [],
    thresholds,
    settings,
  }
}

describe('LLM decision プロンプトの strategy 説明', () => {
  const feasible: CorrectionStrategy[] = ['split_block', 'compress_rephrase']

  it('既定構成では split_block の説明が従来文字列と一致する', () => {
    const prompt = decisionTesting.buildDecisionPrompt(makeDecisionContext(makeSettings()), feasible)
    expect(prompt).toContain('Split Japanese into 2 semantic sentences, re-translate each')
  })

  it('transcript ラベルが注入される', () => {
    const settings = makeSettings({
      transcriptLanguageLabel: 'German',
      languageProfileConfigJson: JSON.stringify(FRENCH_GERMAN_PROFILE),
    })
    const prompt = decisionTesting.buildDecisionPrompt(makeDecisionContext(settings), feasible)
    expect(prompt).toContain('Split German into 2 semantic sentences, re-translate each')
  })
})

describe('reviewDiagnostics の言語プロファイル分岐', () => {
  function fragmentBlock(): EnBlock {
    return {
      id: 1,
      start: 0,
      end: 4,
      jaText: 'これを用いて、',
      jaChars: 6,
      enText: 'using this',
      enRaw: 'using this',
      enChars: 10,
      cps: 2.5,
      maxLineLen: 10,
      violation: 'ok',
      alignConf: 'exact',
      merged: false,
      expandCount: 0,
      compressCount: 0,
    }
  }

  it('既定（英語字幕）では文脈依存の断片として検出する', () => {
    const items = buildReviewItemsForBlock(fragmentBlock(), thresholds, DEFAULT_LANGUAGE_PROFILE_CONFIG)
    expect(items.some((item) => item.reason === 'context_dependent_fragment')).toBe(true)
  })

  it('非ラテン字幕構成ではラテン断片ヒューリスティックを適用しない', () => {
    const japaneseSubtitleProfile: LanguageProfileConfig = {
      subtitle: { label: 'Japanese', script: 'japanese' },
      transcript: { label: 'English', script: 'latin' },
    }
    const items = buildReviewItemsForBlock(fragmentBlock(), thresholds, japaneseSubtitleProfile)
    // transcript=English（continuationEndPattern 既定なし）→ source 継続でも断片化しない
    expect(items.some((item) => item.reason === 'context_dependent_fragment')).toBe(false)
  })
})

describe('組み込み few-shot は言語ペアごとに切り替わる', () => {
  const EN_TO_JA_PROFILE: LanguageProfileConfig = {
    subtitle: { label: 'Japanese', script: 'japanese' },
    transcript: { label: 'English', script: 'latin' },
  }

  function settingsFor(profile: LanguageProfileConfig, overrides: Partial<AdminSettings> = {}): AdminSettings {
    return {
      subtitleLanguageLabel: profile.subtitle.label,
      transcriptLanguageLabel: profile.transcript.label,
      languageProfileConfigJson: '',
      correctionFewShotJson: '',
      translationFewShotJson: '',
      correctionAdditionalInstructions: '',
      ...overrides,
    } as AdminSettings
  }

  it('英→日構成では日本語字幕の例が入る', () => {
    const { fewShotSegments, fewShotTranslations } =
      translateEnTesting.resolveTranslationFewShot('', EN_TO_JA_PROFILE)
    expect(fewShotSegments.length).toBeGreaterThan(0)
    expect(fewShotSegments.length).toBe(fewShotTranslations.length)
    // 原文=英語 / 訳文=日本語 になっていること
    expect(fewShotSegments.join('')).toMatch(/[A-Za-z]/)
    expect(fewShotTranslations.join('')).toMatch(/[぀-ヿ㐀-䶿一-鿿]/)
  })

  it('日→英構成は従来どおり英語訳の例が入る', () => {
    const { fewShotSegments, fewShotTranslations } =
      translateEnTesting.resolveTranslationFewShot('', DEFAULT_LANGUAGE_PROFILE_CONFIG)
    expect(fewShotSegments.join('')).toMatch(/[぀-ヿ㐀-䶿一-鿿]/)
    expect(fewShotTranslations.join('')).toMatch(/[A-Za-z]/)
  })

  it('英語以外のラテン言語（ドイツ語）には英語の例を当てない', () => {
    // script=latin というだけで英語の例を注入すると出力言語を引きずる
    const { fewShotSegments } = translateEnTesting.resolveTranslationFewShot('', {
      subtitle: { label: 'Japanese', script: 'japanese' },
      transcript: { label: 'German', script: 'latin' },
    })
    expect(fewShotSegments).toEqual([])
  })

  it('補正 few-shot も英語書きおこしでのみ組み込み例を使う', () => {
    expect(correctTesting.resolveCorrectionFewShotMessages(settingsFor(EN_TO_JA_PROFILE))).toHaveLength(2)
    expect(correctTesting.resolveCorrectionFewShotMessages(settingsFor({
      subtitle: { label: 'Japanese', script: 'japanese' },
      transcript: { label: 'German', script: 'latin' },
    }))).toHaveLength(0)
  })
})
