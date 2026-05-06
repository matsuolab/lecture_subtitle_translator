export const FULL_SYSTEM_PROMPT_V08 =
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
  '- brief informal asides from the lecturer ("This might seem complicated") may be kept to preserve lecture tone'

export const FT_SYSTEM_PROMPT_SHORT =
  'Translate Japanese lecture subtitles into concise English. Keep one output per input. ' +
  'Do not merge or split blocks. Use natural casual-academic wording. Preserve technical terms.'

export function pickTranslateSystemPrompt(model: string | undefined): string {
  return model?.startsWith('ft:') ? FT_SYSTEM_PROMPT_SHORT : FULL_SYSTEM_PROMPT_V08
}

export function resolveTranslateModelId(model: string | undefined): string {
  const resolved = model?.trim()
  return resolved || 'gpt-4.1-mini'
}

function buildCompressSystemPrompt(maxCharsPerLine: number, maxLines: number): string {
  return (
    'You are a subtitle editor. This subtitle is too long and must be shortened. ' +
    `It must fit on ${maxLines} lines of ${maxCharsPerLine} characters each when displayed. ` +
    'Shorten the English text while preserving the key meaning. Make it as concise as possible. ' +
    'Do not include line breaks in your response. ' +
    'Respond with JSON: {"text": "<shortened subtitle>"}'
  )
}

function buildExpandSystemPrompt(maxCharsPerLine: number, maxLines: number, maxCps: number): string {
  return (
    'You are a subtitle translator. This subtitle is over-compressed and too brief compared to the Japanese source. ' +
    `It will be displayed on ${maxLines} lines of ${maxCharsPerLine} characters each at ${maxCps} CPS. ` +
    'Expand it to be more complete and natural while staying concise. ' +
    'Do not include line breaks in your response. ' +
    'Respond with JSON: {"text": "<expanded subtitle>"}'
  )
}

export function resolveCompressSystemPrompt(
  settings: { enMaxCharsPerLine: number; enMaxLines: number },
  override?: string,
): string {
  return override?.trim() || buildCompressSystemPrompt(settings.enMaxCharsPerLine, settings.enMaxLines)
}

export function resolveExpandSystemPrompt(
  settings: { enMaxCharsPerLine: number; enMaxLines: number; enMaxCps: number },
  override?: string,
): string {
  return override?.trim() || buildExpandSystemPrompt(settings.enMaxCharsPerLine, settings.enMaxLines, settings.enMaxCps)
}

export function resolveCompressModelId(settings: { compressModel?: string; translationModel?: string }): string {
  return settings.compressModel?.trim() || settings.translationModel?.trim() || 'gpt-4.1-mini'
}

export function resolveExpandModelId(settings: { expandModel?: string; translationModel?: string }): string {
  return settings.expandModel?.trim() || settings.translationModel?.trim() || 'gpt-4.1-mini'
}
