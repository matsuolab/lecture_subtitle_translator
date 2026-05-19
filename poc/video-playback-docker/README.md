# Video playback Docker probe

macOS の Tauri/WKWebView そのものは Docker では再現できないため、この PoC は前段の再現性を確認する。

- Mac 用 `asset://localhost/Users/...` URL 生成で `/` が `%2F` にならないこと
- 日本語、空白、URL特殊文字を含むパスを segment 単位で encode できること
- ローカル動画HTTPサーバーが `HEAD` / `GET` / `Range` に正しく応答すること
- Docker内に Chromium と ffmpeg がある場合、実MP4を `<video>` で読み込めること

## 実行

ローカル Node で確認:

```powershell
cd poc/video-playback-docker
node scripts/run-tests.mjs
```

Docker で確認:

```powershell
cd poc/video-playback-docker
docker build -t matsuo-video-playback-probe .
docker run --rm matsuo-video-playback-probe
```

## 境界

このPoCで成功しても、macOS の Tauri `asset://` と WKWebView で再生できることは保証しない。最終確認は Scaleway Mac mini などの実macOS環境で行う。
