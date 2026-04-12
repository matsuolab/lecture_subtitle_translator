/**
 * 字幕制約と品質閾値。
 * Python PoC の constraints.py に対応。
 * YAML 不要 — AdminSettings で上書き可能な定数として管理する。
 */

// ---------------------------------------------------------------------------
// 字幕制約
// ---------------------------------------------------------------------------

export interface SubtitleConstraints {
  readonly maxChars: number    // 1ブロックの最大文字数
  readonly maxCps: number      // 最大 Characters Per Second
  readonly maxRetry: number    // CPS違反時の再プロンプト最大試行回数
}

// ---------------------------------------------------------------------------
// 品質閾値（Embedding コサイン距離）
// ---------------------------------------------------------------------------

export interface QualityThresholds {
  readonly correction: number   // 日本語補正の乖離フラグ閾値
  readonly translation: number  // 英訳の乖離フラグ閾値
}

// ---------------------------------------------------------------------------
// デフォルト値（PoC constraints.py の _DEFAULTS と同値）
// ---------------------------------------------------------------------------

const SUBTITLE_DEFAULTS: Record<string, SubtitleConstraints> = {
  _default: { maxChars: 40, maxCps: 15.0, maxRetry: 3 },
  en:       { maxChars: 42, maxCps: 17.0, maxRetry: 3 },
  ja:       { maxChars: 20, maxCps: 8.0,  maxRetry: 3 },
  zh:       { maxChars: 16, maxCps: 7.0,  maxRetry: 3 },
  ko:       { maxChars: 20, maxCps: 8.0,  maxRetry: 3 },
}

export const DEFAULT_QUALITY_THRESHOLDS: QualityThresholds = {
  correction: 0.15,
  translation: 0.25,
}

export function getSubtitleConstraints(lang: string): SubtitleConstraints {
  return SUBTITLE_DEFAULTS[lang] ?? SUBTITLE_DEFAULTS['_default']
}
