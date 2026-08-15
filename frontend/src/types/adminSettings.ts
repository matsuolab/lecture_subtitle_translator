import type { ModelProfilePresetId } from './modelProfile'

export type TranslationProvider = 'openai' | 'gemini' | 'local_openai'
export type ServiceMode = 'managed_service' | 'legacy_pipeline'
export type SemanticCheckMode = 'off' | 'log_only' | 'enforce'
export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high'
export type ApiCompatibilityProfilePresetId = 'auto' | 'openai' | 'lmstudio' | 'ollama' | 'gemini_openai_compatible' | 'user'
export type AlignTokenMode = 'auto' | 'char' | 'word'
export type { ModelProfilePresetId } from './modelProfile'

export interface AdminSettings {
  serviceMode: ServiceMode
  serviceUrl: string
  serviceAuthToken: string
  hfToken: string
  openaiApiKey: string
  geminiApiKey: string
  openaiCompatibleBaseUrl: string
  translationProvider: TranslationProvider
  apiCompatibilityProfilePreset: ApiCompatibilityProfilePresetId
  apiCompatibilityProfileJson: string
  modelProfilePreset: ModelProfilePresetId
  modelProfileJson: string
  chatTextProfilePreset: ModelProfilePresetId
  chatTextProfileJson: string
  chatVisionProfilePreset: ModelProfilePresetId
  chatVisionProfileJson: string
  embeddingProfilePreset: ModelProfilePresetId
  embeddingProfileJson: string
  translationModel: string
  correctionModel: string
  pdfExtractionUseVision: boolean
  pdfExtractionVisionModel: string
  pdfFormulaMiniModel: string
  pdfExtractionParallel: boolean
  glossaryMaxOutputTokens: number
  apiRequestConcurrency: number
  // ローカルLLM(LM Studio等)が応答を返さなくなった場合の打ち切り時間（秒）。
  // 0秒付近まで下げると正常な大バッチ処理まで誤って打ち切ってしまうため下限を設けている。
  llmRequestTimeoutSec: number
  embeddingModel: string
  // セマンティックチェック（圧縮前後の意味類似度を Embedding で計測）
  semanticCheckMode: SemanticCheckMode
  enMaxCharsPerLine: number
  enMaxLines: number
  enMaxCps: number
  subtitleMinDurationSec: number
  // 表示層のギャップ閉じ（closeSubtitleGaps.ts）: これ以下の隣接 cue 間の空白は
  // 前の cue を延ばして閉じる（ちらつき防止）。0 なら閉じない。
  // アライメント層（asrAlignment.ts）が返す時刻の正しさとは別レイヤーの設定。
  subtitleMaxGapSec: number
  qualityCorrectionThreshold: number

  // 字幕スペル校正（subtitle側）。対応辞書がある言語なら自動チェック。詳細: docs/adr/0003-subtitle-spellcheck.md
  /** ユーザーが「辞書に登録」した正しい綴り語（誤検知除外・ユーザー全体スコープ） */
  spellUserDictionary: string[]
  /** 一般用語辞書インポートで導入済みの言語ラベル一覧（hunspell .aff/.dic はアプリのデータ領域に保存。ユーザー全体スコープ） */
  spellImportedDictionaryLabels: string[]

  // パイプライン閾値（PipelineThresholds に完全マッピング）
  pipelineShortDurationSec: number
  pipelineLongDurationSec: number
  pipelineMergedLongDurationSec: number
  /**
   * 未使用（判定ロジックから撤去済み）。
   * 英日文字比による判定は classifyViolation / reviewDiagnostics から廃止され、
   * 現在この値を参照する判定は存在しない（CPS・行長のしきい値で制御する）。
   * PipelineThresholds からも削除済みだが、既存の保存済みプロジェクト JSON に
   * この値が残っているため、読み込み時に落ちないよう AdminSettings 側にだけ残している。
   */
  pipelineVerboseEnRatio: number
  pipelineOverCompressedRatio: number
  pipelineOverCompressedJaChars: number
  pipelineSlowCps: number
  pipelineMaxExpandPerBlock: number
  pipelineMaxCompressPerBlock: number

