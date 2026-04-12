/**
 * extractAudio ノード。
 * 入力動画ファイルから ffmpeg sidecar で 16kHz モノラル WAV を抽出する。
 * 出力は一時ファイルパス（呼び出し元が削除する責任を持つ）。
 */

import type { NodeContract, NodeContext } from '../nodeContract'
import type { FFmpegProvider } from '../providers/ffmpegProvider'

export interface ExtractAudioInput {
  readonly videoPath: string
  readonly ffmpeg: FFmpegProvider
}

export interface ExtractAudioOutput {
  readonly wavPath: string  // 一時 WAV ファイルのパス
}

export const extractAudioNode: NodeContract<ExtractAudioInput, ExtractAudioOutput> = {
  id: 'extractAudio',
  schemaVersion: '1.0',

  async run(input: ExtractAudioInput, ctx: NodeContext): Promise<ExtractAudioOutput> {
    ctx.onProgress('extractAudio: WAV 抽出中...')

    // タイムスタンプベースの一時ファイル名（衝突回避）
    const tmpName = `subtitle_${Date.now()}.wav`
    const { tempDir } = await import('@tauri-apps/api/path')
    const wavPath = `${await tempDir()}${tmpName}`

    await input.ffmpeg.extractWav(input.videoPath, wavPath)

    return { wavPath }
  },
}
