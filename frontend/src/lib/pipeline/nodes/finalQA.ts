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
import type { PipelineSubtitleBlock, QaViolation, ViolationPriority, DiagnosticPattern } from '../types'

// Netflix チェイニングルール: 24fps で 2フレーム = 83ms（技術仕様固定）
const MIN_GAP_MS   = 83    / 1000   // 秒

// CPS 閾値（二段階）— 物理的上限のため固定
const CPS_P1_THRESHOLD = 25.0   // これ超 → P1（実質読めない）

// CPS 下限（低すぎる = テキストが短すぎて字幕が長く出続ける）— 診断補助値のため固定
const CPS_TOO_LOW_THRESHOLD = 3.0   // これ未満 → P3（字幕が長く表示され続ける）

function computeViolations(
  block: PipelineSubtitleBlock,
  maxCps: number,
  maxChars: number,
  maxLines: number,
  maxTotalChars: number,
  minDuration: number,
  maxDuration: number,
): readonly QaViolation[] {
  const violations: QaViolation[] = []
  const dur = block.end - block.start

  // CPS（高すぎ）
  if (block.cps > CPS_P1_THRESHOLD) {
    violations.push({ type: 'cps', detail: `CPS ${block.cps.toFixed(1)} > ${CPS_P1_THRESHOLD}（P1）` })
  } else if (block.cps > maxCps) {
    violations.push({ type: 'cps', detail: `CPS ${block.cps.toFixed(1)} > ${maxCps}（P2）` })
  }

  // CPS（低すぎ = テキストが短く字幕が長く表示されすぎる）
  if (block.cps > 0 && block.cps < CPS_TOO_LOW_THRESHOLD && dur > 5.0) {
    violations.push({ type: 'cpsTooLow', detail: `CPS ${block.cps.toFixed(1)} < ${CPS_TOO_LOW_THRESHOLD}（表示時間 ${dur.toFixed(1)}s、テキスト不足）` })
  }

  // 行長・行数・合計文字数チェック
  const lines = block.text.split('\n')

  // 行数
  if (lines.length > maxLines) {
    violations.push({ type: 'lineCount', detail: `${lines.length}行 > ${maxLines}行` })
  }

  // 1行の最大文字数
  for (const line of lines) {
    if (line.length > maxChars) {
      violations.push({ type: 'lineLength', detail: `行長 ${line.length} > ${maxChars}` })
      break
    }
  }

  // 全行合計文字数
  const totalChars = lines.reduce((sum, l) => sum + l.length, 0)
  if (totalChars > maxTotalChars) {
    violations.push({ type: 'totalChars', detail: `合計 ${totalChars} > ${maxTotalChars}文字` })
  }

  // 表示時間
  if (dur < minDuration) {
    violations.push({ type: 'durationShort', detail: `表示時間 ${dur.toFixed(3)}s < ${minDuration}s` })
  }
  if (dur > maxDuration) {
    violations.push({ type: 'durationLong', detail: `表示時間 ${dur.toFixed(1)}s > ${maxDuration}s` })
  }

  // TS精度
  if (block.alignConfidence === 'proportional') {
    violations.push({ type: 'timestampUncertain', detail: 'word アライメント失敗（比例配分TS）' })
  }
  if (block.alignConfidence === 'merged') {
    // merged は通常問題ないが、長くなった場合だけ記録
    if (dur > maxDuration) {
      violations.push({ type: 'timestampUncertain', detail: 'マージ済みブロック（推定TS）' })
    }
  }

  return violations
}

function computePriority(violations: readonly QaViolation[], block: PipelineSubtitleBlock): ViolationPriority {
  if (violations.length === 0) return null

  const hasP1 = violations.some(v =>
    v.type === 'cps' && block.cps > CPS_P1_THRESHOLD
  )
  if (hasP1) return 'p1'

  const hasP2 = violations.some(v =>
    v.type === 'cps' || v.type === 'lineLength' || v.type === 'lineCount' || v.type === 'totalChars' || v.type === 'durationLong'
  )
  if (hasP2) return 'p2'

  // cpsTooLow, durationShort, timestampUncertain は P3（情報提供。人間が判断）
  return 'p3'
}

// ---------------------------------------------------------------------------
// 根本原因診断
// ---------------------------------------------------------------------------

