# lecture_subtitle_translator

日本語講義動画から英語字幕を作成し、レビュー担当者が確認・修正・承認できる字幕編集アプリです。

このリポジトリでは、Desktop アプリ（Tauri + React）と、書き起こし・翻訳・字幕整形のパイプラインを開発しています。データモデルは言語非依存の役割ベース（**書きおこし／字幕**）で、既定構成は 書きおこし＝日本語・字幕＝英語 です。

> **詳しい使い方・設定・運用・内部動作は [📖 Wiki](https://github.com/matsuolab/lecture_subtitle_translator/wiki) にまとめています。** この README は概要と入口です。

---

## 📖 ドキュメント（Wiki）

| 知りたいこと | ページ |
|---|---|
| インストールして使い始める | [Getting Started](https://github.com/matsuolab/lecture_subtitle_translator/wiki/Getting-Started) |
| 日々の字幕作成・レビュー作業の手順 | [操作マニュアル](https://github.com/matsuolab/lecture_subtitle_translator/wiki/Operator-Manual) |
| 画面の各ボタン・機能の意味 | [画面リファレンス](https://github.com/matsuolab/lecture_subtitle_translator/wiki/UI-Reference) |
| 環境構築〜接続テスト〜配布（管理者） | [管理者セットアップ](https://github.com/matsuolab/lecture_subtitle_translator/wiki/Admin-Setup) |
| 品質・コスト・接続の調整と対処（症状から引く） | [チューニング＆トラブルシュート](https://github.com/matsuolab/lecture_subtitle_translator/wiki/Admin-Tuning) |
| 設定項目の意味（表示名↔キー↔既定値） | [上級設定リファレンス](https://github.com/matsuolab/lecture_subtitle_translator/wiki/Settings-Reference) |
| JSON・プロンプト設定の書式 | [設定ファイルリファレンス](https://github.com/matsuolab/lecture_subtitle_translator/wiki/Config-Files-Reference) |
| パイプラインが内部で何をしているか | [動作原理](https://github.com/matsuolab/lecture_subtitle_translator/wiki/Pipeline-Behavior) |
| 手元のGPUで書きおこしを動かす | [ローカルWhisperXセットアップ](https://github.com/matsuolab/lecture_subtitle_translator/wiki/Local-WhisperX-Setup) |
| AWSで書きおこしバックエンドを構築 | [AWS バックエンド設定マニュアル](https://github.com/matsuolab/lecture_subtitle_translator/wiki/AWS-Backend-Setup) |

---

## 推奨環境

### アプリ本体（字幕エディタ）

デスクトップアプリ自体は一般的なPCで動作し、**GPUは必須ではありません**。

| 項目 | 内容 |
|---|---|
| 対応OS | Windows 10/11 (x64) / macOS (Apple Silicon) / Linux x64 (AppImage) / Fedora (RPM) |
| 必要なもの | 動画再生と音声抽出（同梱 FFmpeg）が動く程度のスペック |

### 書きおこし・翻訳をどこで動かすか

書きおこし（WhisperX）と 翻訳・補正（LLM）は、それぞれ独立に「ローカル / クラウド」を選べます。

**書きおこし（WhisperX）**

| 選択肢 | 必要なもの | 向いているケース |
|---|---|---|
| **ローカル（推奨・手軽）** | NVIDIA GPU ＋ Docker Desktop ＋ NVIDIA Container Toolkit（VRAM 8GB以上、12GB+ 推奨） | **GPUのあるPCがあれば最も簡単**。Docker Desktop を入れて GPU があればそのまま動く → [ローカルWhisperX](https://github.com/matsuolab/lecture_subtitle_translator/wiki/Local-WhisperX-Setup) |
| クラウド（AWS 等） | 構築済みバックエンドの Service URL / Token | GPU の無いマシンで使う、または **複数人で共有**して使う場合 → [AWS](https://github.com/matsuolab/lecture_subtitle_translator/wiki/AWS-Backend-Setup) |

**翻訳・補正（LLM）**

| 選択肢 | 必要なもの | 特徴 |
|---|---|---|
| **クラウド API** | OpenAI / Gemini の API キー | 手軽・高品質。従量課金。アプリ実行PCは軽量でよい |
| **ローカル LLM** | LM Studio / Ollama 等 ＋ 十分な VRAM/RAM（context 32k 以上を推奨） | API キー不要・データがローカル完結。context 長の設定に注意 → [Getting Started §3](https://github.com/matsuolab/lecture_subtitle_translator/wiki/Getting-Started#3-初期設定) |

> 手軽さ重視の入門構成は、**書きおこし＝ローカル（Docker＋GPU）／翻訳＝クラウド API**。GPU が無い、または複数人で使う場合は書きおこしを AWS 等クラウドへ。

---

## 利用者向け: アプリを使う

### 1. ダウンロード

GitHub の **Releases** ページから、自分の OS に合った最新版をダウンロードします。

| OS | ダウンロードするファイル | 起動方法 |
|---|---|---|
| Windows | `subtitle-editor-windows-x64.zip` | zip を展開し、フォルダ内の `subtitle-editor.exe` を実行（同フォルダの `ffmpeg.exe` も移動・削除しないでください） |
| macOS Apple Silicon | `subtitle-editor-macos-arm64.app.zip` | zip を展開して `.app` を開く |
| Linux x64 | `subtitle-editor-linux-x64.AppImage` | 実行権限を付けて起動 |
| Fedora | `subtitle-editor-linux-fedora-x64.rpm` | `dnf install` でインストール |

macOS や Windows で警告が出る場合は、配布元を確認したうえで OS の通常手順に従って許可してください。

> 動画から音声を抽出する処理に LGPL ビルドの **FFmpeg** を同梱しています。詳細は [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) を参照してください。

### 2. 最低限必要な設定

初回起動後、右側の **設定** タブで実行先とAIプロバイダを設定します。

| 項目 | 何を入れるか |
|---|---|
| 実行先 | `このPCで実行`（ローカル）または `リモート実行`（構築済みAPIを使う） |
| Service URL / Service Auth Token | リモート実行する場合のみ。接続先APIのURLと認証トークン（公開しないこと） |
| 接続先AIプロバイダ | OpenAI / Gemini / OpenAI互換 |
| API Key | 選択したAIプロバイダのAPIキー |

設定後に **接続テスト**（実行先の疎通）と **AI Gateway 接続チェック**（Chat / Embedding / Vision）を押し、OK を確認してから **字幕生成** タブでパイプラインを実行します。

- モデル・品質基準（翻訳/補正モデル、行長、CPS など）の **意味と既定値** → [上級設定リファレンス](https://github.com/matsuolab/lecture_subtitle_translator/wiki/Settings-Reference)
- 管理者が環境を整えて配布するまでの順路 → [管理者セットアップ](https://github.com/matsuolab/lecture_subtitle_translator/wiki/Admin-Setup)
- LM Studio / Ollama などローカルLLMの context length の注意 → [Getting Started §3](https://github.com/matsuolab/lecture_subtitle_translator/wiki/Getting-Started#3-初期設定)

### 3. 基本的な作業の流れ

1. 動画ファイルを読み込む。
2. 字幕生成タブでパイプラインを実行する。
3. 生成された字幕ブロックを上から順に確認する。
4. `要確認 🚩`、用語漏れ、タイポ候補を確認する。
5. 問題なければ `承認` する。
6. 必要に応じてプロジェクト JSON または SRT を書き出す。

各字幕で行われた自動分割・短縮・前後結合などの履歴は、**字幕生成** タブの `このブロックの自動処理履歴` で確認できます。詳しい処理ログは同タブの `処理ログ` から確認できます。操作の詳細は [操作マニュアル](https://github.com/matsuolab/lecture_subtitle_translator/wiki/Operator-Manual) を参照してください。

---

## 現在のパイプライン概要

```
講義動画
  -> 音声抽出
  -> WhisperX などによる日本語書き起こし
  -> TypeScript 後段パイプライン
      -> 日本語ブロック分割・結合
      -> LLM による英語翻訳
      -> CPS / 行長 / 長時間表示 / 短い断片の検証
      -> 自動短縮・分割・文脈統合
      -> レビュー項目と処理ログ生成
  -> 字幕エディタで確認・承認
  -> SRT / プロジェクト JSON 出力
```

機械が「字幕として成立する形（CPS・行長・行数・表示時間）」を検査・修復し、人が意味を最終確認する分担で動きます。設計思想と各処理の詳細は [動作原理](https://github.com/matsuolab/lecture_subtitle_translator/wiki/Pipeline-Behavior) を参照してください。

SRT は英語字幕の出力用です。日本語原文、処理ログ、レビュー状態、編集履歴を含めて保存する場合はプロジェクト JSON を使います。

---

## 主な機能

- 動画ファイルの読み込み
- 字幕ブロックの確認・編集・承認
- CPS、行長、表示時間の品質表示
- `要確認 🚩` バッジによるレビュー導線
- 字幕ブロック単位の自動処理履歴（字幕生成タブ）
- 字幕生成タブでのモジュール別ログ、進行イベント、設定スナップショット確認
- 用語辞書 CSV / XLSX の読み込み、PDF からの用語候補抽出
- 用語ハイライト、用語漏れ、タイポ候補表示
- 字幕スペル校正（英語 Hunspell 辞書を同梱、ユーザー辞書追加対応）
- SRT / プロジェクト JSON の入出力
- 日本語 / English / 中文 UI

---

## リポジトリ構成

| パス | 内容 |
|---|---|
| `frontend/` | 字幕エディタ UI / Tauri Desktop アプリ |
| `backend/` | WhisperX / Managed Service 周辺のバックエンド実装 |
| `poc/` | 実験・検証コード |
| `.github/workflows/` | build / release ワークフロー |

## 使用技術

本プロジェクトでは以下の技術を使用しています：

- **フロントエンド / デスクトップアプリ**:
  - React (v19) / TypeScript
  - Tauri (v2) - デスクトップアプリケーションフレームワーク
  - Tailwind CSS (v4)
  - Vite - ビルドツール
- **バックエンド / パイプライン**:
  - Python (v3.13)
  - FastAPI - パイプライン実行 API
  - Boto3 - AWS 連携（Lambda, Batch, S3, DynamoDB）
  - WhisperX - 高精度音声書き起こし・アライメント（GPU環境）
  - OpenAI API / Google GenAI SDK - 字幕の翻訳・補正・整形用 LLM
- **メディア処理**:
  - FFmpeg - 音声抽出用（LGPL ビルドを sidecar として同梱）
- **字幕校正**:
  - Hunspell / nspell / retext - 英語字幕のスペル校正・重複語検出
  - SCOWL/Ispell 由来の英語 Hunspell 辞書 - 詳細は `frontend/src/lib/pipeline/spellCheck/dictionaries/en.LICENSE` と `THIRD_PARTY_NOTICES.md`

## License

本リポジトリの本体コードのライセンスは [Apache License, Version 2.0](LICENSE) に従います。

第三者ソフトウェア（同梱する FFmpeg 等）のライセンス・告知は [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) を参照してください。スペル校正用辞書の追加とライセンスの注意は [上級設定リファレンス](https://github.com/matsuolab/lecture_subtitle_translator/wiki/Settings-Reference#スペル校正綴りチェックと辞書の追加) を参照してください。
