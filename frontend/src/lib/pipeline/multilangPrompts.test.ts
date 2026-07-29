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
import { __testing as coverageRepairTesting } from './coverageRepairAgent'
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
  it('既定構成では従来文字列とバイト一致する', () => {
    expect(splitBlockTesting.buildSplitSystemPrompt('Japanese')).toBe(
      'Resegment this Japanese academic lecture subtitle into 1 to 3 subtitle units. ' +
      'Use 1 unit if splitting would be unnatural. Use 2 or 3 units only at clear semantic boundaries. ' +
      'Each unit must make sense independently and must not end with a particle, conjunction, or unfinished clause. ' +
      'Preserve technical terms, numbers, formulas, definitions, negations, conditions, and causal relations. ' +
      'You may remove filler, repeated setup phrases, and redundant lecture asides if no information is lost. ' +
      'If the text cannot be split safely, return {"cannot_split": true, "units": [], "warnings": ["reason"]}. ' +
      'Respond only with JSON: {"units":[{"text":"...","reason":"...","confidence":0.0}],"warnings":[]}',
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

  it('言語ラベルが注入される', () => {
    expect(splitBlockTesting.buildSplitSystemPrompt('German')).toContain('Resegment this German academic lecture subtitle')
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

The pipeline has already tried rule-based corrections and a coverage-focused repair agent.
What remains are the hardest cases. You get one more chance per effort level (low → medium → high).
If you cannot fix it, the block goes to manual_review.

You will be given:
- chunk_blocks: all blocks for the current chunk, in time order, with current violations and correction history.
- residual_violations: per-block violations (cps_over, line_length_only, long_segment, etc.) + chunk-level coverage gaps.
- constraints: hard limits (max_cps, max_chars_per_line, max_segment_chars, min_duration, etc.). MUST respect.
- source_segments: original Japanese corrected text (post-correctJa) for coverage reference.

Your job: rewrite the affected cues to resolve as many violations as possible.

Rules:
- Return JSON only: { "rationale": "...", "rewrites": [{ "block_id": N, "ja_span": "...", "en": "..." }] }
- Only return rewrites for the cues you want to change. Other cues stay as-is.
- You may modify both ja_span (to expand/shift source coverage) and en (to fix CPS/line/length).
- Preserve the cue's start/end timing (you do NOT modify timing).
- Compute allowed en chars as floor(duration_sec × max_cps). Stay within this budget.
- Respect max_chars_per_line per line and max_segment_chars total.
- Do not add content not in the source Japanese.
- Preserve technical terms / formulas exactly (post-correctJa form).
- Do not invent proper nouns (person names, organization names) that are not in source.
- Use correction_attempts history to AVOID repeating strategies that already failed.
- If you cannot repair a cue without violating constraints, leave it out of rewrites and explain in rationale.
- For coverage gaps: prefer rephrasing existing en to absorb missing content, rather than fabricating.`

const LEGACY_COVERAGE_REPAIR_PROMPT = `You are CoverageRepairAgent for academic lecture subtitles.

A chunk of subtitles has a source-coverage problem: the union of all cue Japanese spans
does not fully represent the source Japanese segment. Some content from the source
Japanese is missing from the cues' ja_span and / or en text.

Your job: rewrite the affected cues so that the source Japanese is fully represented.

You will be given:
- source_segment: the full corrected Japanese with original (pre-correctJa) and correction_distance.
  If correction_distance is large, technical terms or formulas were rewritten by correctJa — preserve them carefully.
- constraints: hard limits (max_cps, max_chars_per_line, max_segment_chars). Your output MUST respect these.
- affected_cues_to_repair: each cue includes current state AND correction_attempts history (strategies already tried).
  Use the history to avoid repeating failed strategies.
- context_cues_before / after: neighbor cues for coherent flow.

Rules:
- Return JSON only: { "rationale": "...", "rewrites": [{ "block_id": N, "ja_span": "...", "en": "..." }] }
- Only return rewrites for the cues you want to change. Other cues stay as-is.
- Preserve the cue's start/end timing (you do NOT modify timing).
- Extend or shift each ja_span to claim more of the source Japanese where appropriate.
- Rewrite the en text so it expresses the new content compactly.
- Compute allowed en chars as floor(duration_sec * max_cps). Stay within this budget.
- Do not exceed max_chars_per_line per line, max_segment_chars total.
- Do not add content not present in the source Japanese.
- Preserve technical terms / formulas exactly as written in the source (especially the post-correctJa form).
- Do not invent proper nouns (person names, organization names) that are not in source.
- If correction_attempts shows compress_micro / compress_rephrase already failed, do not just shorten — restructure.
- If you cannot repair without violating constraints, return empty rewrites array with a rationale explaining why.`

describe('repair agent システムプロンプト', () => {
  it('既定構成では従来の日本語前提プロンプトとバイト一致する', () => {
    expect(generalRepairTesting.buildSystemPrompt('Japanese')).toBe(LEGACY_GENERAL_REPAIR_PROMPT)
    expect(coverageRepairTesting.buildSystemPrompt('Japanese')).toBe(LEGACY_COVERAGE_REPAIR_PROMPT)
  })

  it('transcript ラベルが注入され Japanese が残らない', () => {
    const general = generalRepairTesting.buildSystemPrompt('German')
    expect(general).toContain('original German corrected text')
    expect(general).toContain('Do not add content not in the source German.')
    expect(general).not.toContain('Japanese')

    const coverage = coverageRepairTesting.buildSystemPrompt('German')
    expect(coverage).toContain('the union of all cue German spans')
    expect(coverage).toContain('the source German is fully represented')
    expect(coverage).not.toContain('Japanese')
  })
})

const thresholds: PipelineThresholds & AgentThresholds = {
  shortDurationSec: 1.5,
  longDurationSec: 10,
  mergedLongDurationSec: 7,
  overCompressedRatio: 0.25,
  overCompressedJaChars: 15,
  verboseEnRatio: 1.5,
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
    violation: 'verbose_en',
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
