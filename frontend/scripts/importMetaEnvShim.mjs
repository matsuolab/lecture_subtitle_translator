/**
 * `frontend/src/api/adminSettings.ts` はモジュール先頭で `import.meta.env.VITE_...` を
 * 参照するが、`import.meta.env` は Vite ビルド時にのみ注入される値であり、
 * `tsx` でヘッドレス実行すると `import.meta.env` が `undefined` のままアクセスされて
 * `TypeError: Cannot read properties of undefined` で落ちる。
 *
 * `frontend/src/` 配下は変更禁止のため、Node のモジュールカスタマイズフック
 * (https://nodejs.org/api/module.html#customization-hooks) でロード後のソースを
 * 後処理し、`import.meta.env` を `(import.meta.env ?? {})` に書き換えることで
 * 未定義アクセスを吸収する（スクリプト側のみで完結する回避策）。
 *
 * 使い方:
 *   node --import tsx --import ./scripts/importMetaEnvShim.mjs scripts/runPipelineE2E.ts ...
 * (tsx を先に --import し、本シムを後に --import することで、
 *  本シムの load フックが tsx の変換結果を受け取ってから後処理できる)
 *
 * このファイル自身が `--import` されると、トップレベルで `module.register()` を呼んで
 * 自分自身をフックプロバイダとして登録する（Node のフックは register() 経由でしか
 * 有効化されないため、`--import` で読み込むだけでは `load` エクスポートは使われない）。
 */
import { register } from 'node:module'

register(import.meta.url)

const TARGET_SNIPPET = 'import.meta.env'
const REPLACEMENT = '(import.meta.env ?? {})'

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context)
  if (typeof result.source === 'string' && result.source.includes(TARGET_SNIPPET)) {
    return {
      ...result,
      source: result.source.split(TARGET_SNIPPET).join(REPLACEMENT),
    }
  }
  return result
}
