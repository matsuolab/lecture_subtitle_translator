# Sprint Addendum: 実書き起こし経路の本番化（2026-04-04）

## 目的

- 動画ドロップ時に `extract_audio -> transcribe(WhisperX)` を必須経路として実行する。
- 書き起こしが実行できない場合はスタブへ黙ってフォールバックせず、そこで失敗させる。
- レポート上で「実抽出・実書き起こしが行われたか」を追跡できる状態にする。

## 方針

1. 入力は `source_media_path` として受け取る。
2. `extract_audio` ノードを追加する。
   - 動画 (`.mp4/.mov/.mkv/.webm`) は `ffmpeg` で `.wav` に変換する。
   - 音声 (`.mp3/.wav/.m4a/.flac`) はそのまま `audio_path` として通す。
3. `transcribe` ノードは `audio_path` のみをWhisperXへ渡す。
4. `execution_mode=production` では以下を必須にする。
   - `ffmpeg` による音声抽出成功
   - 外部WhisperX実行成功
   - SRT生成成功
   - セグメント1件以上
5. `execution_mode=dev` のときのみ、明示的にスタブフォールバックを許可する。
6. 監査レポートに `extract_audio` / `transcribe` の provider, model, metrics を残す。

## 本スプリントの受け入れ条件

- 動画パス投入時に `extract_audio` が実行され、`audio_path` が生成される。
- `transcribe` は動画パスを直接処理せず、抽出済み音声のみを処理する。
- WhisperX失敗時は `pipeline failed` になる（production時）。
- `backend/tests` が通る。
- `frontend` build が通る。
