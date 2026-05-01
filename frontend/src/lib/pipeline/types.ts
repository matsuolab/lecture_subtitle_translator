export interface TranscriptSegment {
  id: number
  start: number
  end: number
  text: string
  words?: WordTimestamp[]
}

export interface WordTimestamp {
  word: string
  start: number
  end: number
  score?: number
}

export interface CorrectedSegment extends TranscriptSegment {
  ja_corrected: string
  correction_distance: number
  correction_flagged: boolean
}

export interface TranslatedSegment extends CorrectedSegment {
  en: string
  translation_flagged: boolean
  translation_provider: string
}

export interface AWSTranscriptResult {
  transcript_segments: TranscriptSegment[]
  words?: WordTimestamp[]
  metadata?: Record<string, unknown>
}
