# システム設計計画

> 作成: 2026-03-31
> ベース: [要件定義書（20260331版）](../00_context/notion_requirements_20260331.md)
> 方針: **GitHub を単なるバージョン管理ではなく、翻訳チームのコラボレーション基盤として設計当初から組み込む**

---

## 設計の核心思想

要件定義書の「Git的機能（Issue/PR等でフィードバックがもらいやすいエコシステム）」は、後付けの付加機能ではない。
**翻訳ワークフロー全体の情報流通基盤として、アーキテクチャの中心に置く。**

```
動画 → [パイプライン] → SRTファイル（GitHub）→ Issues（人間へのTodo）→ PR（レビュー・承認）→ 最終SRT確定
```

---


## Drop-First UX 方針（R2実装指針）

> 追記: 2026-04-03

### North Star UX

最終的な利用体験を次の1本線で固定する。

```
動画ファイルをプレイヤーへドラッグ&ドロップ
  → パイプライン自動開始（文字起こし→補正→英訳→字幕化）
  → 字幕ブロック画面へ自動反映
  → そのまま人手編集・承認・出力
```

### 開発途中UIの原則

- 入口は最初から「動画Drop」で統一し、途中フェーズでも導線を増やさない。
- 右パネルに実行ステータス（進捗・ログ・エラー）を常設する。
- 未実装ステップは Stub として表示し、UXの流れは本番形を維持する。
- 実装段階に関係なく、完了時の反映先は常に字幕ブロック画面に固定する。

### 段階実装（R2）


### 実装メモ（2026-04-04）

- 動画Dropを起点に、Pipelineの進捗表示と字幕ブロックへの反映導線を先行実装した。
- 品質（CPS違反率・42文字超過率）とコスト（推定USD・トークン数・処理時間）をUIで可視化した。
- レポートタブを追加し、実行履歴を確認できるようにした（将来の集計・エクスポート拡張の基盤）。


1. Drop 起点ジョブ管理（ステータス表示 + 完了時のブロック反映）
2. 既存SRT入力ルート接続（高速に一気通貫を検証）
3. WhisperX書き起こしルート接続
4. 補正/翻訳/CPS再生成ループを実処理化
5. 品質・コストの自動レポート化


---

## 書き起こし・タイムスタンプ設計方針

> 追記: 2026-04-03

### 基本思想：タイムスタンプ精度をグレード化する

書き起こしと単語タイムスタンプを**分離した関心事**として扱う。
どちらも特定のツール（WhisperX等）にロックインしない。

```
【必須】タイムスタンプ付き書き起こし（セグメント単位）
         ↓ TranscribeProvider（抽象インターフェース）
    corrector → translator → splitter
         ↓
【オプション】単語単位タイムスタンプ
         ↓ WordTimestampProvider（抽象インターフェース）
    aligner
      ├─ 単語TSあり → diff-baseで精密マッピング
      └─ 単語TSなし → セグメント内を文字数比例で等分
         ↓
    SRT出力
```

### 入力パスのグレード

| グレード | 書き起こし入力 | 単語TS | タイムコード精度 |
|---------|-------------|--------|--------------|
| **A（精密）** | 動画 → TranscribeProvider | WordTimestampProvider あり | 単語境界で精密割付 |
| **B（標準）** | 動画 → TranscribeProvider | なし | セグメント内を文字数比例で等分 |
| **C（SRT流用）** | 既存SRT読み込み | なし | 既存タイムコードをそのまま使用 |
| **D（SRT+精密）** | 既存SRT読み込み | WordTimestampProvider あり | 既存SRTに単語境界を重ねて補正 |

松尾研の現行ワークフロー（既存SRTあり）はグレードC/Dで対応。
GPU不要ユーザーはグレードB（OpenAI Whisper API等）から始められる。

### TranscribeProvider（必須）

セグメント単位のタイムスタンプを持つ書き起こし結果を返す抽象インターフェース。
実装例（現在・将来）:

| 実装 | 概要 | 単語TS |
|------|------|--------|
| `DockerCLIWhisperXProvider` | jim60105/docker-whisperX をCLI実行 | ✅（JSONから取得）|
| `OpenAITranscribeProvider` | OpenAI Whisper API | ❌（セグメントのみ）|
| `SRTImportProvider` | 既存SRTファイルを読み込む | ❌ |
| `AWSBatchWhisperXProvider` | AWS BatchでDockerイメージ実行 | ✅ |
| `AssemblyAIProvider` | 将来対応候補 | ✅ |
| `DeepgramProvider` | 将来対応候補 | ✅ |
| `GoogleSTTProvider` | 将来対応候補 | △（要確認）|

