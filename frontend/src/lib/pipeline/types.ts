/**
 * パイプライン内部データ構造。
 * Python PoC の models/segment.py に対応。
 * 全フィールドは readonly（immutable パターン）。
 *
 * ⚠️ 既存 UI の SubtitleBlock（types/subtitle.ts）とは別物。
 * runner.ts の出力時に変換する。
 */

// ---------------------------------------------------------------------------
// Step 2: 書き起こし出力
// ---------------------------------------------------------------------------

export interface WordTimestamp {
  readonly word: string
  readonly start: number       // 秒
  readonly end: number         // 秒
  readonly confidence: number  // 0.0〜1.0
}

export interface TranscriptSegment {
  readonly id: number
  readonly start: number               // 秒
  readonly end: number                 // 秒
  readonly text: string                // 日本語生テキスト
  readonly words: readonly WordTimestamp[]  // 空配列 = 単語TS未提供
}

// ---------------------------------------------------------------------------
// Step 4: 日本語補正後
// ---------------------------------------------------------------------------

export interface CorrectedSegment {
  readonly original: TranscriptSegment
  readonly correctedText: string
  readonly correctionDistance: number   // Embedding コサイン距離（補正前後）
  readonly correctionFlagged: boolean   // true = 意味が大きく変わった
}

// ---------------------------------------------------------------------------
// Step 5: 英訳後
// ---------------------------------------------------------------------------

export interface TranslatedSegment {
  readonly corrected: CorrectedSegment
  readonly translatedText: string
  readonly translationDistance: number  // Embedding コサイン距離（日→英）
  readonly translationFlagged: boolean  // true = 意味的乖離が大きい
}

// ---------------------------------------------------------------------------
// Step 6: 字幕ブロック（分割・タイムコード確定後）
// ---------------------------------------------------------------------------

export interface PipelineSubtitleBlock {
  readonly id: number
  readonly start: number          // 秒
  readonly end: number            // 秒
  readonly text: string           // 英語テキスト
  readonly jaText: string         // 日本語元テキスト（UI の source フィールド用）
  readonly charCount: number
  readonly cps: number            // Characters Per Second
  readonly cpsOk: boolean         // max_cps 以内か
  readonly sourceSegmentId: number
  readonly flagged: boolean       // 手動確認が必要
  readonly attempt: number
  readonly sourceSegmentIds: readonly number[]
  readonly blockKey: string       // ユニークキー "a{attempt}s{id}"
}

// ---------------------------------------------------------------------------
// #32: 日本語サイドアライメント — 中間型
// ---------------------------------------------------------------------------

export type AlignConfidence = 'exact' | 'proportional'

/**
 * splitJa ノードの出力。
 * 日本語文ひとつに対してタイムスタンプが確定している。
 */
export interface JapaneseSentenceBlock {
  readonly id: number
  readonly start: number          // 秒（findTimeRangeSequential で確定）
  readonly end: number            // 秒
  readonly jaText: string         // 日本語文
  readonly sourceSegmentIds: readonly number[]  // 元 TranscriptSegment.id 一覧
  readonly alignConfidence: AlignConfidence
  readonly attempt: number        // CPSループの試行番号（1始まり）
  readonly parentBlockId?: number // retry時、分割元ブロックの id
  readonly blockKey: string       // ユニークキー "a{attempt}s{id}"
}

/**
 * translateEn ノードの出力。
 * JapaneseSentenceBlock に英語テキストを加えた型。
 */
export interface EnglishBlock {
  readonly id: number
  readonly start: number          // JapaneseSentenceBlock から継承
  readonly end: number
  readonly jaText: string
  readonly enText: string
  readonly translationDistance: number
  readonly translationFlagged: boolean
  readonly attempt: number
  readonly sourceSegmentIds: readonly number[]
  readonly blockKey: string
}

// ---------------------------------------------------------------------------
// CPS ロールバック機構
// ---------------------------------------------------------------------------

/**
 * splitEn が検出した CPS 違反。
 * runner が splitJa へのロールバック判断に使う。
 */
export interface CpsViolation {
  readonly blockId: number
  readonly start: number
  readonly end: number
  readonly cps: number
  readonly maxCps: number
}

/**
 * splitJa に渡す「この時間範囲をより細かく分割して」というヒント。
 * retry 時に句読点（、）レベルで再分割するために使う。
 */
export interface SplitHint {
  readonly start: number
  readonly end: number
  readonly reason: 'cps_violation'
}

/**
 * splitEn ノードの出力。
 * 確定ブロックと残存 CPS 違反を両方返す。
 */
export interface SplitEnResult {
  readonly blocks: readonly PipelineSubtitleBlock[]
  readonly violations: readonly CpsViolation[]
}

// ---------------------------------------------------------------------------
// パイプライン全体の実行結果（runner.ts が返す内部型）
// ---------------------------------------------------------------------------

export interface PipelineInternalResult {
  readonly subtitleBlocks: readonly PipelineSubtitleBlock[]
  readonly flaggedCorrections: readonly CorrectedSegment[]
  readonly flaggedTranslations: readonly TranslatedSegment[]
  readonly srtPath: string
}
