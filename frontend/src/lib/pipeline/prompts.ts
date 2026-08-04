import type { AdminSettings } from '@/types/adminSettings'
import {
  DEFAULT_LANGUAGE_PROFILE_CONFIG,
  loadLanguageProfileConfig,
  type LanguageProfileConfig,
} from './languageProfileConfig'

// 翻訳系プロンプトは設定の言語プロファイル（subtitle/transcript ラベル）から組み立てる。
// 既定構成（Japanese→English, transcript.script='japanese'）では従来のハードコード文字列と
// 完全一致すること（prompts.test.ts で固定）。日本語固有の指示行（カタカナ復元・「私／先生」例示）は
// transcript.script === 'japanese' のときだけ含める。
export function buildFullTranslateSystemPrompt(languages: LanguageProfileConfig): string {
  const subtitleLabel = languages.subtitle.label
  const transcriptLabel = languages.transcript.label
  const transcriptIsJapanese = languages.transcript.script === 'japanese'
  const lecturerLine = transcriptIsJapanese
    ? `- when the ${transcriptLabel} says "I" / "私" / "先生" or refers to a role without naming, render it as "I" / "the lecturer" / etc., NOT a made-up name\n`
    : `- when the ${transcriptLabel} refers to the speaker or a role without naming, render it as "I" / "the lecturer" / etc., NOT a made-up name\n`
  return (
    `You are a subtitle translator for academic lectures. Translate each ${transcriptLabel} block into natural ${subtitleLabel}.\n` +
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
    (transcriptIsJapanese ? '- restore katakana technical terms to original spelling when obvious\n' : '') +
    '\n' +
    'CONCISENESS:\n' +
    '- omit filler phrases that carry no information: "it seems that", "apparently", "in this manner", "By the way"\n' +
    '- convert 5W1H noun clauses to simple nouns: "how many layers to have" → "the number of layers"\n' +
    '- replace idioms and metaphors with direct wording; non-native readers need immediate clarity\n' +
    `- slides are not visible to viewers: replace vague references with concrete terms when the ${transcriptLabel} names them\n` +
    '- brief informal asides from the lecturer ("This might seem complicated") may be kept to preserve lecture tone\n' +
    '\n' +
    'FAITHFULNESS (anti-hallucination):\n' +
    '- never invent proper nouns (person names, organization names, place names) that are not in the source\n' +
    `- only use a specific person name if it is explicitly written in the source ${transcriptLabel}\n` +
    lecturerLine +
    '- do not add facts, numbers, dates, or technical details that are not in the source\n' +
    '- do not infer beyond what the source states; preserve the lecturer\'s level of specificity'
  )
}

export function buildFtTranslateSystemPrompt(languages: LanguageProfileConfig): string {
  return (
    `Translate ${languages.transcript.label} lecture subtitles into concise ${languages.subtitle.label}. Keep one output per input. ` +
    'Do not merge or split blocks. Use natural casual-academic wording. Preserve technical terms. ' +
    `Never invent proper nouns or facts not in the source ${languages.transcript.label}.`
  )
}

export const FULL_SYSTEM_PROMPT_V08 = buildFullTranslateSystemPrompt(DEFAULT_LANGUAGE_PROFILE_CONFIG)

export const FT_SYSTEM_PROMPT_SHORT = buildFtTranslateSystemPrompt(DEFAULT_LANGUAGE_PROFILE_CONFIG)

export const DEFAULT_CORRECTION_ADDITIONAL_INSTRUCTIONS =
  '追加方針:\n' +
  '- 数式・添字・変数・関数名は、文脈から明確な場合はLaTeX記法で整える（例: X1 -> $x_1$, FI -> $f_i$, XJ -> $x_j$）\n' +
  '- 技術用語・略語は標準表記に寄せる（例: Long Short-Term Memory (LSTM), BiLSTM, Jacobian matrix, Hadamard product）\n' +
  '- 日本語として意味が通る範囲で補正し、根拠のない情報追加はしない\n'

export const DEFAULT_CORRECTION_FEW_SHOT_JSON = JSON.stringify({
  segments: [
    { id: 1, text: 'ヤコビ行列とはN次元の変数X1からXNからM次元の変数Z1からZMへの変換がF1からFMとして表されるときの行列です。' },
    { id: 2, text: 'こうした課題を解決するために提案されたのがLSTMロングショートタームメモリと呼ばれるモデルです。' },
  ],
  corrections: [
    { id: 1, text: 'ヤコビ行列とは、N次元の変数$x_1$から$x_n$からM次元の変数$z_1$から$z_m$への変換が$f_1$から$f_m$として表されるときの行列です。' },
    { id: 2, text: 'こうした課題を解決するために提案されたのがLong Short-Term Memory (LSTM)と呼ばれるモデルです。' },
  ],
}, null, 2)

