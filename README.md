# lecture_subtitle_translator

> AI-powered pipeline for generating English subtitles from Japanese lecture videos.

日本語講義動画を対象に、音声書き起こし・セグメント分割・英語翻訳・字幕ファイル生成までを自動化するパイプラインと、字幕を確認・編集するためのブラウザUIを開発しています。

---

## 概要

講義動画の英語字幕化は以下のステップで構成されます：

```
講義動画 (.mp4)
  → 音声書き起こし & 話者分離 (WhisperX)
  → セグメント分割 & タイムコード割り付け
  → LLMによる英語翻訳 (Gemini)
  → 字幕エディタで確認・編集
  → SRTファイル出力
```

## 字幕仕様

Netflix / BBC スタイルガイドに準拠：

| 項目 | 値 |
|------|-----|
| 1行あたりの最大文字数 | 42文字 |
| 推奨 CPS（Characters Per Second） | 15以下 |
| 出力形式 | SRT |

## リポジトリ構成

| ディレクトリ | 内容 |
|-------------|------|
| `frontend/` | 字幕エディタUI（React + TypeScript + Vite） |
| `backend/` | 翻訳パイプライン実装 |
| `poc/` | 概念実証コード・実験スクリプト |
| `docs/` | 設計ドキュメント |

## 字幕エディタ（frontend）

バックエンドなしで単体動作するブラウザUI。ビルド成果物は `dist/index.html` 1ファイルで配布できます。

**主な機能：**
- 字幕ブロックの確認・編集（テキスト・タイムスタンプ）
- CPS表示とカラーコード（Netflix基準）
- 承認ワークフロー（ブロック単位のロック）
- 用語辞書管理とハイライト表示
- タイムラインビュー・ズーム
- SRT / プロジェクトJSON の入出力
- 日本語 / English / 中文 対応

### 開発環境

```bash
cd frontend
npm install
npm run dev
```

### ビルド

```bash
npm run build
# dist/index.html が生成されます
```

## ステータス

現在リサーチ・実証検証フェーズ。フロントエンドの字幕エディタは動作するモックが完成しており、バックエンドパイプラインとの接続を開発中です。

## License

