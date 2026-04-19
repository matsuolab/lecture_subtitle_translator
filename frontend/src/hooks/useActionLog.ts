/**
 * useActionLog — エディタ操作ログ（ノーレンダー）
 *
 * useRef ベースのため setState を一切呼ばず、UI の再レンダーを引き起こさない。
 * split / merge / edit / approve / flag / timing の各操作について
 * before / after スナップショットを記録し、JSON 出力に使う。
 */

import { useRef, useCallback } from 'react'

// ---------------------------------------------------------------------------
// 型定義
// ---------------------------------------------------------------------------

export type ActionOp =
  | 'load_srt'
  | 'edit_source'
  | 'edit_target'
  | 'split'
  | 'split_playhead'
  | 'split_equal'
  | 'split_target'
  | 'merge'
  | 'approve'
  | 'flag'
  | 'adjust_time'

/** ブロックの最小スナップショット（変化した項目のみ記録） */
export interface BlockSnap {
  id: number
  text?: string
  target?: string
  cps?: number
  chars?: number
  start?: number
  end?: number
  status?: string
}

export interface ActionEntry {
  /** セッション開始からの経過ミリ秒 */
  t: number
  op: ActionOp
  before?: BlockSnap | BlockSnap[]
  after?: BlockSnap | BlockSnap[]
  /** load_srt 専用 */
  blockCount?: number
  file?: string
}

/** SRT読み込み時・SRT出力時のブロックスナップショット */
export interface BlockState {
  id: number
  startTime: number
  endTime: number
  /** 英語原文（SRT に書き出される側） */
  source: string
  /** 日本語訳文（読み込み元または書き起こし出力） */
  target: string
}

export interface SessionLog {
  version: 1
  startedAt: string
  loadedFile?: string
  /** SRT読み込み時の全ブロック（JP + 元EN） */
  initialBlocks: BlockState[]
  /** SRT出力時の全ブロック（JP + 最終EN） — exportSrt 呼び出し時に付与 */
  finalBlocks?: BlockState[]
  entries: ActionEntry[]
}

// ---------------------------------------------------------------------------
// ヘルパー
// ---------------------------------------------------------------------------

/** SubtitleBlock（UI型）から BlockSnap を生成 */
export function snapBlock(b: {
  id: number
  source?: string
  target?: string
  cps?: number
  charCount?: number
  startTime?: number
  endTime?: number
  status?: string
}): BlockSnap {
  return {
    id: b.id,
    text: b.source,
    target: b.target,
    cps: b.cps,
    chars: b.charCount,
    start: b.startTime !== undefined ? Math.round(b.startTime * 1000) / 1000 : undefined,
    end: b.endTime !== undefined ? Math.round(b.endTime * 1000) / 1000 : undefined,
    status: b.status,
  }
}

// ---------------------------------------------------------------------------
// フック
// ---------------------------------------------------------------------------

export function useActionLog() {
  const entries = useRef<ActionEntry[]>([])
  const startMs = useRef(Date.now())
  const loadedFile = useRef<string | undefined>(undefined)
  const initialBlocks = useRef<BlockState[]>([])

  const logAction = useCallback((
    op: ActionOp,
    before?: BlockSnap | BlockSnap[],
    after?: BlockSnap | BlockSnap[],
    extra?: Pick<ActionEntry, 'blockCount' | 'file'>,
  ) => {
    entries.current.push({
      t: Date.now() - startMs.current,
      op,
      ...(before !== undefined && { before }),
      ...(after !== undefined && { after }),
      ...extra,
    })
  }, [])

  /** SRT 読み込み時にセッションをリセット。全ブロックの初期状態（JP+EN）を保存する */
  const resetSession = useCallback((
    fileName?: string,
    blockCount?: number,
    blocks?: BlockState[],
  ) => {
    entries.current = []
    startMs.current = Date.now()
    loadedFile.current = fileName
    initialBlocks.current = blocks ?? []
    entries.current.push({
      t: 0,
      op: 'load_srt',
      blockCount,
      file: fileName,
    })
  }, [])

  /**
   * セッションログを返す。
   * @param finalBlocks SRT出力時の全ブロック状態（最終EN+JP）。省略時は finalBlocks なし。
   */
  const getLog = useCallback((finalBlocks?: BlockState[]): SessionLog => ({
    version: 1,
    startedAt: new Date(startMs.current).toISOString(),
    loadedFile: loadedFile.current,
    initialBlocks: [...initialBlocks.current],
    ...(finalBlocks !== undefined && { finalBlocks }),
    entries: [...entries.current],
  }), [])

  return { logAction, resetSession, getLog }
}
