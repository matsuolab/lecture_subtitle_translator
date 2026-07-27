import type { PipelineLlmErrorRecord } from '@/types/pipeline'

/**
 * LLM 呼出（chatText / chatVision / embeddings）の失敗を記録する module-level の
 * 有界バッファ。パイプライン実行の debug エクスポート（PipelineRunDebug.llmErrors）へ
 * 集約され、http_400 等「字幕側には短コード化されて出ない」失敗の生の原因を後から追える
 * ようにするための診断専用の器。
 *
 * 本番事故の教訓: 「プロバイダの生応答本文を字幕へ埋め込まない」という情報漏洩対策
 * （errors.ts の buildLlmFailureCode 参照）を入れた際、デバッグ用の詳細情報まで一緒に
 * 消してしまい、546ブロック中476件が翻訳失敗した実行で httpStatus=400 の中身がエクスポートの
 * どこにも残らなかった。字幕への短コード化は正しい判断のまま維持しつつ、この器だけは
 * デバッグ専用領域として生の応答本文を保持する。
 *
 * **重要な安全境界**: このモジュールの `detail` はデバッグ export 専用（PipelineRunDebug.llmErrors
 * 経由でのみ表に出る）であり、字幕テキスト・`[UNTRANSLATED: ...]` マーカー・
 * translationFailureReason には絶対に混ぜてはならない。呼出元（translateEn.ts / correct.ts 等）が
 * 字幕向けの文字列を組み立てる際は、これまでどおり buildLlmFailureCode() の短い分類コードのみを
 * 使うこと（この点は本モジュール追加によって一切変わらない）。
 *
 * 設計理由（llmActivity.ts / llmUsageSink.ts / llmConcurrency.ts と同じ判断）:
 *   - 各呼出ヘルパーに sink を引数で引き回すとシグネチャ変更が広範囲に及ぶため、
 *     module-level の器で完結させる。
 *   - このアプリは local desktop で 1 パイプライン同時実行のみなので、module-level で十分安全。
 *
 * 有界化の方針:
 *   - 1件あたりの detail は MAX_DETAIL_LENGTH 文字で切り詰める（プロバイダの応答本文が
 *     巨大な HTML エラーページ等の場合にメモリ・エクスポートサイズが際限なく膨らむのを防ぐ）。
 *   - 全体件数は MAX_RECORDS 件を上限とする有界バッファ（配列）。上限到達後は**古いものを
 *     捨てる**（FIFO）方針を採る。理由: この器は「進行中の実行を後から診断する」ための
 *     ものであり、診断上価値が高いのは直近の失敗（現在何が起きているか）である。
 *     大量失敗の実行（本番事故: 546件中476件失敗）では、先頭の失敗より末尾の失敗の方が
 *     「今まさに困っている状態」を反映しており、末尾を優先して残す方が診断に資する
 *     （llmActivity.ts が lastCompletedAt を「直近」基準で持つのと同じ考え方）。
 *
 * 運用ルール:
 *   - パイプライン orchestrator は実行開始時に resetLlmErrorLog() を呼ぶ
 *     （src/api/pipelineClient.ts の runPipelineViaApi 参照。前回実行の記録を持ち越さない）
 *   - 各 gateway 呼出ヘルパー（chatText.ts / chatVision.ts / embeddings.ts）は errorMessage を
 *     返す（または embeddings のように null を返す）全経路で pushLlmError() を呼ぶ
 *   - 実行終了時に getLlmErrorLog() で回収し、PipelineRunDebug.llmErrors に格納する
 */

const MAX_RECORDS = 100
const MAX_DETAIL_LENGTH = 1000

let records: PipelineLlmErrorRecord[] = []

export function pushLlmError(record: Omit<PipelineLlmErrorRecord, 'at' | 'detail'> & { at?: number; detail: string }): void {
  const entry: PipelineLlmErrorRecord = {
    ...record,
    detail: record.detail.slice(0, MAX_DETAIL_LENGTH),
    at: record.at ?? Date.now(),
  }
  records.push(entry)
  // 上限到達後は古いもの（先頭）を捨てる。理由は本ファイル冒頭の JSDoc 参照。
  if (records.length > MAX_RECORDS) {
    records.shift()
  }
}

export function getLlmErrorLog(): PipelineLlmErrorRecord[] {
  return records.slice()
}

/**
 * テスト・パイプライン開始時のリセット用。前回実行の記録が残らないようにする。
 */
export function resetLlmErrorLog(): void {
  records = []
}
