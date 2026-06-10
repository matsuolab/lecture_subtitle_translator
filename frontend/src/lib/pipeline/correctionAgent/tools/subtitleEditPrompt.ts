import type { LanguageProfileConfig } from '../../languageProfileConfig'

/**
 * compress 系ツール（core / micro / trim / rephrase）が共有する user メッセージの組み立て。
 * 言語名は設定の言語プロファイル（transcript=元言語 / subtitle=出力字幕）から注入する。
 * 既定構成（Japanese→English）では従来のハードコード文字列とバイト一致する。
 *
 * @param tail 末尾に連結する追記（budgetHint や removedHint）。呼出側が区切り（\n\n など）込みで渡す。
 */
export function buildSubtitleEditUserContent(
  languages: LanguageProfileConfig,
  sourceText: string,
  currentSubtitle: string,
  tail = '',
): string {
  return (
    `${languages.transcript.label} source:\n${sourceText}\n\n` +
    `Current ${languages.subtitle.label} subtitle:\n${currentSubtitle}` +
    tail
  )
}