  // Phase1: 継続助詞（mid-sentence cut）で終わる JA ブロックを次と結合する前処理
  // semanticSplitJa が「〜が」「〜の」「〜まで」等で切れたブロックを生むと、後段 translateEn が
  // 隣接ブロック内容を取り込んで EN がオーバーフローし、CPS 違反になる。これを未然に防ぐ。
  pipelineMergeContinuationEnabled: boolean
  pipelineMergeContinuationMaxGapSec: number
  pipelineMergeContinuationMaxDurationSec: number
  pipelineMergeContinuationMaxTranscriptChars: number
  // mergeContinuation で使う「未完結末尾」判定モデル（nano クラス推奨）。
  // 空欄なら splitJaModel にフォールバック。多言語対応のため LLM で判定する。
  incompleteEndDetectionModel: string
  incompleteEndDetectionBatchSize: number
  // thinking系モデルの reasoning トークン消費分の割り増し予算（withReasoningHeadroom が加算する値）。
  // 既定 0 は「自動」= modelProfile の reasoning.capability 推定に従う（resolveModelProfile が
  // モデル名の部分一致 'gemma'/'qwen' 等でしか推定できず、それ以外は undefined になり割り増しが
  // 一切効かない。この設定はその取りこぼしを利用者が明示的に埋めるためのもの）。
  // 0より大きい値を設定すると、プロファイル推定に関係なくその値を常に加算する。
  // 効くのは実質 local_openai 経路のみ（openai/gemini は adaptChatCompletionRequest が
  // トークン上限フィールド自体を送らないため。modelProfile.ts の stripTokenLimitFields 参照）。
  llmReasoningBudgetTokens: number

  // ノード別モデル
  compressModel: string
  microModel: string
  expandModel: string
  contextMergeModel: string
  splitJaModel: string
  // WhisperX の書きおこし言語コード（例 'ja'）。言語ラベル（subtitleLanguageLabel /
  // transcriptLanguageLabel）はAIプロンプト用の表示名で別物。対応言語は
  // frontend/src/lib/pipeline/whisperxLanguages.ts の WHISPERX_LANGUAGES を参照。
  transcribeLanguageCode: string
  subtitleLanguageLabel: string
  transcriptLanguageLabel: string
  languageProfileConfigJson: string
  // 書きおこしトークン単位。WhisperXは日本語/中国語のみ1文字ずつ、それ以外は単語ごとに
  // タイムスタンプを返す（asrAlignment.ts の detectAsrScriptDetail 参照）。既定 'auto' は
  // ASR出力（words[]）の平均トークン長から自動判定する。'char'/'word' は明示固定で、
  // 誤判定時のユーザー救済や、判定材料（words[]）が乏しい入力向けの上書き手段。
  alignTokenMode: AlignTokenMode
  textNormalizationEnabled: boolean
  textNormalizationRulesJson: string

  // プロンプト上書き（'' = デフォルト使用）
  correctionAdditionalInstructions: string
  correctionFewShotJson: string
  translationAdditionalInstructions: string
  translationFewShotJson: string
  compressPromptOverride: string
  expandPromptOverride: string

  // 非推奨。coverageRepairAgent 廃止に伴い未使用。
  // 古い保存プロジェクトの設定ファイルを壊さないよう型・正規化のみ残している（UIからは削除済み）。
  coverageRepairEnabled: boolean
  // 非推奨。coverageRepairAgent 廃止に伴い未使用。
  coverageRepairModel: string
  // 非推奨。coverageRepairAgent 廃止に伴い未使用。
  coverageRepairEffort: ReasoningEffort

  // general_repair_agent エスカレーション（low → medium → high）の有効化
  // OFF にすると manual_review に直行する（PoC 同等プロセス保証を放棄）
  generalRepairEnabled: boolean
  // general_repair_agent 用モデル（空欄なら compressModel にフォールバック）
  generalRepairModel: string
  // general_repair_agent エスカレーション上限。リリース前のコスト抑制中は high も medium 相当に丸める。
  generalRepairMaxEffort: 'low' | 'medium' | 'high'

  // デバッグ機能
  // debugModeEnabled が master switch。OFF 時はサブ機能フラグが ON でも全部無効
  debugModeEnabled: boolean
  // サブ機能: correctJa 後に Embedding で意味変動を計測。debugModeEnabled と AND
  correctionDebugEmbedding: boolean

  // ワークログ（作業データ記録）の保管場所（'' = 既定の appLocalDataDir/worklogs）
  workLogDir: string
}
