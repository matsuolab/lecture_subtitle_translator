/**
 * パイプライン内部データ構造。
 * Python PoC の models/segment.py に対応。
 * Python PoC の models/segment.py に対応。
 * 全フィールドは readonly（immutable パターン）。
 *
 * ⚠️ 既存 UI の SubtitleBlock（types/subtitle.ts）とは別物。
 * runner.ts の出力時に変換する。
 */

// ---------------------------------------------------------------------------
// 用語辞書（パイプライン層の軽量型 — React Context に依存しない）
// ---------------------------------------------------------------------------

export interface GlossaryItem {
  readonly ja: string
  readonly en: string
  readonly abbr?: string
}

// ---------------------------------------------------------------------------
// QA 違反種別・優先度（finalQA ノードが付与）
// ---------------------------------------------------------------------------

/**
 * ブロックの問題パターン分類（複数シグナルの組み合わせで根本原因を特定）。
 *
 * QaViolation が「症状」を列挙するのに対し、DiagnosticPattern は「根本原因」を1つ特定する。
 * finalQA が付与する。
 *
 * パターン定義:
 *   short_duration   duration < 1.5s            → splitJa分割しすぎ。CPS計算が不安定
 *   long_segment     duration > 10s, cps < 4    → WhisperX長発話。EN文が短くなるのは自然
 *   over_compressed  EN/JA比 < 0.25, cps < 5   → translateEn/compressEnが要約しすぎた
 *   verbose_en       cps > maxCps               → 英訳が冗長。compressEnで対処済みのはず
 *   proportional_ts  alignConfidence=proportional → wordアライメント失敗、TS推定値
 *   merged_long      merged + duration > 7s     → mergeShortで長くなりすぎた
 *   line_length_only lineLength違反、CPS=OK     → 行長のみの問題（書式）
 *   ok               問題なし
 */
export type DiagnosticPattern =
  | 'short_duration'
  | 'long_segment'
  | 'over_compressed'
  | 'verbose_en'
  | 'proportional_ts'
  | 'merged_long'
  | 'line_length_only'
  | 'ok'

export type QaViolationType =
  | 'cps'              // CPS > maxCps
  | 'cpsTooLow'        // CPS < MIN_CPS_LOW（テキストが短すぎる・字幕が長く表示されすぎる）
  | 'lineLength'       // 1行 > maxChars
  | 'durationShort'    // duration < MIN_DURATION
  | 'durationLong'     // duration > MAX_DURATION
  | 'timestampUncertain'  // alignConfidence = proportional/merged
  | 'overlap'          // 前ブロックとの重複（自動修正済みのものもflagで残す）

export interface QaViolation {
  readonly type: QaViolationType
  readonly detail: string  // 人間向け説明（例: "CPS 23.4 > 17.0"）
}

/** P1🔴=必須修正 P2🟡=修正推奨 P3🔵=確認推奨 null=問題なし */
export type ViolationPriority = 'p1' | 'p2' | 'p3' | null

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
  readonly text: string           // 英語テキスト（\n で改行を含む場合あり）
  readonly jaText: string         // 日本語元テキスト（UI の source フィールド用）
  readonly charCount: number
  readonly cps: number            // Characters Per Second
  readonly cpsOk: boolean         // max_cps 以内か
  readonly sourceSegmentId: number
  readonly flagged: boolean       // 手動確認が必要
  readonly attempt: number
  readonly sourceSegmentIds: readonly number[]
  readonly blockKey: string       // ユニークキー "a{attempt}s{id}"
  readonly alignConfidence: AlignConfidence  // TS精度（exact/proportional/merged）
  readonly qaViolations: readonly QaViolation[]   // finalQA が付与
  readonly violationPriority: ViolationPriority   // finalQA が付与
  readonly diagPattern: DiagnosticPattern          // finalQA が付与（根本原因分類）
}

// ---------------------------------------------------------------------------
// #32: 日本語サイドアライメント — 中間型
// ---------------------------------------------------------------------------

export type AlignConfidence = 'exact' | 'proportional' | 'merged'

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
  readonly alignConfidence: AlignConfidence  // JapaneseSentenceBlock から継承
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
