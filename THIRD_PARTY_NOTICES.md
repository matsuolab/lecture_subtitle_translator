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
