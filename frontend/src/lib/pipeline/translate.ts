import type { LanguageProfileConfig } from './languageProfileConfig'

// transcript（元言語）が日本語スクリプトのときだけ、カタカナ復元ルールと日本語の few-shot を含める。
// 既定構成（Japanese→English）では従来のハードコード文字列とバイト一致する。
function buildTranslateSystemPrompt(languages: LanguageProfileConfig): string {
  const subtitleLabel = languages.subtitle.label
  const transcriptLabel = languages.transcript.label
  const transcriptIsJapanese = languages.transcript.script === 'japanese'
  return (
    `You are a subtitle translator for academic lectures. Translate each ${transcriptLabel} segment into natural ${subtitleLabel}.\n` +
    '\n' +
    'Input format:  {"segments": ["seg0", "seg1", ...]}\n' +
    'Output format: {"translations": ["trans0", "trans1", ...]}\n' +
    '\n' +
    'MAPPING (CRITICAL):\n' +
    `- translations[i] is the ${subtitleLabel} translation of segments[i]\n` +
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
    '- Never translate framework, algorithm, or product names' +
    (transcriptIsJapanese
      ? '\n- Katakana-rendered terms: restore to original form (ハイド → HyDE, リアクト → ReAct)'
      : '')
  )
}

function buildTranslateFewShot(languages: LanguageProfileConfig): Array<{ role: 'user' | 'assistant'; content: string }> {
  // 組み込み few-shot は日本語→英語の例なので、transcript が日本語スクリプト以外の構成では使わない。
  if (languages.transcript.script !== 'japanese') return []
  return [
    {
      role: 'user',
      content: JSON.stringify({ segments: ['機械学習とは何ですか。', 'ディープラーニングについて説明します。', 'では次のトピックに移ります。'] }),
    },
    {
      role: 'assistant',
      content: JSON.stringify({ translations: ['What is machine learning?', 'I will explain deep learning.', "Now let's move on to the next topic."] }),
    },
  ]
}

export const __testing = {
  buildTranslateSystemPrompt,
  buildTranslateFewShot,
}
