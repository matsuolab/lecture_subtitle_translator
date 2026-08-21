/**
 * finish_reason='length'（errorCode='truncated'）時の errorMessage を組み立てる。
 *
 * 背景: 旧メッセージは `truncated_at_length_limit (content_preview=)` のみで、原因究明に
 * 全く役立たなかった。上限がいくつだったのか・何に消費されたのか（本文か推論か）が分からず、
 * 実際の原因特定のために専用の診断スクリプト（scripts/probeModelReasoning.ts）を書いて
 * 個別に実測する必要があった。このメッセージだけで完結するよう、以下を含める:
 *   - 実際に送った上限（パラメータ名と値。送っていなければその旨）
 *   - 消費の内訳（completionTokens、うち推論が何トークンか）
 *   - 本文の文字数
 *   - 上限を送っていた場合は、利用者が確認すべき設定のヒント
 *     （実装3で追加した推論トークン予算設定。local_openai 経路のみ有効）
 *
 * chatText.ts / chatVision.ts の両方の truncated 分岐から使う共通ロジックとして切り出す。
 *
 * 重要: この文字列は表示・ログ用の自由文字列であり、呼出元の分岐判定に使ってはならない。
 * 分岐は必ず errorCode==='truncated' を使うこと（detectIncompleteEnds.ts 冒頭 JSDoc に、
 * 過去に errorMessage の完全一致判定が原因で半割リトライが一度も発火しなかった事故が
 * 記録されている）。先頭を 'truncated_at_length_limit:' で固定しているのは既存ログ・
 * テストとの表示上の連続性のためであり、分岐判定用ではない。
 */

/** 組み込みプリセットが使うトークン上限フィールド名。 */
const BUILTIN_TOKEN_LIMIT_PARAM_NAMES = ['max_tokens', 'max_completion_tokens'] as const

interface SentTokenLimit {
  param: string
  value: unknown
}

/**
 * 最終的に送信したリクエスト body から、実際に設定されているトークン上限フィールドを探す。
 * openai/gemini 経路では stripTokenLimitFields が取り除くため見つからない
 * （＝「送っていない」と正しく報告される）。local_openai 経路では残る。
 *
 * 組み込みの2つに決め打ちしてはならない。ユーザー定義プロファイルは任意の名前
 * （例: num_predict）を指定できるため、決め打ちだと上限を送っているのに
 * 「送っていない」と報告してしまい、このメッセージの目的そのものが壊れる。
 * 呼出元が解決済みの activeTokenLimitParam を渡すこと。
 */
function describeSentTokenLimit(
  body: Record<string, unknown>,
  activeTokenLimitParam?: string,
): SentTokenLimit | undefined {
  const candidates = activeTokenLimitParam
    ? [activeTokenLimitParam, ...BUILTIN_TOKEN_LIMIT_PARAM_NAMES]
    : [...BUILTIN_TOKEN_LIMIT_PARAM_NAMES]
  for (const param of candidates) {
    if (body[param] !== undefined) return { param, value: body[param] }
  }
  return undefined
}

export interface TruncatedMessageInput {
  /** 実際に送信したリクエスト body（トークン上限フィールドが残っていれば拾う）。 */
  body: Record<string, unknown>
  /** 取得できた場合のみ渡す。取得できていない情報を捏造しないため、呼出元は無い情報を渡さないこと。 */
  completionTokens?: number
  reasoningTokens?: number
  /** 受信できた本文（切り詰め後）の文字数。 */
  contentLength: number
  /**
   * 有効な方言が使うトークン上限パラメータ名（apiCompatibilityProfile の
   * requestDialect.chat.tokenLimitParam）。ユーザー定義プロファイルは任意の名前を
   * 指定できるため、呼出元が解決済みの値を渡すこと。
   */
  activeTokenLimitParam?: string
}

export function formatTruncatedMessage(input: TruncatedMessageInput): string {
  const sentLimit = describeSentTokenLimit(input.body, input.activeTokenLimitParam)
  const limitPart = sentLimit ? `上限${String(sentLimit.value)}（${sentLimit.param}）` : '上限は送っていない'
  const completionPart = typeof input.completionTokens === 'number'
    ? `消費 completion=${input.completionTokens}${typeof input.reasoningTokens === 'number' ? `（うち推論${input.reasoningTokens}）` : ''}`
    : '消費内訳は取得できず'
  const contentPart = `本文${input.contentLength}文字`
  // 上限を送っていた場合だけ、利用者が確認すべき設定名のヒントを付ける。
  // openai/gemini は上限自体を送らないためこのヒントは無関係（sentLimit が undefined になる）。
  const hint = sentLimit
    ? ' / 設定「推論トークン予算（0=自動）」(llmReasoningBudgetTokens) の引き上げで改善する場合があります（ローカルLLM経路のみ有効）'
    : ''
  return `truncated_at_length_limit: ${limitPart} / ${completionPart} / ${contentPart}${hint}`
}
