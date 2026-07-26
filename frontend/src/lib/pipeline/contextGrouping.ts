import type { AdminSettings } from '@/types/adminSettings'
import type { ContextGroupRole, JaBlock } from './blockTypes'
import { detectIncompleteEnds } from './detectIncompleteEnds'
import { loadLanguageProfileConfig, type LanguageScript } from './languageProfileConfig'
import { joinSubtitleParts } from './textUtils'

export interface ContextGroupingResult {
  blocks: JaBlock[]
  detectionCount: number
  detectionSuccess: number
  detectionFailed: number
  groupCount: number
  groupedBlockCount: number
  abortReason?: string
}

export type OnWarning = (nodeId: string, message: string) => void

interface GroupConfig {
  maxGapSec: number
  maxDurationSec: number
  maxTranscriptChars: number
}

interface GroupDraft {
  id: string
  members: JaBlock[]
  reason: string
}

function gapSec(left: JaBlock, right: JaBlock): number {
  return right.start - left.end
}

function canShareContextGroup(group: JaBlock[], next: JaBlock, cfg: GroupConfig): boolean {
  if (group.length === 0) return false
  const first = group[0]
  const last = group[group.length - 1]
  const gap = gapSec(last, next)
  if (gap < 0 || gap > cfg.maxGapSec) return false
  if (next.end - first.start > cfg.maxDurationSec) return false
  const chars = group.reduce((sum, block) => sum + block.jaChars, 0) + next.jaChars
  return chars <= cfg.maxTranscriptChars
}

function roleFor(index: number, size: number): ContextGroupRole {
  if (size <= 1) return 'single'
  if (index === 0) return 'lead'
  if (index === size - 1) return 'tail'
  return 'middle'
}

function sourceIdsFor(block: JaBlock): number[] {
  return block.contextGroupSourceIds && block.contextGroupSourceIds.length > 0
    ? block.contextGroupSourceIds
    : [block.id]
}

function annotateGroup(group: GroupDraft, transcriptScript: LanguageScript = 'latin'): JaBlock[] {
  const groupText = joinSubtitleParts(group.members.map(block => block.jaText), transcriptScript)
  const sourceIds = [...new Set(group.members.flatMap(sourceIdsFor))]
  return group.members.map((block, index) => ({
    ...block,
    contextGroupId: group.id,
    contextGroupIndex: index,
    contextGroupSize: group.members.length,
    contextGroupRole: roleFor(index, group.members.length),
    contextGroupReason: group.reason,
    contextGroupText: groupText,
    contextGroupSourceIds: sourceIds,
  }))
}

export function assignContextGroupsFromFlags(
  blocks: JaBlock[],
  incompleteFlags: boolean[],
  settings: Pick<AdminSettings,
    'pipelineMergeContinuationMaxGapSec' |
    'pipelineMergeContinuationMaxDurationSec' |
    'pipelineMergeContinuationMaxTranscriptChars'
  >,
  transcriptScript: LanguageScript = 'latin',
): JaBlock[] {
  const cfg: GroupConfig = {
    maxGapSec: settings.pipelineMergeContinuationMaxGapSec,
    maxDurationSec: settings.pipelineMergeContinuationMaxDurationSec,
    maxTranscriptChars: settings.pipelineMergeContinuationMaxTranscriptChars,
  }
  const grouped: JaBlock[] = []
  let index = 0

  while (index < blocks.length) {
    const first = {
      ...blocks[index],
      endsIncomplete: incompleteFlags[index] ?? false,
    }
    const members: JaBlock[] = [first]
    let cursor = index
    while (
      cursor < blocks.length - 1 &&
      (incompleteFlags[cursor] ?? false) &&
      canShareContextGroup(members, blocks[cursor + 1], cfg)
    ) {
      cursor += 1
      members.push({
        ...blocks[cursor],
        endsIncomplete: incompleteFlags[cursor] ?? false,
      })
    }

    const id = members.length > 1
      ? `cg-${members[0].id}-${members[members.length - 1].id}`
      : `cg-${members[0].id}`
    const reason = members.length > 1
      ? 'incomplete_end_context_group'
      : 'single_cue_context_group'
    grouped.push(...annotateGroup({ id, members, reason }, transcriptScript))
    index = cursor + 1
  }

  return grouped
}

export function reindexContextGroups(blocks: JaBlock[], transcriptScript: LanguageScript = 'latin'): JaBlock[] {
  const result: JaBlock[] = []
  let index = 0
  while (index < blocks.length) {
    const first = blocks[index]
    const id = first.contextGroupId ?? `cg-${first.id}`
    const members: JaBlock[] = []
    let cursor = index
    while (cursor < blocks.length && (blocks[cursor].contextGroupId ?? `cg-${blocks[cursor].id}`) === id) {
      members.push(blocks[cursor])
      cursor += 1
    }
    result.push(...annotateGroup({
      id,
      members,
      reason: first.contextGroupReason ?? (members.length > 1 ? 'context_group_reindexed' : 'single_cue_context_group'),
    }, transcriptScript))
    index = cursor
  }
  return result
}

export async function contextGroupCueBlocks(
  blocks: JaBlock[],
  settings: AdminSettings,
  onWarning?: OnWarning,
): Promise<ContextGroupingResult> {
  if (blocks.length === 0) {
    return { blocks: [], detectionCount: 0, detectionSuccess: 0, detectionFailed: 0, groupCount: 0, groupedBlockCount: 0 }
  }

  let flags = new Array<boolean>(blocks.length).fill(false)
  let detectionCount = 0
  let detectionSuccess = 0
  let detectionFailed = 0
  let abortReason: string | undefined

  if (settings.pipelineMergeContinuationEnabled) {
    const detection = await detectIncompleteEnds(blocks.map(b => b.jaText), settings)
    flags = detection.flags
    detectionCount = detection.flags.length
    detectionSuccess = detection.success
    detectionFailed = detection.failed
    abortReason = detection.abortReason
    if (detection.abortReason) {
      onWarning?.(
        'contextGroupCueBlocks',
        `detection aborted: ${detection.abortReason} (skipped ${detection.failed} of ${blocks.length}; singleton groups will be used where unknown)`,
      )
    } else if (detection.failed > 0) {
      onWarning?.(
        'contextGroupCueBlocks',
        `detection partial failure: ${detection.failed} of ${blocks.length} blocks fell back to singleton context groups`,
      )
    }
  }

  const grouped = assignContextGroupsFromFlags(
    blocks,
    flags,
    settings,
    loadLanguageProfileConfig(settings).transcript.script,
  )
  const ids = new Set(grouped.map(block => block.contextGroupId ?? `cg-${block.id}`))
  const groupedBlockCount = grouped.filter(block => (block.contextGroupSize ?? 1) > 1).length
  return {
    blocks: grouped,
    detectionCount,
    detectionSuccess,
    detectionFailed,
    groupCount: ids.size,
    groupedBlockCount,
    abortReason,
  }
}