### WordTimestampProvider（オプション）

既存の書き起こしセグメントに単語レベルタイムスタンプを付与する抽象インターフェース。
`TranscribeProvider` が単語TSを持たない場合に後処理として差し込む設計。

```python
class WordTimestampProvider(ABC):
    async def align(
        self, audio_path: str, segments: list[TranscriptSegment]
    ) -> list[TranscriptSegment]:
        """セグメントに words を付与して返す。"""
        ...
```

実装例:

| 実装 | 概要 |
|------|------|
| `WhisperXAlignProvider` | jim60105/docker-whisperX の --task align |
| `AssemblyAIAlignProvider` | 将来対応候補 |

### aligner のフォールバック仕様

`TranscriptSegment.words` が空タプルの場合:
- セグメントの duration を翻訳後テキストの文字数で比例分配
- 各SubtitleBlockに `timestamp_mode: "proportional"` を付与（品質レポートに記録）

`words` が存在する場合:
- 既存のdiff-baseアライメントで精密マッピング
- `timestamp_mode: "word_aligned"` を記録

### コードレベルのロックイン排除

`segment.py` の `WordTimestamp` クラスはWhisperX固有のものではない汎用データ構造として扱う。
`TranscriptSegment.words` が空タプルの場合は「単語TS未提供」を意味する（Noneは使わない）。

---

## アーキテクチャ全体像

```
┌─────────────────────────────────────────────────────────────┐
│                     GitHub Repository                        │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │  SRTファイル  │  │   Issues     │  │  Pull Requests   │  │
│  │（翻訳成果物） │  │（Todoリスト） │  │（レビュー承認）  │  │
│  └──────────────┘  └──────────────┘  └──────────────────┘  │
└─────────────────────────────────────────────────────────────┘
         ↑ commit/push                    ↑ open/close
┌─────────────────────────────────────────────────────────────┐
│                  V2S-AIE パイプライン                         │
│                                                              │
│  [1. 文字起こし]  [2. 日本語修正AI]  [3. 英語翻訳AI]         │
│   WhisperX          LLM + 用語集        LLM + 用語集         │
│       ↓                  ↓                   ↓              │
│  [4. SRT生成]  ←  [タイムスタンプ割付・15CPS制御]            │
│       ↓                                                      │
│  [5. 品質チェック] → Issues自動作成（種別ラベル付き）          │
└─────────────────────────────────────────────────────────────┘
         ↕ ブラウザ操作
┌─────────────────────────────────────────────────────────────┐
│                    UIエディタ（V2S-AIE）                      │
│  ・SRT編集（CPS/文字数リアルタイム表示）                      │
│  ・Issues一覧（種別フィルタ）・GitHub連携操作                  │
│  ・パイプライン実行トリガー                                    │
└─────────────────────────────────────────────────────────────┘
```

---

## UIドロップフローと設定スキーマ設計

> 追記: 2026-04-03

### UXビジョン

最終的に目指すユーザー体験：

```
【初回セットアップ（管理者・開発者が1回だけ行う）】
  設定画面でプロバイダー・APIキー・動作グレードを登録
        ↓
【日常利用（翻訳チームが行う）】
  動画ファイルをUIにドラッグ＆ドロップ
        ↓ 全自動
  書き起こし → 補正 → 翻訳 → 分割 → タイムスタンプ割付
        ↓
  SRTファイル完成 + 品質レポート + GitHub commit
```

設定さえ済んでいれば、翻訳チームはプロバイダーや技術構成を意識しなくてよい。

### 設定スキーマ（pipeline_settings.yaml）

UI設定タブから書き出す設定ファイルのイメージ。
環境変数（`.env`）より優先度を高く扱い、APIキーのみ `.env` から読む運用を想定。

```yaml
# pipeline_settings.yaml

transcribe:
  provider: docker_whisperx     # docker_whisperx | openai | srt_import
  backend: local                # local | aws_batch（provider=docker_whisperxの場合）

word_timestamps:
  enabled: true                 # false にすると常に等分モード
  provider: docker_whisperx     # 将来: assemblyai | deepgram 等

llm:
  correction:
    provider: gemini
    model: gemini-2.5-flash
  translation:
    provider: openai
    model: gpt-4.1
  split:
    provider: gemini
    model: gemini-2.5-flash

embed:
  provider: gemini
  model: gemini-embedding-001

constraints:
  max_chars: 40
  max_cps: 15.0
  max_retry: 3

output:
  dir: ./output
  github_commit: true           # SRT生成後にGitHub commitするか
```

### 設定の優先順位

