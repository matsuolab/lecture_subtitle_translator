# lecture_subtitle_translator

日本語講義動画から英語字幕を作成し、レビュー担当者が確認・修正・承認できる字幕編集アプリです。

このリポジトリでは、Desktop アプリ（Tauri + React）と、書き起こし・翻訳・字幕整形のパイプラインを開発しています。

> この README の操作手順・設定説明は `subtitle-editor v0.4.7` 準拠です。

---

## 利用者向け: アプリを使う

### 1. ダウンロード

GitHub の **Releases** ページから、自分の OS に合った最新版をダウンロードします。

| OS | ダウンロードするファイル | 起動方法 |
|---|---|---|
| Windows | `subtitle-editor-windows-x64.zip` | zip を展開し、フォルダ内の `subtitle-editor.exe` を実行（同フォルダの `ffmpeg.exe` も移動・削除しないでください） |
| macOS Apple Silicon | `subtitle-editor-macos-arm64.app.zip` | zip を展開して `.app` を開く |
| Linux x64 | `subtitle-editor-linux-x64.AppImage` | 実行権限を付けて起動 |

macOS や Windows で警告が出る場合は、配布元を確認したうえで OS の通常手順に従って許可してください。

> v0.4.7 以降、動画から音声を抽出する処理に LGPL ビルドの **FFmpeg** を同梱しています。詳細は [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) を参照してください。

### 2. 最低限必要な設定

初回起動後、右側の **設定** タブで実行先とAIプロバイダを設定します。リモート実行する場合は、接続先の Service URL と Service Auth Token も入力します。

| 項目 | 何を入れるか |
|---|---|
| 実行先 | `AWS / リモート実行` または `このPCで実行` を選びます |
| Service URL | リモート実行する場合のパイプライン API の URL |
| Service Auth Token | リモート実行する場合の認証トークン。公開しないでください |
| 接続先AIプロバイダ | 使用するAIプロバイダを選びます |
| API Key | 選択したAIプロバイダのAPIキーを入力します |
| 翻訳モデル | 既定値は `gpt-5.4-mini` |
| 補正モデル | 既定値は `gpt-5.4-mini` |
| 文脈統合モデル | 既定値は `gpt-5.5` |
| 1行文字数上限 | 既定値は `80` |
| CPS上限 | 既定値は `16.9` |

リモート実行では、設定後に **接続テスト** を押してください。OK が表示されれば、アプリからリモート実行先へアクセスできています。その後、**レポート** タブからパイプラインを実行できます。

#### ローカル OpenAI 互換サーバーを使う場合

LM Studio や Ollama などを使う場合は、**接続チェックが成功しても、実際の字幕パイプラインに十分な context length が確保されているとは限りません**。翻訳・補正ではプロンプト、few-shot、文脈グループ、用語辞書を同じリクエストに含めるため、サーバー側で次の設定を満たしてください。

| 用途 | 最低値 | 推奨値 |
|---|---:|---:|
| 短い音声での翻訳・補正テスト | 16k tokens | 32k tokens |
| 用語辞書あり、長めの講義、文脈グループが多い処理 | 32k tokens | 64k tokens |
| PDF Vision / 辞書生成など画像・長文を含む処理 | 32k tokens | 64k tokens 以上 |

- **LM Studio**: モデルロード時の `Context Length` / `n_ctx` を上の値に設定してください。OpenAI 互換 `/v1/chat/completions` 経由では、アプリからリクエストごとに context length を指定できません。
- **Ollama**: OpenAI 互換 API では context size を直接指定できないため、Ollama アプリの context length 設定、または `OLLAMA_CONTEXT_LENGTH=64000 ollama serve`、もしくは `Modelfile` の `PARAMETER num_ctx 32768` / `65536` で増やしてください。
- `Context size has been exceeded` が出る場合は、まずローカルサーバー側の実割当 context を確認してください。Ollama は `ollama ps` の `CONTEXT` 列で確認できます。
- context length を増やすと VRAM / RAM 消費が増えます。GPUからCPUへ大きくオフロードされる場合は、より小さいモデルや量子化モデルを使う方が安定します。

### 3. 基本的な作業の流れ

1. 動画ファイルを読み込む。
2. レポートタブでパイプラインを実行する。
3. 生成された字幕ブロックを上から順に確認する。
4. `提案`、`要確認`、用語漏れ、タイポ候補を確認する。
5. 問題なければ `承認` する。
6. 必要に応じてプロジェクト JSON または SRT を書き出す。

`自動処理 n` バッジを開くと、その字幕で行われた自動分割・短縮・前後結合などの履歴を確認できます。詳しい処理ログは **レポート** タブの `処理ログ` から確認できます。

---

## 現在のパイプライン概要

```
講義動画
  -> 音声抽出
  -> WhisperX などによる日本語書き起こし
  -> TypeScript 後段パイプライン
      -> 日本語ブロック分割・結合
      -> OpenAI による英語翻訳
      -> CPS / 行長 / 長時間表示 / 短い断片の検証
      -> 自動短縮・分割・文脈統合
      -> レビュー項目と処理ログ生成
  -> 字幕エディタで確認・承認
  -> SRT / プロジェクト JSON 出力
```

SRT は英語字幕の出力用です。日本語原文、処理ログ、レビュー状態、編集履歴を含めて保存する場合はプロジェクト JSON を使います。

---

## 主な機能

- 動画ファイルの読み込み
- 字幕ブロックの確認・編集・承認
- CPS、行長、表示時間の品質表示
- `提案` / `要確認` / `自動処理` のレビュー導線
- 字幕ブロック単位の自動処理ログ
- レポートタブでのモジュール別ログ、進行イベント、設定スナップショット確認
- 用語辞書 CSV / XLSX の読み込み
- 用語ハイライト、用語漏れ、タイポ候補表示
- SRT / プロジェクト JSON の入出力
- 日本語 / English / 中文 UI

---

## 管理者・エンジニア向け

### 管理者が確認する設定

- `translationProvider`: `openai`
- `translationModel`: `gpt-5.4-mini`
- `correctionModel`: `gpt-5.4-mini`
- `compressModel`: `gpt-5.4-mini`
- `expandModel`: `gpt-5.4-mini`
- `contextMergeModel`: `gpt-5.5`
- `subtitleLanguageLabel`: `English`
- `transcriptLanguageLabel`: `Japanese`
- `enMaxCharsPerLine`: `80`
- `enMaxCps`: `16.9`
- `pipelineVerboseEnRatio`: `1.5`

言語プロファイル JSON とプロンプト上書きは、アプリ内 **ヘルプ > 管理者向け** と **設定** タブの説明を確認してください。

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

## License

本リポジトリの本体コードのライセンスは [Apache License, Version 2.0](LICENSE) に従います。

第三者ソフトウェア（同梱する FFmpeg 等）のライセンス・告知は [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) を参照してください。
