/**
 * finalQA ノード。
 * 全制約を最終確認し、違反に優先度（P1/P2/P3）を付与する。
 * ブロック間の重複・ギャップも自動調整する。
 *
 * 設計思想:
 *   - リトライループの外で1回だけ実行
 *   - 自動修正できるもの（重複・ギャップ）はここで直す
 *   - 修正できないものは優先度付きで人間に渡す
 *
 * LLM 不使用。純粋 TypeScript。
 */

import type { NodeContract, NodeContext } from '../nodeContract'
import type { PipelineSubtitleBlock, QaViolation, ViolationPriority } from '../types'

// Netflix チェイニングルール: 24fps で 2フレーム = 83ms
const MIN_GAP_MS   = 83    / 1000   // 秒
const MIN_DURATION = 0.833          // 秒（Netflix 最短 5/6 秒）
const MAX_DURATION = 7.0            // 秒

// CPS 閾値（二段階）
const CPS_P1_THRESHOLD = 25.0   // これ超 → P1（実質読めない）
const CPS_P2_THRESHOLD = 17.0   // これ超 → P2（maxCps 超過）

// 行長 閾値（二段階）
const LINE_P1_THRESHOLD = 55    // これ超 → P1（画面外に出る可能性）

function computeViolations(
  block: PipelineSubtitleBlock,
  maxCps: number,
  maxChars: number,
): readonly QaViolation[] {
  const violations: QaViolation[] = []
  const dur = block.end - block.start

  // CPS
  if (block.cps > CPS_P1_THRESHOLD) {
    violations.push({ type: 'cps', detail: `CPS ${block.cps.toFixed(1)} > ${CPS_P1_THRESHOLD}（P1）` })
  } else if (block.cps > maxCps) {
    violations.push({ type: 'cps', detail: `CPS ${block.cps.toFixed(1)} > ${maxCps}（P2）` })
  }

  // 行長
  const lines = block.text.split('\n')
  for (const line of lines) {
    if (line.length > LINE_P1_THRESHOLD) {
      violations.push({ type: 'lineLength', detail: `行長 ${line.length} > ${LINE_P1_THRESHOLD}（P1）` })
      break
    } else if (line.length > maxChars) {
      violations.push({ type: 'lineLength', detail: `行長 ${line.length} > ${maxChars}（P2）` })
      break
    }
  }

  // 表示時間
  if (dur < MIN_DURATION) {
    violations.push({ type: 'durationShort', detail: `表示時間 ${dur.toFixed(3)}s < ${MIN_DURATION}s` })
  }
  if (dur > MAX_DURATION) {
    violations.push({ type: 'durationLong', detail: `表示時間 ${dur.toFixed(1)}s > ${MAX_DURATION}s` })
  }

  // TS精度
  if (block.alignConfidence === 'proportional') {
    violations.push({ type: 'timestampUncertain', detail: 'word アライメント失敗（比例配分TS）' })
  }
  if (block.alignConfidence === 'merged') {
    // merged は通常問題ないが、長くなった場合だけ記録
    if (dur > MAX_DURATION) {
      violations.push({ type: 'timestampUncertain', detail: 'マージ済みブロック（推定TS）' })
    }
  }

  return violations
}

function computePriority(violations: readonly QaViolation[], block: PipelineSubtitleBlock): ViolationPriority {
  if (violations.length === 0) return null

  const hasP1 = violations.some(v => {
    if (v.type === 'cps')        return block.cps > CPS_P1_THRESHOLD
    if (v.type === 'lineLength') return block.text.split('\n').some(l => l.length > LINE_P1_THRESHOLD)
    return false
  })
  if (hasP1) return 'p1'

  const hasP2 = violations.some(v =>
    v.type === 'cps' || v.type === 'lineLength' || v.type === 'durationLong'
  )
  if (hasP2) return 'p2'

  return 'p3'
}

export const finalQaNode: NodeContract<
  readonly PipelineSubtitleBlock[],
  readonly PipelineSubtitleBlock[]
> = {
  id: 'finalQA',
  schemaVersion: '1.0',

  async run(
    input: readonly PipelineSubtitleBlock[],
    ctx: NodeContext,
  ): Promise<readonly PipelineSubtitleBlock[]> {
    ctx.onProgress('finalQA: 最終品質チェック・ギャップ調整中...')

    const { maxCps, maxChars } = ctx.config.subtitleConstraints

    // ── Step 0: start 時刻で昇順ソート（splitJa が順序保証しない場合の安全策）──
    const sorted = [...input].sort((a, b) => a.start - b.start)

    // ── Step 0b: 過長ブロックを自動キャップ（Netflix MAX_DURATION = 7s）──
    // 長い沈黙・スライド表示区間で WhisperX が 20s+ セグメントを出すケースに対応。
    // end を cap するのみ（start は変えない）。
    const capped: PipelineSubtitleBlock[] = sorted.map(b => {
      const dur = b.end - b.start
      if (dur > MAX_DURATION) {
        return { ...b, end: b.start + MAX_DURATION }
      }
      return b
    })

    // ── Step 1: 重複・ギャップを自動調整 ──
    const adjusted: PipelineSubtitleBlock[] = capped.map(b => ({ ...b }))

    for (let i = 0; i < adjusted.length - 1; i++) {
      const cur  = adjusted[i]
      const next = adjusted[i + 1]

      if (cur.end > next.start) {
        // 重複 → 現ブロックの end を詰める
        // ただし start を下回らないよう保護（逆順ブロック由来の崩壊防止）
        const newEnd = next.start - MIN_GAP_MS
        adjusted[i] = { ...cur, end: Math.max(newEnd, cur.start + MIN_GAP_MS) }
      } else {
        const gap = next.start - cur.end
        // Netflix チェイニング: 3〜11フレーム（≈83ms〜458ms）は2フレームに統一
        if (gap < 0.5 && gap < MIN_GAP_MS) {
          const newEnd = next.start - MIN_GAP_MS
          adjusted[i] = { ...cur, end: Math.max(newEnd, cur.start + MIN_GAP_MS) }
        }
      }
    }

    // ── Step 2: 全制約チェック + 優先度付与 ──
    // 0以下 duration のブロックは万が一残っていても除外（SRT出力が壊れる防止）
    return adjusted
      .filter(block => block.end > block.start)
      .map((block, idx) => {
        const violations = computeViolations(block, maxCps, maxChars)
        const violationPriority = computePriority(violations, block)

        return {
          ...block,
          id: idx + 1,   // filter後に id を振り直す
          qaViolations: violations,
          violationPriority,
          flagged: violations.length > 0 || block.flagged,
        }
      })
  },
}