```
UI設定ファイル（pipeline_settings.yaml）
        ↓ 上書き
環境変数（.env）          ← APIキーのみここで管理
        ↓ 上書き
コードのデフォルト値
```

APIキー（`OPENAI_API_KEY`等）はファイルに書かず `.env` に留める。
設定ファイルは Git 管理対象にして、チーム間で共有できる。

> **⚠️ 仮設計（要調査）**: APIキー管理フロー（OSキーチェーン統合・AWS Secrets Manager・OSS配布時のUX等）は未調査。正式設計は別途タスクで決定する。

### 既存 PipelineConfig との対応

`config.py` の `PipelineConfig` が既にこの構造に近い。
追加実装として「YAML設定ファイル → `PipelineConfig`」の読み込みパスを追加する。
環境変数と設定ファイルを統合した `load_config(settings_path)` に拡張するイメージ。

### 動作グレードの自動決定ロジック

設定に基づいてパイプラインが自動でグレードを選択する：

```
transcribe.provider = docker_whisperx AND word_timestamps.enabled = true
  → Grade A（精密モード）

transcribe.provider = openai OR word_timestamps.enabled = false
  → Grade B（標準モード）

transcribe.provider = srt_import AND word_timestamps.enabled = false
  → Grade C（SRT流用モード）

transcribe.provider = srt_import AND word_timestamps.enabled = true
  → Grade D（SRT+精密モード）
```

ユーザーはグレードを直接指定するのではなく、プロバイダー設定の結果としてグレードが決まる。

---

## GitHub を中心とした業務フローマッピング

### SRTファイルのリポジトリ構造（案）

```
lecture_subtitle_translator/
├── subtitles/
│   ├── dl-basics/          # DL基礎講座
│   │   ├── day01/
│   │   │   ├── raw.srt     # パイプライン自動生成（JP+EN仮訳）
│   │   │   └── final.srt   # 人間修正後・承認済み
│   │   ├── day02/
│   │   └── ...
│   └── <other-course>/     # 複数講座横断対応
```

### GitHub 機能と翻訳ワークフローの対応

| GitHub機能 | 翻訳ワークフローでの役割 |
|-----------|----------------------|
| **Commit** | パイプライン実行 → SRTファイルの自動保存 |
| **Issue（CPS違反）** | 15CPS超え箇所の自動報告 → 中村さんへのTodo |
| **Issue（意味乖離）** | LLMが自信低として判定した翻訳箇所のフラグ |
| **Issue（専門用語疑義）** | 用語辞書にない用語の人間確認依頼 |
| **Issue（Todoリスト）** | 講座ごとの対応状況管理（複数講座横断） |
| **Pull Request** | 中村さんの修正完了 → 校閲担当へのレビュー依頼 |
| **PR Review** | 校閲担当の承認 → 最終SRT確定 |
| **PR Template** | レビュー観点の標準化（15CPS確認・用語確認など） |
| **Labels** | 違反種別の視覚的分類（cps-violation / terminology / translation-review） |
| **GitHub Projects** | 複数講座のTodo進捗ボード（Todoリスト自動作成 F7 の実体） |
| **GitHub Actions** | 品質チェックの自動実行（PR時にCPS検証スクリプト実行） |

---

## リリース計画（再設計）

> 旧R1〜R5の流れを維持しつつ、GitHub連携を後付けではなくR2から組み込む

### R1 — UIエディタ単体 ✅ほぼ完了

**方針**: スタンドアロンHTMLツール。GitHub連携なし。翻訳チームの手元で動く。

完了済み機能:
- SRT読み込み / ローカル動画読み込み
- CPS・文字数リアルタイム表示 / 42文字超え警告
- 用語辞書タイポ検出・用語漏れ検出
- SRTエクスポート・JSONプロジェクト保存
- Undo/Redo / ブロック分割

残タスク:
- 実データ（`5_DL基礎_day2_EN仮訳.txt` + `.mp4`）での動作確認
- flaggedステータスUI（任意）

---

### R2 — パイプライン実行 + GitHub基盤

**方針**: 動画 → SRT 自動生成パイプライン。生成物をGitHubに自動commitし、Issues自動作成の基盤を確立する。

```
動画ファイル または 既存SRT
  → TranscribeProvider（書き起こし + セグメントTS）  ← 実装差し替え可
  → WordTimestampProvider（単語TS付与）[オプション]  ← 実装差し替え可
  → LLM（日本語修正 + 用語辞書参照）                ← F3
  → LLM（英語翻訳 + 用語辞書参照）                  ← F4
  → 15CPS・40文字制御ループ                          ← F5
  → SRT自動出力（タイムスタンプ精度はグレードに依存） ← F6
  → GitHub commit（raw.srt として push）
  → Issues自動作成（CPS違反・疑義箇所）              ← F7, F8
```

