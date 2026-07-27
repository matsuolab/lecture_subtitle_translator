import { BUILTIN_API_COMPATIBILITY_PROFILES, type ApiCompatibilityProfile } from './apiCompatibilityProfile'

/**
 * OpenAI の GPT-5 系・推論系モデル（gpt-5 / o3 / o4 で始まるモデルID）は、temperature / top_p 等の
 * サンプリング系パラメータの非既定値を HTTP 400 (unsupported_value) で拒否することが公式に
 * 確認されている。
 *
 * 参照:
 *   - https://developers.openai.com/api/docs/guides/error-codes
 *   - https://developers.openai.com/api/docs/guides/rate-limits
 *   - コミュニティ報告（GPT-5 系で temperature 非対応が広く報告されている）
 * エラー形式の実例:
 *   {"error":{"message":"Unsupported value: 'temperature' does not support 0 with this model. Only the default (1) value is supported.","type":"invalid_request_error","param":"temperature","code":"unsupported_value"}}
 *
 * この事前抑制は「公式に確認済みの既知の仕様」のみを対象にする。未知のモデル・他プロバイダに
 * ついては一切決め打ちせず、paramCompat.ts の適応学習（実際に 400 を受けて初めて学習する）に
 * 委ねる。事前抑制と適応学習は排他ではなく補完関係にある:
 *   - 事前抑制（本モジュール）: 公式仕様として確認済みのモデル群 → 最初から送らない（400 を待たない）
 *   - 適応学習（paramCompat.ts）: 事前リストに無い将来のモデル・他プロバイダへの保険 →
 *     実際に 400 を受けてから学習する
 *
 * LM Studio / Ollama / Gemini OpenAI Compatible プロファイルには絶対に適用しない。
 * ローカルモデル（gemma / qwen 等、modelProfile.ts の MODEL_PROFILE_PRESETS 参照）は
 * temperature 0 を正しく受け付けており、決定性のある出力（temperature=0 前提の翻訳・校正
 * パイプライン）を維持するために必須のパラメータである。誤って適用すると出力の決定性が
 * 失われる。判定は `builtin:api:openai` プロファイル（resolveApiCompatibilityProfile が
 * 自動推論またはユーザーが明示選択したもの）に限定し、他のプロファイルには一切影響しない。
 */
const OPENAI_REASONING_MODEL_PREFIXES = ['gpt-5', 'o3', 'o4'] as const

/**
 * 事前抑制の判定をこの1箇所に集約する。呼出元（chatText.ts / chatVision.ts）は
 * 判定結果に従って body から temperature / top_p を削除するだけでよい。
 */
export function shouldSuppressOpenAiSamplingParams(
  profile: Pick<ApiCompatibilityProfile, 'id'>,
  model: string,
): boolean {
  if (profile.id !== BUILTIN_API_COMPATIBILITY_PROFILES.openai.id) return false
  const normalized = model.trim().toLowerCase()
  if (!normalized) return false
  return OPENAI_REASONING_MODEL_PREFIXES.some((prefix) => normalized.startsWith(prefix))
}

/**
 * body からサンプリング系パラメータ（temperature / top_p）を取り除いた新しいオブジェクトを返す。
 * 呼出元の coding-style（immutability）に合わせ、元オブジェクトは変更しない。
 * 該当パラメータが無ければ元の参照をそのまま返す（無駄なコピーを避ける。paramCompat.ts の
 * stripLearnedUnsupportedParams と同じ方針）。
 */
export function stripOpenAiSamplingParams<T extends Record<string, unknown>>(body: T): T {
  if (!('temperature' in body) && !('top_p' in body)) return body
  const next = { ...body }
  delete next.temperature
  delete next.top_p
  return next
}
