import type { JaBlock, PipelineThresholds } from './blockTypes'

/**
 * 短い cue を隣接 cue と結合する際に「無音吸収して良い」最大 gap（秒）。
 * gap がこれを超える場合、短い cue でも独立した発話（つぶやき・短い言い直し等）
 * とみなして結合しない。結合してしまうと結合後 cue が無音区間を覆ってしまい、
 * 無音時間中も字幕が表示され続ける問題が出るため。
 */
const SHORT_MERGE_MAX_GAP_SEC = 0.8

function mergePair(left: JaBlock, right: JaBlock): JaBlock {
  const sameContextGroup = left.contextGroupId !== undefined && left.contextGroupId === right.contextGroupId
  const contextGroupSourceIds = [
    ...new Set([
      ...(left.contextGroupSourceIds ?? [left.id]),
      ...(right.contextGroupSourceIds ?? [right.id]),
    ]),
  ]
  const jaText = `${left.jaText} ${right.jaText}`.trim()
  return {
    id: left.id,
    start: left.start,
    end: right.end,
    jaText,
    jaChars: left.jaChars + right.jaChars,
    alignConf: 'merged',
    words: [...(left.words ?? []), ...(right.words ?? [])],
    merged: true,
    contextGroupId: sameContextGroup
      ? left.contextGroupId
      : `cg-short-${contextGroupSourceIds.join('-')}`,
    contextGroupReason: sameContextGroup
      ? left.contextGroupReason
      : 'short_duration_merge_cross_context_group',
    contextGroupText: sameContextGroup
      ? left.contextGroupText
      : jaText,
    contextGroupSourceIds,
    endsIncomplete: left.endsIncomplete || right.endsIncomplete,
  }
}

/**
 * 短い cue（duration < shortDurationSec）を隣接 cue と結合する。
 *
 * 結合戦略:
 *   1. 前 gap と次 gap を比較し、小さい方に結合する
 *   2. 両方とも SHORT_MERGE_MAX_GAP_SEC を超える場合は独立発話として残す
 *   3. 結合後の cue がまだ短い場合は同じロジックで再評価
 *
 * このガードが無いと、短い cue + 長い無音 + 次 cue を結合してしまい、
 * 結合後 cue が無音区間を覆って「無音中に字幕が表示される」問題になる。
 */
export function mergeShort(blocks: JaBlock[], thresholds: PipelineThresholds): JaBlock[] {
  const result: JaBlock[] = [...blocks]
  let i = 0
  while (i < result.length) {
    const cur = result[i]
    const duration = cur.end - cur.start
    if (duration >= thresholds.shortDurationSec) {
      i += 1
      continue
    }

    const prev = i > 0 ? result[i - 1] : undefined
    const next = i + 1 < result.length ? result[i + 1] : undefined
    const gapPrev = prev ? cur.start - prev.end : Number.POSITIVE_INFINITY
    const gapNext = next ? next.start - cur.end : Number.POSITIVE_INFINITY

    const canMergePrev = prev !== undefined && gapPrev <= SHORT_MERGE_MAX_GAP_SEC
    const canMergeNext = next !== undefined && gapNext <= SHORT_MERGE_MAX_GAP_SEC

    if (!canMergePrev && !canMergeNext) {
      // 前後どちらも無音が大きい → 独立した発話として残す
      i += 1
      continue
    }

    // 小さい gap 側に寄せる（同点なら前優先）
    const mergeWithPrev = canMergePrev && (!canMergeNext || gapPrev <= gapNext)
    if (mergeWithPrev && prev) {
      result.splice(i - 1, 2, mergePair(prev, cur))
      // 結合後 cue は result[i-1] に入る。再評価のため i を戻す。
      i = i - 1
      continue
    }

    if (next) {
      result.splice(i, 2, mergePair(cur, next))
      // 結合後 cue は result[i] に入る。再評価のため i は据え置き。
      continue
    }

    i += 1
  }
  return result
}
