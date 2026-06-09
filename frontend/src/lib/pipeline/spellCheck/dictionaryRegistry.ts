// 同梱辞書はブラウザ(Tauri webview)で読むため、Vite アセットURL + fetch で取得する。
// dictionary-en パッケージ本体は `node:fs` をトップレベルで使う Node 専用モジュールであり、
// webview で import すると例外で白画面になるため使わない（ファイルだけ dictionaries/ へ複製）。
import enAffUrl from './dictionaries/en.aff?url'
import enDicUrl from './dictionaries/en.dic?url'

// hunspell 辞書（aff/dic）は **UTF-8 文字列**で保持する。
// nspell の affix/dictionary パーサは内部で `doc.toString('utf8')` を呼ぶが、
// ブラウザには Node Buffer が無く、Uint8Array に `.toString('utf8')` を呼ぶと
// "83,69,84,..." のような数値列になり辞書が壊れる（全単語が誤検出になる）。
// そのため fetch したバイト列を TextDecoder で UTF-8 文字列へデコードして渡す。
export interface HunspellDictionary {
  aff: string
  dic: string
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url)
  const bytes = new Uint8Array(await res.arrayBuffer())
  return new TextDecoder('utf-8').decode(bytes)
}

let bundledEnPromise: Promise<HunspellDictionary> | null = null
function loadBundledEnglish(): Promise<HunspellDictionary> {
  if (!bundledEnPromise) {
    bundledEnPromise = Promise.all([fetchText(enAffUrl), fetchText(enDicUrl)])
      .then(([aff, dic]) => ({ aff, dic }))
  }
  return bundledEnPromise
}

export function isEnglishLabel(label: string): boolean {
  const n = label.trim().toLowerCase()
  return n === 'en' || n.startsWith('en-') || n.startsWith('en ') || n.includes('english')
}

/**
 * 言語ラベルに対応する「アプリ同梱」hunspell辞書を返す（無ければ undefined）。
 * 現状は英語のみ同梱（en_US, MIT AND BSD）。
 * 他言語はライセンス都合でコア非同梱（一般用語辞書インポート or Tier2 LLM へ委譲）。
 * 詳細: docs/adr/0003-subtitle-spellcheck.md
 */
export async function loadBundledDictionary(label: string): Promise<HunspellDictionary | undefined> {
  if (!label.trim()) return undefined
  if (isEnglishLabel(label)) return loadBundledEnglish()
  return undefined
}

/**
 * 辞書解決の本番ロジック：ユーザー投入辞書（importedLabels に含まれる言語）を優先し、
 * 無ければ同梱辞書（英語）へフォールバックする。
 */
export async function loadDictionaryForLabel(
  label: string,
  importedLabels: string[],
): Promise<HunspellDictionary | undefined> {
  const matched = importedLabels.find(l => l.trim().toLowerCase() === label.trim().toLowerCase())
  if (matched) {
    const { loadUserDictionary } = await import('./userDictionaryStore')
    const user = await loadUserDictionary(matched)
    if (user) return user
  }
  return loadBundledDictionary(label)
}
