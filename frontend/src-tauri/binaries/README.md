# ffmpeg sidecar binaries

このディレクトリには Tauri sidecar として同梱する `ffmpeg` 実行ファイルを配置します。
バイナリ本体は git 管理対象外（`.gitignore`）で、CI の `release.yml` がリリースビルド時に
自動取得します。ローカルビルドでは開発者が手動配置する必要があります。

## 命名規則

Tauri の externalBin 仕様に従い、ターゲットトリプル付きで配置：

| OS / Arch | ファイル名 |
| --- | --- |
| Windows x64 | `ffmpeg-x86_64-pc-windows-msvc.exe` |
| macOS Apple Silicon | `ffmpeg-aarch64-apple-darwin` |
| Linux x64 (glibc) | `ffmpeg-x86_64-unknown-linux-gnu` |

`tauri.conf.json` の `bundle.externalBin: ["binaries/ffmpeg"]` 設定により、
ビルド時に各ターゲット用ファイルが自動的にバンドルへ取り込まれます。

## 取得元（LGPL ビルド）

ライセンス上の余地を残さないため LGPL ビルドを使用します。

| OS | 取得元 | ダウンロード |
| --- | --- | --- |
| Windows x64 | BtbN/FFmpeg-Builds | https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-lgpl.zip |
| Linux x64 | BtbN/FFmpeg-Builds | https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-lgpl.tar.xz |
| macOS arm64 | martin-riedl.de | https://ffmpeg.martin-riedl.de/redirect/latest/macos/arm64/release/ffmpeg.zip |

ライセンス確認: いずれも LGPL-2.1+ ビルド。本アプリは sidecar（サブプロセス実行）方式で
ffmpeg を起動するため、リンクではなく集積扱いとなり、本体ライセンスへの影響はありません。

## ローカル手動配置（開発用）

自分の OS 用バイナリだけ取得・配置すれば、ローカルで `npm run tauri build` が通ります。

### Windows
```powershell
$out = "frontend/src-tauri/binaries"
Invoke-WebRequest -Uri "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-lgpl.zip" -OutFile "$env:TEMP/ffmpeg.zip"
Expand-Archive "$env:TEMP/ffmpeg.zip" -DestinationPath "$env:TEMP/ffmpeg-extract" -Force
Copy-Item "$env:TEMP/ffmpeg-extract/ffmpeg-master-latest-win64-lgpl/bin/ffmpeg.exe" "$out/ffmpeg-x86_64-pc-windows-msvc.exe"
```

### Linux
```bash
out=frontend/src-tauri/binaries
curl -L -o /tmp/ffmpeg.tar.xz https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-lgpl.tar.xz
mkdir -p /tmp/ffmpeg-extract && tar -xJf /tmp/ffmpeg.tar.xz -C /tmp/ffmpeg-extract --strip-components=1
cp /tmp/ffmpeg-extract/bin/ffmpeg "$out/ffmpeg-x86_64-unknown-linux-gnu"
chmod +x "$out/ffmpeg-x86_64-unknown-linux-gnu"
```