export const DEFAULT_TRANSLATION_ADDITIONAL_INSTRUCTIONS =
  'ADDITIONAL PROJECT STYLE:\n' +
  '- Default to subtitles that read well on their own; include the subject, verb, and referent when needed.\n' +
  '- If the source uses vague references such as これ, このように, こちら, 先ほど, or 同様に, use nearby context to restore the concrete referent when supported.\n' +
  '- Preserve list/contrast structure across neighboring blocks; do not translate a continuation as an isolated fragment when the axis is clear.\n' +
  '- Render formulas and notation in readable LaTeX-style text when the notation is explicit or strongly supported by context.\n'

export const DEFAULT_TRANSLATION_FEW_SHOT_JSON = JSON.stringify({
  segments: [
    'を作成するときの引数としてこのように渡しています。',
    '文章を生成するようなタスクが行われています。',
    'こうした課題を解決するために提案されたのがLSTM（Long Short Term Memory）と呼ばれるモデルです。',
    '今度は同じデータを後ろから順番に見ていく流れを用意し、流れを2つにして双方向にした双方向RNNとして、例えばBiLSTMというものが使われています。',
  ],
  translations: [
    'I pass the function I made here as an argument.',
    'speech recognition for audio, and video-to-text generation for video.',
    'The Long Short-Term Memory (LSTM) model was proposed to overcome these challenges.',
    'To address this, bidirectional RNNs, such as BiLSTMs, process data in both forward and backward directions.',
  ],
}, null, 2)

function appendAdditionalInstructions(base: string, additional?: string): string {
  const trimmed = additional?.trim()
  return trimmed ? `${base}\n\n${trimmed}` : base
}

export function pickTranslateSystemPrompt(
  model: string | undefined,
  additionalInstructions?: string,
  languages: LanguageProfileConfig = DEFAULT_LANGUAGE_PROFILE_CONFIG,
): string {
  const base = model?.startsWith('ft:')
    ? buildFtTranslateSystemPrompt(languages)
    : buildFullTranslateSystemPrompt(languages)
  return appendAdditionalInstructions(base, additionalInstructions)
}

export function resolveTranslateModelId(model: string | undefined): string {
  const resolved = model?.trim()
  return resolved || ''
}

function buildCompressSystemPrompt(maxCharsPerLine: number, maxLines: number, subtitleLabel: string): string {
  return (
    'You are a subtitle editor. This subtitle is too long and must be shortened. ' +
    `It must fit on ${maxLines} lines of ${maxCharsPerLine} characters each when displayed. ` +
    `Shorten the ${subtitleLabel} text while preserving the key meaning. Make it as concise as possible. ` +
    'Do not include line breaks in your response. ' +
    'Respond with JSON: {"text": "<shortened subtitle>"}'
  )
}

function buildExpandSystemPrompt(maxCharsPerLine: number, maxLines: number, maxCps: number, transcriptLabel: string): string {
  return (
    `You are a subtitle translator. This subtitle is over-compressed and too brief compared to the ${transcriptLabel} source. ` +
    `It will be displayed on ${maxLines} lines of ${maxCharsPerLine} characters each at ${maxCps} CPS. ` +
    'Expand it to be more complete and natural while staying concise. ' +
    'Do not include line breaks in your response. ' +
    'Respond with JSON: {"text": "<expanded subtitle>"}'
  )
}

export function resolveCompressSystemPrompt(settings: AdminSettings, override?: string): string {
  return (
    override?.trim()
    || buildCompressSystemPrompt(
      settings.enMaxCharsPerLine,
      settings.enMaxLines,
      loadLanguageProfileConfig(settings).subtitle.label,
    )
  )
}

export function resolveExpandSystemPrompt(settings: AdminSettings, override?: string): string {
  return (
    override?.trim()
    || buildExpandSystemPrompt(
      settings.enMaxCharsPerLine,
      settings.enMaxLines,
      settings.enMaxCps,
      loadLanguageProfileConfig(settings).transcript.label,
    )
  )
}

export function resolveCompressModelId(settings: { compressModel?: string; translationModel?: string }): string {
  return settings.compressModel?.trim() || settings.translationModel?.trim() || ''
}


// compress_micro 用モデル解決。
// microModel が空なら compressModel、それも空なら translationModel をフォールバック。
export function resolveMicroModelId(
  settings: { microModel?: string; compressModel?: string; translationModel?: string },
): string {
  return (
    settings.microModel?.trim() ||
    settings.compressModel?.trim() ||
    settings.translationModel?.trim() ||
    ''
  )
}

// splitJa（semantic 分割）用モデル解決。
// splitJaModel が空なら microModel、compressModel、translationModel の順でフォールバック。
// 既定は gpt-5.6-luna。用途としては軽量・意味境界判定のみで翻訳生成は不要なため、より小型のモデルでも足りる。
export function resolveSplitJaModelId(
  settings: { splitJaModel?: string; microModel?: string; compressModel?: string; translationModel?: string },
): string {
  return (
    settings.splitJaModel?.trim() ||
    settings.microModel?.trim() ||
    settings.compressModel?.trim() ||
    settings.translationModel?.trim() ||
    ''
  )
}
