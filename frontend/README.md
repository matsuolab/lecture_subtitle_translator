# Subtitle Editor (Frontend)

React + TypeScript + Vite + Tauri v2 で実装した字幕編集アプリです。

> この README の操作手順・設定説明は `subtitle-editor v0.4.4` 準拠です。

## 主な機能

- SRT 読み込み・編集・書き出し
- 字幕ブロックの承認 / 要確認 / 分割 / 合体
- CPS（文字/秒）と1行文字数の可視化（管理者設定に連動、既定は 16.9 CPS / 80文字）
- 自動処理ログ（分割・短縮・前後結合・表示時間調整の適用/見送り理由）
- 用語集（CSV / XLSX）インポート、用語ハイライト、用語漏れ・タイポ候補表示
- 動画・SRT/JSON・用語集のドラッグ＆ドロップ入力
- レポートタブ（実行履歴・品質指標・推定コスト・モジュール別処理ログの確認）

## 利用者向け: リリース版の入手

GitHub Releases から OS に合ったファイルをダウンロードします。

| OS | ファイル | 起動方法 |
|---|---|---|
| Windows | `subtitle-editor-windows-x64.exe` | そのまま実行 |
| macOS Apple Silicon | `subtitle-editor-macos-arm64.app.zip` | zip を展開して `.app` を開く |
| Linux x64 | `subtitle-editor-linux-x64.AppImage` | 実行権限を付けて起動 |

初回利用時は、設定タブで実行先と接続先AIプロバイダを設定します。リモート実行する場合は `Service URL` と `Service Auth Token` を入力し、接続テストで OK が表示されることを確認してから実行します。

既定モデルは `gpt-5.4-mini`、文脈統合モデルは `gpt-5.5` です。

## 実行方法（Web）

```bash
npm install
npm run dev
```

## 実行方法（Desktop / Tauri）

```bash
npm run tauri:dev
```

## ビルド（Portable）

```bash
npm run tauri:build
```

出力先:

- Windows: `src-tauri/target/release/subtitle-editor.exe`
- macOS app bundle: `src-tauri/target/release/bundle/macos/*.app`
- Linux AppImage: `src-tauri/target/release/bundle/appimage/*.AppImage`

## 使い方メモ

- 動画ファイル: 左の動画領域へドロップ
- SRT / プロジェクトJSON: 右パネル（字幕タブ）へドロップ
- 用語集CSV/XLSX: 用語辞書タブへドロップ（または「インポート」ボタン）
- 用語集読み込み中はボタンが `読み込み中...` 表示になり、重複操作を防止
- 動画ドロップ時は Pipelineステータスに進捗（文字起こし→補正→翻訳→字幕化）を表示
- 字幕ブロックの `自動処理 n` から、そのブロックで試した自動処理の内容を確認
- レポートタブの `処理ログ` から、エンジニア向けの詳細ログを確認

## 開発メモ

- Tauriビルド版でローカル動画を再生するため、`src-tauri/tauri.conf.json` で `assetProtocol` を有効化
- Linux AppImage でも動画再生しやすくするため、`bundle.linux.appimage.bundleMediaFramework` を有効化
- Windows EXE でHTML5 D&Dが取りこぼされるケースに備えて、`onDragDropEvent` のフォールバックを実装
- 用語集インポートは `GlossaryContext.importEntries` で map インデックス化し、大量エントリ時の更新コストを削減
