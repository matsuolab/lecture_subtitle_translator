import type { JaBlock, PipelineThresholds } from './blockTypes'

/**
 * 短い cue を隣接 cue と結合する際に「無音吸収して良い」最大 gap（秒）。
 * gap がこれを超える場合、短い cue でも独立した発話（つぶやき・短い言い直し等）
 * とみなして結合しない。結合してしまうと結合後 cue が無音区間を覆ってしまい、
 * 無音時間中も字幕が表示され続ける問題が出るため。
 */
const SHORT_MERGE_MAX_GAP_SEC = 0.8

/**
 * 結合後 cue の `jaChars` 上限。これを超える結合は行わない。
 *
 * 実測値が根拠: 117分講義の実データでパイプライン各段の最大文字数を計測したところ、
 * `semanticSplitJa` 直後の最大が 155 文字、`correctJa` 直後の最大が 221 文字だった
 * （分割・補正は正常に機能している）。通常の cue はこの範囲に収まるため、
 * 結合後に 200 文字を超えるケースは「短い cue の結合」ではなく暴走とみなせる。
 * この上限が無かったため、0 秒キューの連鎖結合で 1 ブロック 1,175 文字（最終的に
 * 2,322 文字、CPS 491.4、補正 LLM リクエスト 43 万トークン）という事故が起きた。
 */
const MAX_MERGED_JA_CHARS = 200

/**
 * 1つの結果 cue が取り込める元キュー数の上限。
 *
 * 上の duration 上限・jaChars 上限をすり抜ける経路（例: 極端に短い cue が
 * 大量に連続し、1回あたりの jaChars 増分も duration 増分も小さいまま
 * 結合が繰り返されるケース）に対する最後の歯止め。`mergePair` が集約する
 * `contextGroupSourceIds`（結合元キューの id 集合）の要素数で判定する。
 */
const MAX_MERGE_CHAIN = 4

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
 * 結合候補 cue が上限（duration / jaChars / 結合回数）を超えていないかを判定する。
 *
 * `shortDurationSec`（短すぎる）と `mergedLongDurationSec`（長すぎる）は同じ
 * `PipelineThresholds` に同居しているにもかかわらず、従来の mergeShort は前者しか
 * 参照しておらず、後者を見ずに結合を続けられる設計の欠落があった。特に duration が
 * 0 秒（またはごく小さい）の cue が連続する場合、いくら結合しても duration が
 * 伸びないため、duration 側の停止条件だけでは無限に結合が連鎖してしまう。
 * jaChars 上限・結合回数上限はこの欠落を塞ぐための歯止めであり、duration が
 * 伸びない異常系でも必ずどこかの条件で結合を止められるようにしている。
 */
function exceedsMergeLimits(candidate: JaBlock, thresholds: PipelineThresholds): boolean {
  const duration = candidate.end - candidate.start
  if (duration > thresholds.mergedLongDurationSec) return true
  if (candidate.jaChars > MAX_MERGED_JA_CHARS) return true
  const chainLength = candidate.contextGroupSourceIds?.length ?? 1
  if (chainLength > MAX_MERGE_CHAIN) return true
  return false
}

/**
 * 短い cue（duration < shortDurationSec）を隣接 cue と結合する。
 *
 * 結合戦略:
 *   1. 前 gap と次 gap を比較し、小さい方に結合する
 *   2. 両方とも SHORT_MERGE_MAX_GAP_SEC を超える場合は独立発話として残す
 *   3. 結合後の cue が `mergedLongDurationSec` / `MAX_MERGED_JA_CHARS` /
 *      `MAX_MERGE_CHAIN` のいずれかを超える場合はその方向への結合を諦める
 *   4. 結合後の cue がまだ短く、かつ上記の上限内であれば同じロジックで再評価
 *
 * gap のガードが無いと、短い cue + 長い無音 + 次 cue を結合してしまい、
 * 結合後 cue が無音区間を覆って「無音中に字幕が表示される」問題になる。
 * duration/jaChars/結合回数のガードが無いと、duration 0 秒付近の cue が
 * 大量に連続するケースで結合が歯止め無く連鎖し、1 ブロックが千文字を超える
 * 暴走（実測: 1,175→2,322文字、CPS 491.4、補正 LLM 43万トークンで失敗）が起きる。
 *
 * 両方向とも結合不可（gap が大きい、または上限超過）の場合、その cue は
 * 独立キューとして残し、必ず i を前進させる。結合を実行した場合は配列長が
 * 減るため、いずれの分岐でも「前進」か「縮小」が起きることが保証され、
 * duration が伸びない異常入力でも無限ループにはならない。
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

    const gapOkPrev = prev !== undefined && gapPrev <= SHORT_MERGE_MAX_GAP_SEC
    const gapOkNext = next !== undefined && gapNext <= SHORT_MERGE_MAX_GAP_SEC

    // gap 条件を満たす場合のみ結合候補を構築し、上限チェックにかける。
    // （満たさない側は候補を作るまでもなく不可なので計算を省く）
    const prevCandidate = gapOkPrev && prev ? mergePair(prev, cur) : undefined
    const nextCandidate = gapOkNext && next ? mergePair(cur, next) : undefined

    const canMergePrev = prevCandidate !== undefined && !exceedsMergeLimits(prevCandidate, thresholds)
    const canMergeNext = nextCandidate !== undefined && !exceedsMergeLimits(nextCandidate, thresholds)

    if (!canMergePrev && !canMergeNext) {
      // 前後どちらも無音が大きい、または結合すると上限を超える
      // → これ以上結合できない独立した cue として残す
      i += 1
      continue
    }

    // 小さい gap 側に寄せる（同点なら前優先）
    const mergeWithPrev = canMergePrev && (!canMergeNext || gapPrev <= gapNext)
    if (mergeWithPrev && prevCandidate) {
      result.splice(i - 1, 2, prevCandidate)
      // 結合後 cue は result[i-1] に入る。再評価のため i を戻す。
      i = i - 1
      continue
    }

    if (nextCandidate) {
      result.splice(i, 2, nextCandidate)
      // 結合後 cue は result[i] に入る。再評価のため i は据え置き。
      continue
    }

    i += 1
  }
  return result
}
