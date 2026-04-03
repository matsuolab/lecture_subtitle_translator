# Subtitle Editor (Frontend)

React + TypeScript + Vite + Tauri v2 で実装した字幕編集アプリです。

## 主な機能

- SRT 読み込み・編集・書き出し
- 字幕ブロックの承認 / 要確認 / 分割 / 合体
- CPS（文字/秒）と1行文字数（42文字目安）の可視化
- 用語集（CSV / XLSX）インポート、用語ハイライト、用語漏れ・タイポ候補表示
- 動画・SRT/JSON・用語集のドラッグ＆ドロップ入力

## 実行方法（Web）

```bash
npm install
npm run dev
```

## 実行方法（Desktop / Tauri）

```bash
npm run tauri:dev
```

## ビルド（EXE）

```bash
npm run tauri:build
```

出力先:

- `src-tauri/target/release/subtitle-editor.exe`

## 使い方メモ

- 動画ファイル: 左の動画領域へドロップ
- SRT / プロジェクトJSON: 右パネル（字幕タブ）へドロップ
- 用語集CSV/XLSX: 用語辞書タブへドロップ（または「インポート」ボタン）
- 用語集読み込み中はボタンが `読み込み中...` 表示になり、重複操作を防止

## 開発メモ

- Tauriビルド版でローカル動画を再生するため、`src-tauri/tauri.conf.json` で `assetProtocol` を有効化
- Windows EXE でHTML5 D&Dが取りこぼされるケースに備えて、`onDragDropEvent` のフォールバックを実装
- 用語集インポートは `GlossaryContext.importEntries` で map インデックス化し、大量エントリ時の更新コストを削減
