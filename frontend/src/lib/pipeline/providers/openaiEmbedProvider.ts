/**
 * OpenAI Embeddings プロバイダー。
 * correctJa / translateEn の意味乖離チェック（コサイン距離）に使う。
 */

import OpenAI from 'openai'

export interface EmbedProvider {
  /**
   * テキスト配列をバッチ Embed して埋め込みベクトル配列を返す。
   * 入出力のインデックスは 1:1 対応。
   */
  embed(texts: readonly string[]): Promise<readonly number[][]>
}

export function createOpenAIEmbedProvider(apiKey: string, model: string): EmbedProvider {
  const client = new OpenAI({ apiKey, dangerouslyAllowBrowser: true })

  return {
    async embed(texts: readonly string[]): Promise<readonly number[][]> {
      if (texts.length === 0) return []

      const response = await client.embeddings.create({
        model,
        input: texts as string[],
      })

      // API は input の順序を保証しているが、index フィールドで並び替えて確実に対応
      const sorted = [...response.data].sort((a, b) => a.index - b.index)
      return sorted.map(e => e.embedding)
    },
  }
}
