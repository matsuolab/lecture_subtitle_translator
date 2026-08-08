/**
 * OpenAI 本番プロバイダ用の API キーを取得する。
 *
 * `OPENAI_API_KEY` を直接渡すか、鍵だけを書いたファイルのパスを `OPENAI_API_KEY_FILE` で
 * 渡す。後者を用意しているのは、コマンドラインに鍵を書くとプロセス一覧やシェル履歴に
 * 残ってしまうため。
 *
 * `scripts/measureSeamOnlySplit.ts` と `scripts/runPipelineE2E.ts` の両方が同じ方式で
 * 鍵を読む必要があるため、ここに切り出して重複実装を避ける。
 */
import { readFileSync } from 'node:fs'

export function resolveApiKey(): string {
  const direct = process.env.OPENAI_API_KEY?.trim() ?? ''
  if (direct) return direct
  const keyFile = process.env.OPENAI_API_KEY_FILE?.trim() ?? ''
  if (!keyFile) return ''
  return readFileSync(keyFile, 'utf-8').trim()
}
