# Third-Party Notices

本アプリ (`subtitle-editor`) は、以下の第三者ソフトウェアを同梱・利用しています。

---

## FFmpeg

本アプリは、動画から音声を抽出する処理に **FFmpeg** を独立した実行ファイル（sidecar / サブプロセス）として同梱しています。

- **ライセンス**: GNU Lesser General Public License, version 3 (LGPL-3.0) 以降
- **公式サイト**: https://ffmpeg.org/
- **ソースコード**: https://ffmpeg.org/download.html

### 配布バイナリの取得元

リリースビルドに同梱している FFmpeg バイナリは、以下から取得した LGPL ビルドです（GPL コーデック `libx264` / `libx265` 等は無効化されています）。

| OS / Arch | 取得元 |
|---|---|
| Windows x64 | https://github.com/BtbN/FFmpeg-Builds/releases (`ffmpeg-master-latest-win64-lgpl`) |
| Linux x64 | https://github.com/BtbN/FFmpeg-Builds/releases (`ffmpeg-master-latest-linux64-lgpl`) |
| macOS arm64 | https://ffmpeg.martin-riedl.de/ (LGPL static build) |

### 利用形態

本アプリは FFmpeg を **静的・動的にリンクしておらず**、サブプロセスとして起動して標準入出力経由で利用しています。これにより本アプリ自体のソース公開義務は発生しませんが、LGPL の告知義務に従い、本ファイルにより同梱の事実を明示します。

### FFmpeg のライセンス本文

LGPL 3.0 のライセンス全文は以下から参照できます。

https://www.gnu.org/licenses/lgpl-3.0.html

### FFmpeg バイナリの差し替え

ユーザーは、配布物に含まれる FFmpeg 実行ファイル（Windows: `ffmpeg.exe`、macOS/Linux: バンドル内の `ffmpeg`）を、互換性のある別の LGPL ビルドへ差し替えることができます。本アプリは、起動時に同階層の `ffmpeg`(.exe) を呼び出します。

---

## 字幕スペル校正

本アプリは、英語字幕のスペル校正と重複語検出のため、以下の第三者ソフトウェアおよび辞書データを利用しています。

### JavaScript / NPM 依存

| パッケージ | 用途 | ライセンス |
|---|---|---|
| `retext-spell` | スペルチェック連携 | MIT |
| `nspell` | Hunspell 辞書の実行エンジン | MIT |
| `retext-english` | 英語テキスト解析 | MIT |
| `retext-repeated-words` | 重複語検出 | MIT |
| `dictionary-en` | 英語 Hunspell 辞書パッケージ | MIT AND BSD |

正確なバージョンと依存関係は `frontend/package-lock.json` を参照してください。

### 同梱英語 Hunspell 辞書

本アプリは、英語字幕の初期スペルチェック用に `en.aff` / `en.dic` を同梱しています。

- **配置**: `frontend/src/lib/pipeline/spellCheck/dictionaries/en.aff`, `frontend/src/lib/pipeline/spellCheck/dictionaries/en.dic`
- **告知ファイル**: `frontend/src/lib/pipeline/spellCheck/dictionaries/en.LICENSE`
- **由来**: SCOWL / Ispell 由来の英語 Hunspell 辞書
- **版**: `en_US Hunspell Dictionary Version 2020.12.07`
- **参照元**: http://wordlist.sourceforge.net

英語以外の Hunspell 辞書は、言語ごとにライセンスが異なるため、本アプリの配布物には同梱していません。利用者が一般用語辞書インポート機能で `.aff` / `.dic` を追加する場合は、各辞書のライセンスを利用者側で確認してください。
