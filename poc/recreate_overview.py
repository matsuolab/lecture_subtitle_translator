# -*- coding: utf-8 -*-

content = """# プロジェクト概要：講義動画 英語字幕化パイプライン

## 背景

東京大学 松尾研究室では、東大の英語化方針に基づき、**講義動画への英語字幕付与**が急務となっている。

このプロジェクトは、松尾研DXプロジェクト第三期として発足。AIエンジニアリング講座 of 優秀評価を受けた梶屋・松川の成果物を起点に、本格的なパイプライン構築へと発展させたもの。

## 現状の問題（As-Is）

100分の講義1本あたり、英語字幕化に **40〜50時間**（タイムコード作業だけで5〜7時間）かかっている。

```
講義音声
  ↓ Brew（Whisper内蔵）で文字起こし
  ↓ Gemini Gems でテキスト整形
      （スライドPDF＋専門用語辞書を与えて整形）
  ↓ LLM（Gemini）で英訳
  ↓ 中村さんが手動レビュー・修正（A4/80ページ相当）
  ↓ 増田さんが動画を見ながら手動でタイムコードを当てる
SRTファイル → 動画編集ソフトで合成
```

## ゴール（To-Be）

上記フローを自動化し、**人間のチェック工数を最小化**したパイプラインを構築する。

最終成果物：`講義音声 → SRTファイル（英語字幕）` の自動生成パイプライン

## 字幕技術仕様

| 仕様 | 値 | 根拠 |
|------|-----|------|
| 最大文字数 | **40文字/ブロック** | 映画字幕の経験則 |
| CPS | **15 Characters Per Second** | 人間の読み速度上限 |
| 表示時間目安 | **約3秒** | 40÷15から計算 |
| 動画への焼き付け | **NG** | 翌年の編集容易性のため |
| 出力形式 | SRT | 動画編集ソフトで読み込む形式 |

## 解決すべき3課題

### 課題①：センテンス境界のタイムスタンプが取れない

- 現行ツールは無音区間しか検出できない
- 一息で複数文を話した場合、文の区切りにタイムスタンプが入らない
- 逆に思考ポーズで不要な区切りが入ることもある
- **解決策候補**: WhisperX（アライメントモデルで語レベルタイムスタンプ）

### 課題②：字幕の自動分割・タイムコード割り付け（最大ボトルネック）

+ 英文を40文字以下・15CPSに合わせて手動でタイムコードを割り付けている。

```
例：発話セグメント（2分30秒〜2分50秒、20秒間）
  英訳後：250文字
  → 40文字で区切ると 8ブロック
  → 20秒 ÷ 8 = 2.5秒/ブロック（均等割り）
  → 実際は文字数比例での按分が必要（10文字〜40文字の不均等）
```

- **LLMへの「40文字で区切って」指示は信頼できない**（トークン≠文字数）
- **解決策候補**: LLMでテキスト生成 → Pythonで文字数チェック → 超過なら再プロンプト → N回失敗で人間フラグ

### 課題③：英訳の自然さ

- 一般的な翻訳ツールは直訳的になりがちで字幕に合わない
- 長い一文をそのまま訳すと、情報が多すぎて読みにくくなる
- **解決策候補**: BBC/Netflix等の字幕スタイルガイドをプロンプトに組み込む

## スケジュール

| フェーズ | 期間 | 内容 |
|----------|------|------|
| リサーチ | 〜2026年3月末 | 技術アプローチ実現可能性調査、OSS評価 |
| スコープ確定 | 2026年3月末 | 何をどこまで作るか決定 |
| 本開発 | 2026年4月〜 | 業務委託開始（時給2,000円、月30%コミット） |
| 目標リリース | 〜2026年秋 | 3ヶ月（最大6ヶ月）後 |

**注意**: 現在進行中のDL基礎講座（〜2026年6月）は人力対応継続。本プロジェクト成果は次期以降に適用。

## 体制

| 役割 | 担当 |
|------|------|
| PO・発注者 | 川本 Masaki（東京大学 松尾研） |
| 開発メンバー | 梶屋 英寛、松川 修啓 |
| 技術メンター | 佐藤 良明（週1定例参加） |
| 翻訳・英訳 | 増田（書き起こし）、中村 Yuna（翻訳レビュー）、松田（TA、翻訳補助） |
| 業務プロセス管理 | 新川 大翔 |

## リポジトリ

https://github.com/matsuolab/lecture_subtitle_translator（2026-03-27 確定）

## ミニリリース計画

> 最終更新: 2026-05-20
> 詳細なスプリントタスクは [`../10_meetings/ongoing_issues.md`](../10_meetings/ongoing_issues.md) を参照。

> 大本の設計思想: [`product_brief.md`](./product_brief.md)
> 設計計画詳細: [`../docs/system_design.md`](../docs/system_design.md)
> 方針: **GitHub をコラボレーション基盤として R2 から組み込む（R5 後付けではない）**

| Release | 内容 | 状態 | 残タスク |
|---------|------|------|---------|
| R1 | UIエディタ単体（Tauriデスクトップアプリ／GitHub Releasesからdl） | **完了** ✅ v0.2.0 | — |
| R2 | パイプライン実行 + GitHub基盤（FastAPI + AWS Batch + GitHub commit/Issues自動作成） | **着手中** | DAGバックエンド・非ブロッキング実行・Managed Service化・TypeScript後段 Stage 1・APIキーキーチェーン移行等は実装済み。また、独立したPoC環境において「自己進化型・字幕最適化エージェントPoC（`poc/cps_autonomous_agent_poc.py`）」を構築し、定量集計バグを完全解消した上で10世代の自己進化メタ・ループを完走、定量実証を完了。**残タスク**: 長尺・実データでの安定性確認、翻訳品質検証、障害復旧導線の監視継続 |
| R3 | 品質チェック高度化 + PRワークフロー（Issues種別精度向上 + DSPy統合 + PRテンプレート） | 評価データ待ち | raw仮訳＋修正後データの収集が前提（新川さん対応中） |
| R4 | 翻訳メモリ + 複数講座対応（SQLite + sqlite-vec + GitHub Projects Todoリスト） | R3以降 | 未着手 |
| R5 | GitHub Actions完全自動化（CI品質チェック・翻訳メモリ自動更新・進捗サマリー自動投稿） | 未定 | 未着手 |

### GitHub Actions 配布状況（2026-05-11時点）

詳細なビルド手順・配布 asset 名は `.github/workflows/release.yml` を単一情報源とする。現状は tag push 時に Windows exe、macOS app zip、Ubuntu 22.04 build の Linux AppImage に加え、Aurora / Fedora Atomic 系向けに Fedora 43 container build の RPM (`subtitle-editor-linux-fedora-x64.rpm`) を GitHub Release draft へ追加する。tag release 前の検証用に `workflow_dispatch` でも実行でき、その場合は GitHub Release へは上げず Actions artifact として保存する。

### AWS安定後に必ず扱う配布課題

- 現在、ローカルDockerに接続するためのローカル用 backend server が別になっている
- AWS での運用が落ち着いた後、OSS 配布に向けた作業として、この backend を
  - アプリ配布物に同梱する
  - もしくは別配布にする
  - のどちらで扱うかを設計し、確実に実施する
- これはローカル実装を維持したまま OSS 配布可能にするための必須課題として扱う
- 併せて、Managed Service は現状動画ファイルをそのまま受け取って AWS 側で音声抽出しているため、AWS運用安定後に「ローカルで音声抽出して音声のみ送信する」方式への見直しを必須課題として扱う

### R2 着手済み機能（2026-05-20時点）

- **自己進化型・字幕最適化エージェントPoC (2026-05-20)**:
  - 1.77 GBの実講義動画 `DL基礎_day2_JP確認.mp4` で音声抽出→WhisperX文字起こし→LLM校正（`ja_corrected`）を初回実行してキャッシュ化するライフサイクル。
  - 日本語（前処理）・英語（後処理）両段の方策（結合・分割・簡潔化・時間融通）をシミュレーションし、意味コサイン類似度（ローカルQwen Embedding）と制約ペナルティによる総合スコアで最適方策コンボを自律探索。
  - Gemini 3.5 Flash へのアクセスに加え、APIキー未設定やオフライン時でも動作可能な **ローカルの LM Studio (gemma-4-e4b-it) への自動フォールバック自己進化機構** を実装。
  - メタモデルのコンテキスト制限（n_ctx: 4096）を回避するため、失敗した難解セグメントから最難関の5件を厳選して送信する **インテリジェント・スライシング機構** を導入。これによりエラーを完全に回避。
  - 定量集計バグ（一発パスしたブロックが類似度0.0として平均を下げていた問題）を完全解消。集計対象を「初期違反ブロック」に厳密に限定する仕様に変更し、スコープエラー（NameError）も解消。
  - キャッシュ全体（232セグメント）を用いて、**10世代にわたる自動自己進化E2Eメタ・ループ（Gen 0〜Gen 9）を完走**（Task ID: `task-815`）。
  - **過剰進化（Prompt Over-Evolution / Saturation）とセマンティック崩壊の発見**: メタモデルは世代を重ねるごとに「解説の自然さ」を切り捨て、極端な情報圧縮（論理記号 $\Rightarrow$, $\equiv$ などを多用した axiomatic 形式への強制的要約）に走り、結果として意味的類似度が閾値（0.85）を下回って却下（rejected）される現象を突き止めた。これは自己進化プロンプティングにおける極めて重要な実証的発見である。
  - 本番コードに影響を与えないよう、完全に隔離された独立したPoCスクリプト（`poc/cps_autonomous_agent_poc.py`）内で自己進化メタ・ループの実動作と効果を実証。
- DAGパイプラインバックエンド（FastAPI + 非ブロッキング実行）
- WhisperX Docker直接呼び出し（ローカル実行）
- ドロップ起点のパイプライン導線・レポートタブ（フロントエンド）
- TypeScript 後段パイプライン Stage 1 実装（3フェーズ E2E 通し）:
  - Phase 1: `correctJa` / `splitJa` / `mergeShort`
  - Phase 2: `translateEn` / `formatLines` / `checkCpsViolations`
  - Phase 3: `terminologyCheck` / `toSubtitleBlocks`
  - 中間型 `JaBlock` / `EnBlock` と 9種違反分類（`ok` / `short_duration` / `over_compressed` / `verbose_en` / `line_length_only` / `long_segment` / `proportional_ts` / `merged_long` / `slow_speech`）を実装
  - `semanticCheck.ts` / `cpsGuard.ts` / `subtitleFormat.ts` を削除し、`localPipeline.ts` を 3 フェーズ構成へ更新
  - `translationModel` 設定を追加し、FT モデル指定時は短縮システムプロンプトへ切替
- **検証用 JSON セッション保存強化**: JSON 保存時に字幕ブロックだけでなく、動画名、秘匿値をマスクした設定スナップショット、最新実行結果、実行履歴、progress event、node trace、audit、transcript segments、初期/最終ブロックスナップショットを同梱して、再現・障害調査しやすい形式へ拡張
- Stage 2 は未着手:
  - `expandEn` / `compressEn`
  - Phase 2 リトライループ
  - `batchEmbed` / `alignBlocks`
  - FT モデル UI 入力欄
- レポート画面強化:
  - SummaryTab: パターン分布バー + テーブル + splitLongBlock統計
  - ExecutionLogTab: 全ノードトレース・expandEn/compressEn統計・splitLongBlockセクション
  - BlockDetailTab: DiagnosticPatternフィルターチップ＋リストビュー（パターン別一覧）＋ID検索詳細表示
- WhisperXキャッシュ再利用（correctJa以降のみ再実行）
- **APIキーOS keychain移行（セキュリティP0）**: Tauri keyring v3コマンド（set/get/delete_secret）+ hydrateFromKeychain非同期ハイドレーション。旧localStorage値の自動移行対応済み（2026-04-17）
- **UIバグ修正（2026-04-18）**: ドラッグ&ドロップ ブロック結合をHTML5 DnD → ポインターイベント方式に全面切り替え（Tauri WebView2でHTML5 DnD APIが不安定なため）。アンドゥ/リドゥの編集位置分割後の消失バグ修正（skipSaveRef）済み。
- **AdminSettings 字幕品質パラメータ化（v0.3.4）**: enMaxCharsPerLine / enMaxCps / subtitleMinDurationSec / subtitleMaxDurationSec / mergeMinJaChars / qualityCorrectionThreshold / qualityTranslationThreshold の7フィールドを Settings タブから変更可能に。CPS・文字数の警告バッジ色分け閾値もこれらに動的連動。
- **Local OpenAI Compatible LLM 対応（2026-05-12）**: Settings で `Local OpenAI Compatible` を選択し、LM Studio (`http://127.0.0.1:1234/v1`) / Ollama (`http://127.0.0.1:11434/v1`) の OpenAI 互換ローカルサーバーに LLM 後段処理を向けられるようにした。ローカル時は API key 任意、`/models` 取得で1件のみの場合はモデル欄へ自動採用し、実行時は解決済みモデルIDを必須化。LM Studio実測に合わせ、ローカル時は `response_format: text` に切り替え、未完JSONは共通パーサで補修する。
- **ステージ別デバッグスナップショット（2026-05-12）**: 保存JSON of `session.pipelineRun.debug.stageSnapshots` / `session.pipelineHistory[].debug.stageSnapshots` に、`transcribe`、`correctJa`、`splitJa`、`mergeShort`、`translateEn`、`formatLines`、`checkCpsViolations`、`correctionEngine`、`mergeContextFragments`、`terminologyCheck`、`toSubtitleBlocks` の軽量スナップショットを保存。書き起こしから補正・分割・翻訳・修正後まで、どの工程で字幕が崩れたかを後から追える。
- **字幕テキスト正規化（2026-05-19）**: Settings に折り畳み式の「正規化ルール設定」を追加。単一JSONルールセットを、自動生成の字幕ブロック出力前とユーザー操作のSRT出力時に適用する。初期ルールはスマートクォートとNBSPのASCII/通常スペース統一。ルールにIDやscopeは持たせず、適用対象は呼び出し側で決める。不正JSON時は自動生成では正規化をスキップして警告し、SRT出力時は「正規化せずに出力するか」を確認する。
- **API並列リクエスト数の共通化（2026-05-19）**: Settings の `apiRequestConcurrency` を上限なしの共通並列数として扱い、PDF辞書生成だけでなく字幕生成の `correctJa` / `translateEn` API バッチにも適用。`1` に戻すと逐次処理相当になり、過負荷時の切り戻しが可能。
- **長尺ローカルLLM correction の fail-fast 診断（2026-05-12）**: LM Studio等のローカルモデルで correction 応答が空・JSON不正・件数不一致になった場合、未処理のまま通さず、バッチ分割再試行後も1件単位で失敗するセグメントは `segment id` / 元テキスト / 応答payload診断つきでパイプライン失敗にする。失敗時も保存JSONに transcript と途中 `stageSnapshots` を残し、原因調査を可能にする。
- **警告バッジ強化（v0.3.4）**: 行数オーバー（enMaxLines）・合計文字数オーバー（enMaxTotalChars）の赤バッジ追加。warn スケールは maxCps×0.88、maxChars×0.85 で自動スケール。
- **actions.json 拡張（v0.3.4）**: initialBlocks / finalBlocks（元JP/EN・最終EN）を SessionLog に追記。作業前後の字幕スナップショットを記録。
- **保存ダイアログ修正（v0.3.4）**: Tauri capabilities に dialog:allow-save・fs:allow-write-text-file を追加（ファイル保存ダイアログが表示されない問題の根本修正）。
- **Legacy local backend 自動起動**: `Legacy Pipeline API` で `http://127.0.0.1:8765` / `localhost` を使う場合、Tauri 側が接続前に `uvicorn backend.api:app` を自動起動。ローカル切り分け時に backend 手動起動が不要。
- **Managed Service transcript 契約への責務縮小**: AWS result を `transcript_segments + words + metadata` 中心へ縮小し、translation API key や後段 pipeline 固有 payload を AWS へ送らない構成へ変更。
- **2段実行 + job_id 追跡強化**: AWS 側は WhisperX transcript job、ローカル側は補正・翻訳・品質チェック・字幕化を担当する構成へ整理。UI / ReportTab で `job_id`・進捗・失敗理由を追跡しやすくした。
- **dev Lambda / Batch worker 再デプロイ (#78)**: transcript 契約縮小後の live dev drift を解消。Lambda zip 再生成 + `update-function-code`、Batch worker thin layer build → ECR push（digest `sha256:c85ecf6a...`）+ job definition revision 7 登録済み。
- **判定メモ**: `TS Stage 1` は完了。`AWS Stage 1` も sample audio に限れば app からの最低限の通し確認まで完了。未解決なのは「Stage 1 未完了」ではなく、長尺・実データでの安定性、translate 後段、品質検証、運用導線の磨き込み。
- **残**: presigned PUT 実経路確認（DNS blocker 解消後）、長尺/実データでの再実行、実データ翻訳品質検証、翻訳者レビュー
"""

with open("00_context/project_overview.md", "w", encoding="utf-8") as f:
    f.write(content)
print("Recreated and repaired 00_context/project_overview.md successfully!")
