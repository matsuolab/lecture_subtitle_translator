/**
 * transcribe ノード。
 * WAV ファイルを WhisperX プロバイダーに渡し、
 * 単語レベルタイムスタンプ付きの TranscriptSegment[] を返す。
 *
 * ローカル Docker 実行: createDockerWhisperXProvider()
 * AWS HTTP 実行:        createHTTPWhisperXProvider(url, apiKey)
 */

import type { NodeContract, NodeContext } from '../nodeContract'
import type { TranscriptSegment } from '../types'
import type { WhisperXProvider } from '../providers/whisperxProvider'

export interface TranscribeInput {
  readonly wavPath: string
  readonly whisperxProvider: WhisperXProvider
}

export const transcribeNode: NodeContract<TranscribeInput, readonly TranscriptSegment[]> = {
  id: 'transcribe',
  schemaVersion: '1.0',

  async run(
    input: TranscribeInput,
    ctx: NodeContext,
  ): Promise<readonly TranscriptSegment[]> {
    ctx.onProgress('transcribe: WhisperX 書き起こし中...')

    const { whisperxLanguage } = ctx.config
    const segments = await input.whisperxProvider.transcribe(input.wavPath, whisperxLanguage)

    ctx.onProgress(`transcribe: ${segments.length} セグメント取得完了`)
    return segments
  },
}
