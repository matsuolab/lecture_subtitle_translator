/**
 * デスクトップアプリのローカルWhisperX書きおこしが対応する言語一覧。
 *
 * この41言語は WhisperX のアライメントモデル辞書
 * （`DEFAULT_ALIGN_MODELS_TORCH` 5言語 + `DEFAULT_ALIGN_MODELS_HF` 36言語）に由来し、
 * jim60105/docker-whisperX の言語別イメージタグ（ビルドマトリクス docker-bake.hcl）と一致する。
 * 辞書に無い言語を渡すと WhisperX 側が `ValueError: No default align-model for language: xx`
 * で失敗するため、自由入力ではなくこの一覧からのみ選ばせること。
 *
 * 増減させるときは上流の docker-bake.hcl と whisperx/alignment.py の両方を確認すること。
 */
export interface WhisperxLanguage {
  code: string
  labelJa: string
}

// ja, en を先頭に出し、以降はコード定義順（前提調査で確定した並び）。
export const WHISPERX_LANGUAGES: readonly WhisperxLanguage[] = [
  { code: 'ja', labelJa: '日本語' },
  { code: 'en', labelJa: '英語' },
  { code: 'fr', labelJa: 'フランス語' },
  { code: 'de', labelJa: 'ドイツ語' },
  { code: 'es', labelJa: 'スペイン語' },
  { code: 'it', labelJa: 'イタリア語' },
  { code: 'zh', labelJa: '中国語' },
  { code: 'nl', labelJa: 'オランダ語' },
  { code: 'uk', labelJa: 'ウクライナ語' },
  { code: 'pt', labelJa: 'ポルトガル語' },
  { code: 'ar', labelJa: 'アラビア語' },
  { code: 'cs', labelJa: 'チェコ語' },
  { code: 'ru', labelJa: 'ロシア語' },
  { code: 'pl', labelJa: 'ポーランド語' },
  { code: 'hu', labelJa: 'ハンガリー語' },
  { code: 'fi', labelJa: 'フィンランド語' },
  { code: 'fa', labelJa: 'ペルシア語' },
  { code: 'el', labelJa: 'ギリシャ語' },
  { code: 'tr', labelJa: 'トルコ語' },
  { code: 'da', labelJa: 'デンマーク語' },
  { code: 'he', labelJa: 'ヘブライ語' },
  { code: 'vi', labelJa: 'ベトナム語' },
  { code: 'ko', labelJa: '韓国語' },
  { code: 'ur', labelJa: 'ウルドゥー語' },
  { code: 'te', labelJa: 'テルグ語' },
  { code: 'hi', labelJa: 'ヒンディー語' },
  { code: 'ca', labelJa: 'カタルーニャ語' },
  { code: 'ml', labelJa: 'マラヤーラム語' },
  { code: 'no', labelJa: 'ノルウェー語' },
  { code: 'nn', labelJa: 'ノルウェー語（ニーノシュク）' },
  { code: 'sk', labelJa: 'スロバキア語' },
  { code: 'sl', labelJa: 'スロベニア語' },
  { code: 'hr', labelJa: 'クロアチア語' },
  { code: 'ro', labelJa: 'ルーマニア語' },
  { code: 'eu', labelJa: 'バスク語' },
  { code: 'gl', labelJa: 'ガリシア語' },
  { code: 'ka', labelJa: 'グルジア語' },
  { code: 'lv', labelJa: 'ラトビア語' },
  { code: 'tl', labelJa: 'タガログ語' },
  { code: 'sv', labelJa: 'スウェーデン語' },
  { code: 'id', labelJa: 'インドネシア語' },
]

export const DEFAULT_WHISPERX_LANGUAGE = 'ja'

// 今回のスコープではモデルサイズは固定（言語のみ可変）。
export const WHISPERX_MODEL_SIZE = 'large-v3'

export function isSupportedWhisperxLanguage(code: string): boolean {
  return WHISPERX_LANGUAGES.some((lang) => lang.code === code)
}

/**
 * WhisperX の言語別 Docker イメージタグを組み立てる。
 *
 * 契約: 呼び出し側で `isSupportedWhisperxLanguage` により正規化済みの値を渡すこと。
 * 未対応コードを渡した場合は既定言語へフォールバックせず throw する
 * （既定へ静かにフォールバックすると、ユーザーが選んだ言語と実際に使われる
 * イメージが食い違う事故になるため）。
 */
export function resolveWhisperxImage(code: string): string {
  if (!isSupportedWhisperxLanguage(code)) {
    throw new Error(`unsupported WhisperX language code: ${code}`)
  }
  return `ghcr.io/jim60105/whisperx:${WHISPERX_MODEL_SIZE}-${code}`
}