技術スタック:
- FastAPI（パイプライン実行API）
- AWS Batch / EC2 Spot g4dn.xlarge（TranscribeProvider実行環境）
  - R2時点の実装: `jim60105/docker-whisperX` コンテナ（`large-v3-ja` タグ）
  - S3(入力音声) → Batch Job → S3(出力JSON) → パイプライン読み込み
- GitHub API（commit / Issue作成）
- UIにパイプライン実行タブを追加

セキュリティ対応（NF1）:
- GitHubリポジトリをプライベート設定
- UIへのアクセスはGitHub OAuth認証で制限
- 動画ファイルはサーバー上に保持せず処理後即削除（または暗号化ストレージ）
- AWS環境はVPC内に閉じ、パブリックエンドポイントを最小化

---

### R3 — 品質チェック高度化 + PR ワークフロー

**方針**: Issues の種別精度向上と、翻訳チームがGitHub PR を使って自然にレビューできる環境を整備する。

```
[Issue自動作成の高度化]
- CPS違反（15CPS超え）          → label: cps-violation
- 意味乖離（LLM自信スコア低）   → label: translation-review
- 専門用語疑義（辞書外用語）    → label: terminology

[PR テンプレート整備]
- 修正完了チェックリスト（CPS確認・用語確認）
- 校閲担当へのレビュー依頼フォーマット

[UIエディタ拡張]
- Issues一覧タブ（種別フィルタ・GitHubリンク）
- Issue解決 → UIから直接クローズ操作
```

DSPy統合（プロンプト自動最適化）:
- raw仮訳 + 中村さん修正後データを学習データとして収集
- DSPyオプティマイザーで翻訳プロンプトを自動改善

---

### R4 — 翻訳メモリ + 複数講座対応

**方針**: 過去の承認済みPR（翻訳ペア）を翻訳メモリとして蓄積し、次回翻訳の品質向上に活用。複数講座の横断管理をGitHub Projectsで実現する。

```
[翻訳メモリ]
- マージ済みPR（raw.srt → final.srt 差分）を自動収集
- SQLite + sqlite-vec でコサイン類似度検索
- 類似フレーズを翻訳時に参照（翻訳一貫性の向上）

[複数講座Todoリスト（F7）]
- GitHub Projects ボード（講座 × 回 × 状態）
- パイプライン実行 → 自動でProject Itemを作成
- Issue解決 → Projectの状態を自動更新
```

---

### R5 — 完全自動化 + GitHub Actions

**方針**: 品質チェックをCIとして自動実行し、人間は判断のみに集中できる状態にする。

```
[GitHub Actions]
- PR open時: CPS検証スクリプト自動実行 → 違反があればコメント
- PR merge時: 翻訳メモリDBを自動更新
- 定期実行: 講座進捗サマリーをIssueに自動投稿

[最終状態]
- 動画をアップロードするだけでSRTのPRが作られる
- 人間は「PRレビュー」と「Issue対応」のみ
```

---

## 各フェーズの前提条件

| Release | 前提条件 |
|---------|---------|
| R1 | 実データでの動作確認（新川さんデータ待ち） |
| R2 | 業務委託契約完了 / WhisperX AWS Batch環境構築 / GitHub repository設定 / セキュリティ方針合意 |
| R3 | raw仮訳 + 修正後データの収集完了（新川さん対応中）/ 中村さんのSlack参加 |
| R4 | R3のDSPy最適化が一定収束 / 複数講座への展開が始まっている |
| R5 | R4の翻訳メモリが十分な量蓄積 |

---

## 未確定事項との対応

| 未確定事項 | 対応フェーズ | アプローチ |
|-----------|------------|-----------|
| LLM翻訳の実用性 | R2完了後に評価 | 中村さんにR2生成SRTをレビューしてもらいPR差分で品質を定量評価 |
| 品質の評価基準 | R2〜R3 | GitHub PRの差分（raw→final）を蓄積しDSPyの評価メトリクスとして定義 |
| 15cps調整の複雑さ | R2で実装・R3で改善 | LLMループ実装後、実データでの失敗パターンを収集しフォールバック設計 |

---

## 4/2 MTGで合意すべき事項

