import type { EnBlock, JaBlock } from './blockTypes'

/**
 * gap_too_short 違反（隣接 cue 間の gap が必要最低量未満）の検出結果。
 */
export interface GapViolation {
  /** 先行 cue */
  blockAId: number
  /** 後続 cue */
  blockBId: number
  /** 実際の gap（秒） */
  currentGapSec: number
  /** 必要な最低 gap（秒） */
  requiredGapSec: number
  /** 不足量（秒） */
  deficitSec: number
  /** 先行 cue の終端時刻 */
  blockAEnd: number
  /** 後続 cue の開始時刻 */
  blockBStart: number
}

/**
 * tighten_timing の修正ログ。
 */
export interface TightenLogEntry {
  blockAId: number
  blockBId: number
  /** 修正前 gap（秒） */
  beforeGapSec: number
  /** 修正後 gap（秒） */
  afterGapSec: number
  /** A.end を前倒しした量（秒） */
  aShrinkSec: number
  /** B.start を後ろ倒しした量（秒） */
  bShrinkSec: number
  beforeAEnd: number
  afterAEnd: number
  beforeBStart: number
  afterBStart: number
  /**
   * - 'fully_fixed': gap 制約を完全に満たすまで修正できた
   * - 'partially_fixed': 一部だけ修正（min_duration の壁に当たった）
   * - 'unable_to_fix': min_duration の壁で全く修正できなかった
   */
  status: 'fully_fixed' | 'partially_fixed' | 'unable_to_fix'
  reason?: string
}

export interface TightenResult {
  totalViolations: number
  fullyFixed: number
  partiallyFixed: number
  unableToFix: number
  blocks: EnBlock[]
  entries: TightenLogEntry[]
}

/**
 * 隣接 cue 間の gap 違反を検出する（決定的）。
 *
 * gap = B.start - A.end が minGapSec 未満なら違反。
 * 順序が逆転している（A.end > B.start, 重なり）も検出対象だが、本番は通常重ならない。
 */
export function detectGapViolations(
  blocks: Array<EnBlock | JaBlock>,
  minGapSec: number,
): GapViolation[] {
  if (blocks.length < 2) return []
  const sorted = [...blocks].sort((a, b) => a.start - b.start)
  const violations: GapViolation[] = []
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const a = sorted[i]
    const b = sorted[i + 1]
    const gap = b.start - a.end
    if (gap < minGapSec - 0.0005) {
      // 浮動小数誤差 0.5ms は許容
      violations.push({
        blockAId: a.id,
        blockBId: b.id,
        currentGapSec: Math.round(gap * 10000) / 10000,
        requiredGapSec: minGapSec,
        deficitSec: Math.round((minGapSec - gap) * 10000) / 10000,
        blockAEnd: a.end,
        blockBStart: b.start,
      })
    }
  }
  return violations
}

/**
 * gap_too_short 違反を決定的に解消する（タイムスタンプドリフト無し）。
 *
 * 安全保証:
 *   1. A.start と B.end は絶対に動かさない → cue の表示開始/終了境界は不変
 *   2. A.end を前倒し、B.start を後ろ倒しのみ（=内側に縮める）
 *   3. min_duration を絶対に侵さない（cue が極端に短くなることを防ぐ）
 *   4. 各修正は違反ペアの内側に閉じ込められる → 後続 cue は影響なし → 累積ドリフトゼロ
 *
 * 修正配分:
 *   - A 側の余裕（A.duration - minDuration）と B 側の余裕を計算
 *   - 両方使える時は両側を均等に使って deficit を埋める
 *   - 片側だけしか余裕がない時はその片側で詰める
 *   - 両方とも余裕が無い時は諦める（log には status='unable_to_fix' で記録）
 */
