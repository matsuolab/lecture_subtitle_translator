/**
 * ffmpeg サイドカープロバイダー。
 * Tauri の `tauri-plugin-shell` 経由で同梱 ffmpeg バイナリを起動する。
 *
 * バイナリ配置: src-tauri/binaries/ffmpeg-<target-triple>[.exe]
 * tauri.conf.json: bundle.externalBin = ["binaries/ffmpeg"]
 */

export interface FFmpegProvider {
  /** 動画ファイルから 16kHz モノラル WAV を抽出する */
  extractWav(videoPath: string, outputWavPath: string): Promise<void>
}

/**
 * Tauri shell sidecar 経由の ffmpeg プロバイダー実装。
 * Tauri 環境（デスクトップアプリ）専用。
 */
export function createTauriFFmpegProvider(): FFmpegProvider {
  return {
    async extractWav(videoPath: string, outputWavPath: string): Promise<void> {
      const { Command } = await import('@tauri-apps/plugin-shell')

      const cmd = Command.sidecar('binaries/ffmpeg', [
        '-y',              // 上書き確認なし
        '-i', videoPath,
        '-vn',             // 映像ストリーム除去
        '-acodec', 'pcm_s16le',
        '-ar', '16000',    // WhisperX 推奨サンプリングレート
        '-ac', '1',        // モノラル
        outputWavPath,
      ])

      const output = await cmd.execute()

      if (output.code !== 0) {
        throw new Error(
          `ffmpeg failed (exit ${output.code}): ${output.stderr}`
        )
      }
    },
  }
}
