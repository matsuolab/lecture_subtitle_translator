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
 * 表示系（行長・CPS・最小表示時間）は Netflix Japanese Timed Text Style Guide の
 * 一般字幕（horizontal, non-SDH）基準に合わせる。PoC ノートブック
 * （`poc/translate_demo.py` Step 7）が採用しているのと同じ数値である。
 *   https://partnerhelp.netflixstudios.com/hc/en-us/articles/215767517-Japanese-Timed-Text-Style-Guide
 *
 * - `enMaxCps` = 4.0 / `enMaxCharsPerLine` = 13 / `subtitleMinDurationSec` = 0.5
 *   いずれもガイドの規定値そのまま。
 *
 * - `pipelineSlowCps` = 0.7
 *   latin では上限 16.9 に対し 3.0（≈ 0.18 倍）を「間延び」の下限としている。
 *   同じ比率を日本語の上限 4.0 に適用した（4.0 × 0.18 ≈ 0.7）。
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
 *
 * ## 既知のトレードオフ（CPS 4.0 の採用について）
 *
 * この 4.0 は、過去に一度 8.0 へ引き上げられたものを差し戻した値である（commit 5ba94b7）。
 * 引き上げ時の根拠は、実際の技術講義（英語音声 → 日本語字幕）で自然な訳文が
 * 9.0〜9.4 CPS になり、4.0 では次のとおり収まらないケースが出たというもの:
 *   5.23秒の cue の予算 = 20文字。しかし「バックプロパゲーション」(11文字) と
 *   「ニューラルネットワーク」(11文字) だけで 22文字あり、専門用語を落とさない限り収まらない。
 *
 * それでもガイド準拠を優先する判断のため、**カタカナ専門用語が連続する講義では
 * CPS 違反として要確認に回る cue が増えることが想定される**。要確認が多すぎる場合は、
 * 設定画面の「字幕品質・修復」で CPS を引き上げて運用する（プリセットは出発点であり、
 * 適用後は利用者が自由に編集できる）。
 *
 * なお CPS の分母となる文字数は `countCpsChars`（空白を除いた素の文字数）で数えており、
 * ガイドが前提とする全角=1・半角=0.5 の重み付けは行っていない。半角英数を含む字幕では
 * ガイドより厳しめに判定される点に注意。
 */
const EN_TO_JA_PRESET: SubtitleQualityPreset = {
  enMaxCharsPerLine: 13,
  enMaxLines: 2,
  enMaxCps: 4.0,
  subtitleMinDurationSec: 0.5,
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
