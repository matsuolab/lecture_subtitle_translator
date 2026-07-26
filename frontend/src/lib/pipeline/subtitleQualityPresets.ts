import type { AdminSettings } from '@/types/adminSettings'
import type { LanguageProfileConfig } from './languageProfileConfig'

/**
 * 字幕品質基準のうち、字幕言語・言語ペアによって適正値が変わる項目。
 *
 * 表示系（行長・行数・CPS・最小表示時間）は **字幕言語** で決まる。
 * 比率系（verbose / over_compressed）は **言語ペア** で決まる。
 * 翻訳で文字数がどれだけ増減するかは方向によって逆転するため。
 */
export interface SubtitleQualityPreset {
  enMaxCharsPerLine: number
  enMaxLines: number
  enMaxCps: number
  subtitleMinDurationSec: number
  pipelineSlowCps: number
  pipelineVerboseEnRatio: number
  pipelineOverCompressedRatio: number
  pipelineOverCompressedJaChars: number
}

export type SubtitleQualityPresetId = 'ja_to_en' | 'en_to_ja'

export interface SubtitleQualityPresetInfo {
  id: SubtitleQualityPresetId
  /** UI 表示用の見出し（例: 「日本語 → English」） */
  label: string
  preset: SubtitleQualityPreset
}

/**
 * 日本語書きおこし → 英語字幕。現行の出荷既定値そのもの。
 * ここを変えると既存プロジェクトの品質判定が動くため、値は据え置く。
 */
const JA_TO_EN_PRESET: SubtitleQualityPreset = {
  enMaxCharsPerLine: 80,
  enMaxLines: 2,
  enMaxCps: 16.9,
  subtitleMinDurationSec: 0.833,
  pipelineSlowCps: 3.0,
  pipelineVerboseEnRatio: 1.5,
  pipelineOverCompressedRatio: 0.25,
  pipelineOverCompressedJaChars: 15,
}

/**
 * 英語書きおこし → 日本語字幕。
 *
 * **これらは実測値ではなく、公開ガイドラインの英日比から導出した出発点である。**
 * 実データでの検証・調整が必要（Wiki の「字幕ベストプラクティス」を正本とする）。
 * 導出の根拠:
 *
 * - `enMaxCps` = 4.0
 *   日本語字幕の読了速度の一般的な目安（全角約4文字/秒）。英語の 17cps に対して
 *   およそ 0.235 倍。本アプリの latin 既定 16.9 とも整合する比率。
 *
 * - `enMaxCharsPerLine` = 25
 *   英語 42文字/行 に対し日本語は全角13文字/行 が一般的な目安（比率 ≈ 0.31）。
 *   本アプリの latin 既定は 80（標準より広いレイアウトを想定した独自値）なので、
 *   その値に同じ比率を適用して 80 × 0.31 ≈ 25 とした。
 *
 * - `pipelineSlowCps` = 0.7
 *   latin では上限 16.9 に対し 3.0（≈ 0.18 倍）を「間延び」の下限としている。
 *   同じ比率を日本語の上限 4.0 に適用した。
 *
 * - 比率系（`pipelineVerboseEnRatio` / `pipelineOverCompressedRatio`）
 *   これらは `字幕文字数 / 書きおこし文字数` に対する閾値。日→英では概ね 1.0 前後が
 *   標準的だが、英→日では日本語の情報密度が高いため概ね 0.5 前後になる。
 *   latin 既定は「標準の 1.5 倍で冗長」「標準の 0.25 倍で過圧縮」という設計なので、
 *   標準値 0.5 に同じ倍率を適用した（1.5 × 0.5 = 0.75 / 0.25 × 0.5 = 0.125）。
 *
 * - `pipelineOverCompressedJaChars` = 25
 *   過圧縮判定を始める書きおこし側の最小文字数。書きおこしが英語になるため、
 *   日本語 15文字 相当の情報量にあたる英語の文字数（≈ 1.7 倍）へ読み替えた。
 */
const EN_TO_JA_PRESET: SubtitleQualityPreset = {
  enMaxCharsPerLine: 25,
  enMaxLines: 2,
  enMaxCps: 4.0,
  subtitleMinDurationSec: 0.833,
  pipelineSlowCps: 0.7,
  pipelineVerboseEnRatio: 0.75,
  pipelineOverCompressedRatio: 0.125,
  pipelineOverCompressedJaChars: 25,
}

const PRESETS: Record<SubtitleQualityPresetId, SubtitleQualityPresetInfo> = {
  ja_to_en: { id: 'ja_to_en', label: '日本語 → English', preset: JA_TO_EN_PRESET },
  en_to_ja: { id: 'en_to_ja', label: 'English → 日本語', preset: EN_TO_JA_PRESET },
}

/**
 * 現在の言語構成に対応する推奨プリセットを返す。
 * 推奨値を出せる組み合わせ（日→英 / 英→日）以外は null。
 * 中国語などの generic 構成に当てずっぽうの数値を当てないための意図的な制限。
 */
export function resolveSubtitleQualityPreset(
  languages: LanguageProfileConfig,
): SubtitleQualityPresetInfo | null {
  const { subtitle, transcript } = languages
  if (transcript.script === 'japanese' && subtitle.script === 'latin') return PRESETS.ja_to_en
  if (transcript.script === 'latin' && subtitle.script === 'japanese') return PRESETS.en_to_ja
  return null
}

/** プリセットが触る設定キー。差分表示や適用に使う。 */
export const SUBTITLE_QUALITY_PRESET_KEYS = [
  'enMaxCharsPerLine',
  'enMaxLines',
  'enMaxCps',
  'subtitleMinDurationSec',
  'pipelineSlowCps',
  'pipelineVerboseEnRatio',
  'pipelineOverCompressedRatio',
  'pipelineOverCompressedJaChars',
] as const satisfies ReadonlyArray<keyof SubtitleQualityPreset>

export interface SubtitleQualityPresetDiffEntry {
  key: keyof SubtitleQualityPreset
  current: number
  next: number
}

/**
 * 現在の設定とプリセットの差分を返す。空配列なら適用済み。
 * UI で「何が変わるか」を適用前に見せるために使う。
 */
export function diffSubtitleQualityPreset(
  settings: Pick<AdminSettings, keyof SubtitleQualityPreset>,
  preset: SubtitleQualityPreset,
): SubtitleQualityPresetDiffEntry[] {
  const diff: SubtitleQualityPresetDiffEntry[] = []
  for (const key of SUBTITLE_QUALITY_PRESET_KEYS) {
    const current = settings[key]
    const next = preset[key]
    if (current !== next) diff.push({ key, current, next })
  }
  return diff
}
