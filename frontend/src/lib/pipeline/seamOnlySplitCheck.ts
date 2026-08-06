/**
 * 「継ぎ目のみの修正か」を判定する共有ロジック。
 *
 * split_block ツールに渡した原文（transcript）と、LLM が返した分割ユニットを付き合わせ、
 * 「各ユニットの末尾を完結させるための最小限の修正」以外の書き換え（言い換え・要約・
 * 語句の追加、末尾の欠落）が無いかを機械的に検査する。
 *
 * アルゴリズムは scripts/measureSeamOnlySplit.ts で実データ183件を計測し、80.3%が
 * 継ぎ目のみの修正で分割できること／本文を書き換えた3件（1.6%）を全て捕捉できることを
 * 確認済み。計測結果をそのまま split_block の合否判定に使うため、ロジックは変更しないこと
 * （scripts/measureSeamOnlySplit.ts もこのモジュールを使う）。
 */

// 継ぎ目以外の書き換えを許容しない予算（文字数）。末尾の言い切り修正・原文側の
// 助詞削れを吸収するための小さな遊びで、これを超えたら「本文を書き換えた」と判定する。
export const SEAM_BUDGET = 8

export type SeamCheckClassification =
  | 'split_ok'
  | 'refused'
  | 'rewritten_outside_seam'
  | 'tail_dropped'

export interface SeamUnitCheck {
  text: string
  tailEdit: number
}

export interface SeamCheckResult {
  classification: SeamCheckClassification
  units: SeamUnitCheck[]
  detail?: string
}

/** 空白と句読点（全角・半角）を除いた文字列にする。原文とLLM出力の表記ゆれを吸収する。 */
export function normalize(text: string): string {
  return text.replace(/[\s、。，．]/g, '')
}

/**
 * 原文とLLMが返した各ユニットを前から順にすり合わせ、継ぎ目以外の書き換えが
 * 無いかを検査する。
 *
 * 各ユニットは原文の対応する区間と先頭から一致しているはずで、一致が途切れるのは
 * 「〜しておりますので、」→「〜しております。」のように文末を完結させた分だけ、という前提を置く。
 * 一致しなかった末尾の長さ（tailEdit）が SEAM_BUDGET を超えたら、継ぎ目の修正ではなく
 * 本文の書き換えとみなして不採用にする。原文側は「ので」のように削られる場合があるため、
 * 次ユニットの開始位置は SEAM_BUDGET 文字先までを探索する。
 */
export function checkSeamOnlySplit(origRaw: string, unitsRaw: readonly string[]): SeamCheckResult {
  if (unitsRaw.length < 2) {
    return { classification: 'refused', units: [] }
  }

  const orig = normalize(origRaw)
  const units = unitsRaw.map(normalize)
  const checks: SeamUnitCheck[] = []
  let cursor = 0

  for (let j = 0; j < units.length; j += 1) {
    const u = units[j]
    let p = 0
    while (p < u.length && cursor + p < orig.length && u[p] === orig[cursor + p]) {
      p += 1
    }
    const tailEdit = u.length - p
    checks.push({ text: unitsRaw[j], tailEdit })

    if (tailEdit > SEAM_BUDGET) {
      return {
        classification: 'rewritten_outside_seam',
        units: checks,
        detail: `unit#${j + 1}: tailEdit=${tailEdit} > ${SEAM_BUDGET}`,
      }
    }

    if (j < units.length - 1) {
      const next = units[j + 1].slice(0, 12)
      let found = -1
      for (let d = 0; d <= SEAM_BUDGET; d += 1) {
        if (orig.startsWith(next, cursor + p + d)) {
          found = cursor + p + d
          break
        }
      }
      if (found === -1) {
        return {
          classification: 'rewritten_outside_seam',
          units: checks,
          detail: `unit#${j + 1}→#${j + 2}: 次ユニットの開始位置が原文中に見つからない`,
        }
      }
      cursor = found
    } else {
      const remaining = orig.length - (cursor + p)
      if (remaining > SEAM_BUDGET) {
        return {
          classification: 'tail_dropped',
          units: checks,
          detail: `末尾 ${remaining} 文字が原文に残っている`,
        }
      }
    }
  }

  return { classification: 'split_ok', units: checks }
}
