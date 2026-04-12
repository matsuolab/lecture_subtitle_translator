/**
 * WhisperX プロバイダー。
 *
 * 2つの実装を提供:
 *
 * createDockerWhisperXProvider()
 *   ローカル Docker 実行。`docker run` で ghcr.io/jim60105/whisperx:large-v3-ja を起動。
 *   コンテナは処理後に自動終了（--rm）。HTTP API 不要。
 *
 * createHTTPWhisperXProvider(url, apiKey)
 *   AWS API Gateway 経由の HTTP 呼び出し（R2 実装予定）。
 *   POST {url}/transcribe へ音声送信 → JSON 受信。
 *
 * どちらも WhisperXProvider インターフェースを実装するため、
 * 呼び出し側（transcribeNode）はどちらか意識しない。
 */

import { z } from 'zod'
import type { TranscriptSegment, WordTimestamp } from '../types'

// ---------------------------------------------------------------------------
// Zod スキーマ（出力 JSON 検証）
// ---------------------------------------------------------------------------

const WordSchema = z.object({
  word: z.string(),
  start: z.number().optional(),
  end: z.number().optional(),
  score: z.number().optional(),
})

const SegmentSchema = z.object({
  start: z.number(),
  end: z.number(),
  text: z.string(),
  words: z.array(WordSchema).optional().default([]),
})

const WhisperXOutputSchema = z.object({
  segments: z.array(SegmentSchema),
})

// ---------------------------------------------------------------------------
// プロバイダーインターフェース
// ---------------------------------------------------------------------------

export interface WhisperXProvider {
  transcribe(wavPath: string, language: string): Promise<readonly TranscriptSegment[]>
}

// ---------------------------------------------------------------------------
// ヘルパー: Zod パース → TranscriptSegment[]
// ---------------------------------------------------------------------------

function toTranscriptSegments(parsed: z.infer<typeof WhisperXOutputSchema>): readonly TranscriptSegment[] {
  return parsed.segments.map((seg, i): TranscriptSegment => ({
    id: i + 1,
    start: seg.start,
    end: seg.end,
    text: seg.text.trim(),
    words: seg.words
      .filter(w => w.start !== undefined && w.end !== undefined)
      .map((w): WordTimestamp => ({
        word: w.word,
        start: w.start!,
        end: w.end!,
        confidence: w.score ?? 1.0,
      })),
  }))
}

// ---------------------------------------------------------------------------
// ローカル Docker 実装
// ---------------------------------------------------------------------------

const DEFAULT_IMAGE = 'ghcr.io/jim60105/whisperx:large-v3-ja'

/**
 * ローカル Docker で WhisperX を実行するプロバイダー。
 *
 * 動作原理:
 *   docker run --rm --gpus all
 *     -v "<audio_dir>:/app/input"
 *     -v "<tmp_out_dir>:/app/output"
 *     ghcr.io/jim60105/whisperx:large-v3-ja
 *     -- --output_format json --output_dir /app/output /app/input/<audio.wav>
 *   → コンテナ処理後に自動終了
 *   → <tmp_out_dir>/<basename>.json を読み込んで TranscriptSegment[] に変換
 *
 * 前提: Docker Desktop（GPU対応）がインストール済みであること。
 * large-v3-ja タグは --model / --language が ENTRYPOINT に組み込み済み。
 * language 引数は無視される（タグに言語が固定されているため）。
 */
export function createDockerWhisperXProvider(imageTag = DEFAULT_IMAGE): WhisperXProvider {
  return {
    async transcribe(wavPath: string, _language: string): Promise<readonly TranscriptSegment[]> {
      const { Command } = await import('@tauri-apps/plugin-shell')
      const { tempDir } = await import('@tauri-apps/api/path')
      const { readTextFile, mkdir, remove } = await import('@tauri-apps/plugin-fs')

      // WAV ファイルのディレクトリ・ファイル名を分解
      const lastSep = Math.max(wavPath.lastIndexOf('/'), wavPath.lastIndexOf('\\'))
      const audioDir = wavPath.substring(0, lastSep)
      const audioFilename = wavPath.substring(lastSep + 1)
      const baseName = audioFilename.replace(/\.[^.]+$/, '')

      // 一時出力ディレクトリを作成
      const tmpBase = await tempDir()
      const outputDir = `${tmpBase}whisperx_out_${Date.now()}`
      await mkdir(outputDir, { recursive: true })

      try {
        // Windows パスをスラッシュ区切りに変換（Docker Desktop 対応）
        const dockerAudioDir = audioDir.replace(/\\/g, '/')
        const dockerOutputDir = outputDir.replace(/\\/g, '/')

        const cmd = Command.create('docker', [
          'run', '--rm', '--gpus', 'all',
          '-v', `${dockerAudioDir}:/app/input`,
          '-v', `${dockerOutputDir}:/app/output`,
          imageTag,
          '--',
          '--output_format', 'json',
          '--output_dir', '/app/output',
          `/app/input/${audioFilename}`,
        ])

        const result = await cmd.execute()

        if (result.code !== 0) {
          throw new Error(
            `WhisperX docker failed (exit ${result.code}):\n${result.stderr}`
          )
        }

        // 出力 JSON を読み込んで検証
        const jsonPath = `${outputDir}/${baseName}.json`
        const jsonText = await readTextFile(jsonPath)
        const json: unknown = JSON.parse(jsonText)

        const parsed = WhisperXOutputSchema.safeParse(json)
        if (!parsed.success) {
          throw new Error(`WhisperX output validation failed: ${parsed.error.message}`)
        }

        return toTranscriptSegments(parsed.data)
      } finally {
        await remove(outputDir, { recursive: true }).catch(() => {})
      }
    },
  }
}

// ---------------------------------------------------------------------------
// AWS HTTP 実装（R2 で実装予定）
// ---------------------------------------------------------------------------

/**
 * AWS API Gateway 経由の HTTP WhisperX プロバイダー。
 *
 * エンドポイント仕様:
 *   POST {url}/transcribe
 *   Content-Type: multipart/form-data
 *   Body: file=<WAV binary>, language=<lang>
 *   Response: { segments: WhisperXSegment[] }
 */
export function createHTTPWhisperXProvider(
  endpointUrl: string,
  apiKey: string,
): WhisperXProvider {
  return {
    async transcribe(wavPath: string, language: string): Promise<readonly TranscriptSegment[]> {
      const { readFile } = await import('@tauri-apps/plugin-fs')
      const wavBytes = await readFile(wavPath)

      const formData = new FormData()
      formData.append('file', new Blob([wavBytes], { type: 'audio/wav' }), 'audio.wav')
      formData.append('language', language)

      const headers: Record<string, string> = {}
      if (apiKey) headers['x-api-key'] = apiKey

      const response = await fetch(`${endpointUrl}/transcribe`, {
        method: 'POST',
        headers,
        body: formData,
      })

      if (!response.ok) {
        const body = await response.text().catch(() => '')
        throw new Error(`WhisperX HTTP ${response.status}: ${body}`)
      }

      const json: unknown = await response.json()
      const parsed = WhisperXOutputSchema.safeParse(json)

      if (!parsed.success) {
        throw new Error(`WhisperX response validation failed: ${parsed.error.message}`)
      }

      return toTranscriptSegments(parsed.data)
    },
  }
}