export function tightenTiming(
  blocks: EnBlock[],
  minGapSec: number,
  minDurationSec: number,
): TightenResult {
  const violations = detectGapViolations(blocks, minGapSec)
  if (violations.length === 0) {
    return {
      totalViolations: 0,
      fullyFixed: 0,
      partiallyFixed: 0,
      unableToFix: 0,
      blocks,
      entries: [],
    }
  }

  // 修正中の block を id→state でトラッキング（先行違反の影響を後続に反映するため）
  const stateById = new Map<number, { start: number; end: number }>()
  for (const b of blocks) stateById.set(b.id, { start: b.start, end: b.end })

  const entries: TightenLogEntry[] = []

  for (const v of violations) {
    const aState = stateById.get(v.blockAId)
    const bState = stateById.get(v.blockBId)
    if (!aState || !bState) continue

    const beforeGap = bState.start - aState.end
    const deficit = minGapSec - beforeGap
    if (deficit <= 0) {
      // 先行修正によって既に解消されているケース
      continue
    }

    const aDuration = aState.end - aState.start
    const bDuration = bState.end - bState.start
    const aSlack = Math.max(0, aDuration - minDurationSec)
    const bSlack = Math.max(0, bDuration - minDurationSec)
    const totalSlack = aSlack + bSlack

    let aShrink = 0
    let bShrink = 0
    let status: TightenLogEntry['status']
    let reason: string | undefined

    if (totalSlack <= 0) {
      status = 'unable_to_fix'
      reason = `both blocks already at min_duration (a=${aDuration.toFixed(3)}s, b=${bDuration.toFixed(3)}s, min=${minDurationSec}s)`
    } else if (totalSlack >= deficit) {
      // 完全に解消可能。両側で按分する（slack 比例で配分）
      aShrink = (aSlack / totalSlack) * deficit
      bShrink = (bSlack / totalSlack) * deficit
      // 1ms 精度に丸める
      aShrink = Math.round(aShrink * 1000) / 1000
      bShrink = Math.round(bShrink * 1000) / 1000
      // 端数調整: 丸めで deficit に届かなかったら大きい方に寄せる
      const totalShrink = aShrink + bShrink
      if (totalShrink < deficit - 0.0005) {
        const remainder = deficit - totalShrink
        if (aSlack - aShrink >= remainder) aShrink += remainder
        else bShrink += remainder
      }
      status = 'fully_fixed'
    } else {
      // 部分修正のみ可能。両側の slack を全部使う
      aShrink = aSlack
      bShrink = bSlack
      status = 'partially_fixed'
      reason = `insufficient slack: deficit=${deficit.toFixed(3)}s but only ${totalSlack.toFixed(3)}s available`
    }

    // 浮動小数で min_duration を侵さないよう最終チェック
    const newAEnd = aState.end - aShrink
    const newBStart = bState.start + bShrink
    if (newAEnd - aState.start < minDurationSec - 0.0005 || bState.end - newBStart < minDurationSec - 0.0005) {
      // 想定外。修正放棄
      entries.push({
        blockAId: v.blockAId,
        blockBId: v.blockBId,
        beforeGapSec: Math.round(beforeGap * 10000) / 10000,
        afterGapSec: Math.round(beforeGap * 10000) / 10000,
        aShrinkSec: 0,
        bShrinkSec: 0,
        beforeAEnd: aState.end,
        afterAEnd: aState.end,
        beforeBStart: bState.start,
        afterBStart: bState.start,
        status: 'unable_to_fix',
        reason: 'min_duration violation detected after shrink calc; aborted',
      })
      continue
    }

    // state 更新
    aState.end = newAEnd
    bState.start = newBStart
    const afterGap = newBStart - newAEnd

    entries.push({
      blockAId: v.blockAId,
      blockBId: v.blockBId,
      beforeGapSec: Math.round(beforeGap * 10000) / 10000,
      afterGapSec: Math.round(afterGap * 10000) / 10000,
      aShrinkSec: Math.round(aShrink * 10000) / 10000,
      bShrinkSec: Math.round(bShrink * 10000) / 10000,
      beforeAEnd: aState.end + aShrink,
      afterAEnd: newAEnd,
      beforeBStart: bState.start - bShrink,
      afterBStart: newBStart,
      status,
      reason,
    })
  }

  // state を blocks に反映（不変更新）
  const updatedBlocks = blocks.map((b) => {
    const s = stateById.get(b.id)
    if (!s) return b
    if (s.start === b.start && s.end === b.end) return b
    return { ...b, start: s.start, end: s.end }
  })

  return {
    totalViolations: violations.length,
    fullyFixed: entries.filter((e) => e.status === 'fully_fixed').length,
    partiallyFixed: entries.filter((e) => e.status === 'partially_fixed').length,
    unableToFix: entries.filter((e) => e.status === 'unable_to_fix').length,
    blocks: updatedBlocks,
    entries,
  }
}