1. **GitHub連携をR2スコープに含めるか確認**（この設計計画の承認）
2. **セキュリティ方針の合意**（プライベートリポジトリ + GitHub OAuth認証）
3. **Issue Labelの定義合意**（CPS違反・意味乖離・専門用語疑義）
4. **SRTファイルのリポジトリ構造合意**（上記案の確認）
5. **「Todoリスト自動作成」の具体的定義**（GitHub Projects 案の可否）

---

## DAG + Agent SDK 設計方針（2026-04-04 追記）

### 背景

翻訳品質チェック（意味近似・用語漏れ）や、書き起こしダブルチェック（複数ASR比較）を将来追加する前提では、
直列固定のパイプラインよりも「状態付きDAG」で工程管理する方が拡張コストが低い。

### 採用方針

- 全体オーケストレーションは **DAG実行エンジン** で管理する。
- 各ノード内の「生成→検証→再生成」は **Agent SDK** で実行する。
- 判定ロジック（CPS/文字数/用語漏れ/閾値比較）はツール関数で決定論にする。
- LLMは翻訳・言い換え・修正案生成に集中させる。

### ノード設計の基本単位

各ノードは以下を必須で持つ。

- 入力スキーマ
- 出力スキーマ
- 実行Provider情報（model/provider/version）
- 品質メトリクス
- 再試行条件（Policy）

`RunState` は全ノードの入出力・試行回数・エラー・コストを保存し、Reportタブへ連携する。

### 初期DAG（最小）

```
transcribe_primary
  -> ja_correct
  -> translate
  -> subtitle_format
  -> done
```

### 拡張DAG（段階追加）

```
transcribe_primary
  -> transcribe_checker
  -> asr_consensus_check
  -> ja_correct
  -> translate
  -> semantic_check
  -> terminology_check
  -> subtitle_format
  -> cps_guard
  -> done
```

### 再実行ポリシー（例）

- semantic_check スコア < 0.85: `translate` に戻す（最大3回）
- terminology_check NG: `translate` に戻す（最大2回）
- cps_guard NG: `subtitle_format` に戻す（最大3回）
- asr_consensus_check NG: `human_review_flag` を付与して先へ進む（停止はしない）

### 実装ロードマップ（DAG前提）

1. PoC資産（`poc/step2_pipeline`）をノード単位で再配置
2. DAG Runner / RunState / Policy Engine をバックエンドに実装
3. 直列4工程をDAG上で再現（挙動互換）
4. semantic_check / terminology_check / cps_guard を順次追加
5. transcribe_checker + consensus_check を追加
6. Reportタブにノード別結果（スコア・再試行回数・provider）を表示

### 補足

初心者向け学習ドキュメントは `docs/dag_agent_pipeline_learning.md` に保存した。

### ノード改良容易性を要件化（REQ-ARCH, 2026-04-04）

- `REQ-ARCH-01` ノード差し替え可能性: すべてのノードは共通 `NodeContract`（入力/出力スキーマ）に準拠し、同一IDのノードを別実装へ差し替えてもDAG全体が動作すること。
- `REQ-ARCH-02` 後方互換性: ノード入出力は `schema_version` を持ち、互換性を壊す変更を検知できること。
- `REQ-ARCH-03` 単体テスト可能性: ノードはDAGランナーと分離して単体テストできること。結合前にノード単位で品質検証を行うこと。
- `REQ-ARCH-04` 観測可能性: `RunState` にノードごとの provider/model/tokens/duration/retry/error を保存し、UIレポートから参照できること。

---

## 第四回MTG反映（2026-04-04）

> 参照: `10_meetings/20260402_第四回MTG_定例第一回.md`

### 追加設計方針

1. 品質ゲートを「全件確認」から「要確認箇所の優先確認」へ移行する。
- semantic_check / terminology_check / cps_guard の各ノードでスコアリングし、レビュー優先度を付ける。

2. 翻訳者の修正判断を学習資産として蓄積する。
- ラベル（意訳、文字制約、訳間違いなど）付きの修正ログを評価データ化し、DSPy最適化と検知閾値調整に再利用する。

3. スライド文脈を標準入力として扱う。
- 補正・翻訳ステップにPDF抽出テキストを投入し、専門用語と講義文脈の整合を上げる。

4. ROI計測を設計要件に含める。
- 導入前後で工程別作業時間（書き起こし、補正、翻訳、CPS調整、レビュー）を記録し、費用対効果を継続算出する。

5. セキュリティレビューをリリースゲート化する。
- 開発側がデータフロー図と対策案（アクセス制御、秘密情報管理、改ざん防止）を提示し、合意後に運用へ移行する。

### 運用モデル補足

- APIキー登録・更新は運用管理者のみ実施する。
- 翻訳担当者には秘密情報を配布せず、UI経由の業務操作に限定する。
