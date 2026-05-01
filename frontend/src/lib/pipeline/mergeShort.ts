import type { JaBlock, PipelineThresholds } from './blockTypes'

function mergePair(left: JaBlock, right: JaBlock): JaBlock {
  return {
    id: left.id,
    start: left.start,
    end: right.end,
    jaText: `${left.jaText} ${right.jaText}`.trim(),
    jaChars: left.jaChars + right.jaChars,
    alignConf: 'merged',
    words: [...(left.words ?? []), ...(right.words ?? [])],
    merged: true,
  }
}

export function mergeShort(blocks: JaBlock[], thresholds: PipelineThresholds): JaBlock[] {
  const merged: JaBlock[] = []

  for (const block of blocks) {
    const previous = merged.at(-1)
    if (!previous) {
      merged.push(block)
      continue
    }

    const duration = previous.end - previous.start
    if (duration < thresholds.shortDurationSec) {
      merged[merged.length - 1] = mergePair(previous, block)
      continue
    }

    merged.push(block)
  }

  if (merged.length >= 2) {
    const last = merged.at(-1)
    if (last && last.end - last.start < thresholds.shortDurationSec) {
      const beforeLast = merged[merged.length - 2]
      merged.splice(merged.length - 2, 2, mergePair(beforeLast, last))
    }
  }

  return merged
}