/**
 * ブロックの問題根本原因を1つ特定する。
 * 複数シグナル（duration・JA文字数・EN/JA比・CPS・alignConfidence）を組み合わせて判定。
 *
 * 優先順位（最も緊急性・情報価値が高いものを先に判定）:
 * 1. proportional_ts  — TS自体が信頼できない（他の診断が不確実になる）
 * 2. short_duration   — 分割しすぎ（CPS計算が不安定で他の症状を引き起こす）
 * 3. merged_long      — マージ後の長ブロック
 * 4. over_compressed  — 翻訳が要約しすぎ（意味喪失リスク）
 * 5. long_segment     — WhisperX長発話（自然現象、対処困難）
 * 6. verbose_en       — 英訳冗長（CPS高）
 * 7. line_length_only — 行長のみ（書式問題）
 * 8. ok
 */
function diagnoseBlock(
  block: PipelineSubtitleBlock,
  maxCps: number,
  maxChars: number,
  maxDuration: number,
): DiagnosticPattern {
  const dur = block.end - block.start

  // JA文字数（空白除く）
  const jaCharsRaw = block.jaText.length
  const jaChars = block.jaText.replace(/\s/g, '').length
  const enChars = block.charCount

  // EN/JA 文字比（日本語は英語より情報密度が高いため 0.5〜1.2 が正常範囲）
  const enToJaRatio = jaChars > 0 ? enChars / jaChars : 1.0

  // 1. TS推定（word アライメント失敗）— TS自体が不確実
  if (block.alignConfidence === 'proportional') return 'proportional_ts'

  // 2. 分割しすぎ（短い duration → CPS計算が不安定）
  if (dur < 1.5) return 'short_duration'

  // 3. マージ後長ブロック
  if (block.alignConfidence === 'merged' && dur > maxDuration) return 'merged_long'

  // 4. 過剰圧縮
  // JA が十分な長さ（15文字以上）で EN/JA 比が異常に低い場合
  // 閾値 0.25: 日本語10文字 → 英語2.5文字は明らかに短縮しすぎ
  if (jaCharsRaw > 15 && enToJaRatio < 0.25 && block.cps < 5) return 'over_compressed'

  // 5. 長発話セグメント（WhisperX が長い発話を1セグメントにまとめた）
  // EN/JA 比が正常範囲（過剰圧縮ではない）だが duration が長く CPS が低い
  if (dur > 10 && block.cps < 4) return 'long_segment'

  // 5b. 話者がゆっくり話している（自然現象 — 対処不要）
  // JA テキスト自体が短い（< 20文字）のに duration が長い → 話者が意図的にゆっくり話している
  // over_compressed とは異なり、EN/JA 比は正常。単に話者速度が遅い
  if (jaCharsRaw < 20 && dur >= 5.0 && block.cps > 0 && block.cps < 5.0) return 'slow_speech'

  // 6. 英訳冗長（CPS高）
  if (block.cps > maxCps) return 'verbose_en'

  // 7. 行長のみ（CPS はOK だが1行が長すぎる）
  const maxLineLen = Math.max(...block.text.split('\n').map(l => l.length))
  if (maxLineLen > maxChars) return 'line_length_only'

  return 'ok'
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

    const { maxCps, maxChars, maxLines, maxTotalChars } = ctx.config.subtitleConstraints
    const { minDurationSec, maxDurationSec } = ctx.config.timingConstraints

    // ── Step 0: start 時刻で昇順ソート（splitJa が順序保証しない場合の安全策）──
    const sorted = [...input].sort((a, b) => a.start - b.start)

    // ── Step 1: 重複・ギャップを自動調整 ──
    // 過長ブロックは自動キャップしない → 字幕が途中で消えて空白が生まれるため
    // durationLong 違反としてフラグを立て、人間が判断する
    const adjusted: PipelineSubtitleBlock[] = sorted.map(b => ({ ...b }))

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
        const violations = computeViolations(block, maxCps, maxChars, maxLines, maxTotalChars, minDurationSec, maxDurationSec)
        const violationPriority = computePriority(violations, block)

        const diagPattern = diagnoseBlock(block, maxCps, maxChars, maxDurationSec)

        return {
          ...block,
          id: idx + 1,   // filter後に id を振り直す
          qaViolations: violations,
          violationPriority,
          diagPattern,
          flagged: violations.length > 0 || block.flagged,
        }
      })
  },
}
