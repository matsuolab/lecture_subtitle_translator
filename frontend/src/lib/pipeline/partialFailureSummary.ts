/**
 * バッチ処理ノードが「一部のアイテムだけ失敗し、全体としてはノード自体は正常終了した」場合に、
 * trace へ残す警告メッセージを組み立てる。
 *
 * 背景（本番事故）: correctJa が 333 件中 332 件失敗しながら、trace には
 * `correctJa success 187s` としか出ず、332 件失敗の事実がどこにも記録されなかった。
 * 実行が「成功した」ように見えるのに中身がほぼ空という最悪の誤報で、ユーザーは実際の出力を
 * 見るまで気づけなかった。
 *
 * contextGroupCueBlocks が既に持つ「detection partial failure: N of M ...」という警告の
 * 仕組み（contextGrouping.ts 参照）に倣い、新しい概念を増やさず onWarning 経由で
 * success trace の隣に警告 summary を残す。
 */
export function buildPartialFailureWarning(
  itemLabel: string,
  failedCount: number,
  totalCount: number,
): string | undefined {
  if (failedCount <= 0 || totalCount <= 0) return undefined
  const rate = failedCount / totalCount
  // 失敗率が高い場合（既定: 半数以上）は CRITICAL として目立たせる。
  const severity = rate >= 0.5 ? 'CRITICAL' : 'partial'
  const ratePercent = Math.round(rate * 100)
  return `${severity} failure: ${failedCount} of ${totalCount} ${itemLabel} items failed and fell back to source text (rate=${ratePercent}%)`
}
