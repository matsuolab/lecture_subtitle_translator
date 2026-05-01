import type { SubtitleBlock } from '@/types/subtitle'
import type { EnBlock } from './blockTypes'

export function toSubtitleBlocks(blocks: EnBlock[]): SubtitleBlock[] {
  return blocks.map((block) => ({
    id: block.id,
    startTime: block.start,
    endTime: block.end,
    source: block.enText,
    target: block.jaText,
    cps: block.cps,
    charCount: block.enChars,
    status: block.violation === 'ok' ? 'pending' : 'flagged',
    glossaryTerms: [],
  }))
}
