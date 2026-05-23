import { useState } from 'react'
import type { ReactNode } from 'react'
import type { GlossaryTerm } from '@/types/subtitle'
import { useTheme } from '@/context/ThemeContext'

export interface SearchHighlightRange {
  start: number
  end: number
  /** 「現在の」マッチかどうか。true のときアクセント色で強調 */
  current?: boolean
}

interface TermHighlightProps {
  text: string
  terms: GlossaryTerm[]
  /** 検索ヒット位置（オプション）。用語ハイライトの上に重ねて表示する */
  searchRanges?: SearchHighlightRange[]
}

/** テキスト中の \n を ↵ マーカー + <br> に変換して表示する */
function renderWithBreaks(text: string, markerColor: string): ReactNode {
  const lines = text.split('\n')
  if (lines.length === 1) return text
  const result: ReactNode[] = []
  lines.forEach((line, i) => {
    result.push(line)
    if (i < lines.length - 1) {
      result.push(
        <span key={`nl-${i}`} aria-hidden style={{ color: markerColor, fontSize: '0.8em', userSelect: 'none', marginLeft: 1 }}>↵</span>
      )
      result.push(<br key={`br-${i}`} />)
    }
  })
  return result as ReactNode
}

export function TermHighlight({ text, terms, searchRanges }: TermHighlightProps) {
  const { theme } = useTheme()
  const [hoveredWord, setHoveredWord] = useState<string | null>(null)

  const hasSearch = !!searchRanges && searchRanges.length > 0
  if (terms.length === 0 && !hasSearch) return <span>{renderWithBreaks(text, theme.textMuted)}</span>

  // テキスト中の用語にマークを付ける
  const markedPositions: boolean[] = new Array(text.length).fill(false)
  // どの位置がどの term に対応するかを記録する（長い用語が短い用語を上書き）
  const posToTerm: (GlossaryTerm | undefined)[] = new Array(text.length).fill(undefined)
  const textLower = text.toLowerCase()
  for (const term of terms) {
    const wordLower = term.word.toLowerCase()
    let idx = textLower.indexOf(wordLower)
    while (idx !== -1) {
      for (let i = idx; i < idx + term.word.length; i++) {
        // 既にマークされている位置は長い方の用語を優先
        if (!markedPositions[i] || (posToTerm[i] && posToTerm[i]!.word.length < term.word.length)) {
          posToTerm[i] = term
        }
        markedPositions[i] = true
      }
      idx = textLower.indexOf(wordLower, idx + 1)
    }
  }

  // 検索マッチ位置を記録（0: なし / 1: マッチ / 2: 現在のマッチ）
  const searchMark: Uint8Array = new Uint8Array(text.length)
  if (searchRanges) {
    for (const r of searchRanges) {
      const lo = Math.max(0, r.start)
      const hi = Math.min(text.length, r.end)
      for (let i = lo; i < hi; i++) {
        if (r.current) searchMark[i] = 2
        else if (searchMark[i] === 0) searchMark[i] = 1
      }
    }
  }

  // パーツに分割（用語 + 検索マッチ状態が同じ連続範囲をまとめる）
  const parts: { text: string; term?: GlossaryTerm; search?: 1 | 2 }[] = []
  let cursor = 0
  while (cursor < text.length) {
    const startTerm = markedPositions[cursor] ? posToTerm[cursor] : undefined
    const startSearch = searchMark[cursor]
    let end = cursor + 1
    while (
      end < text.length &&
      (markedPositions[end] ? posToTerm[end] : undefined) === startTerm &&
      searchMark[end] === startSearch
    ) end++
    const search: 1 | 2 | undefined = startSearch === 2 ? 2 : startSearch === 1 ? 1 : undefined
    parts.push({ text: text.slice(cursor, end), term: startTerm, search })
    cursor = end
  }

  const searchStyle = (level: 1 | 2): React.CSSProperties => level === 2 ? {
    background: 'rgba(255,196,0,0.85)',
    color: '#1a1a1a',
    borderRadius: 2,
    outline: '1px solid rgba(255,140,0,0.95)',
    padding: '0 1px',
  } : {
    background: 'rgba(255,236,140,0.55)',
    borderRadius: 2,
    padding: '0 1px',
  }

  const wrapSearch = (node: ReactNode, level: 1 | 2 | undefined, key: string | number): ReactNode => {
    if (!level) return <span key={key}>{node}</span>
    return <span key={key} style={searchStyle(level)}>{node}</span>
  }

  return (
    <span>
      {parts.map((part, i) =>
        part.term ? (
          <span
            key={i}
            style={{ position: 'relative', display: 'inline-block', ...(part.search ? searchStyle(part.search) : null) }}
            onMouseEnter={() => setHoveredWord(part.term!.word)}
            onMouseLeave={() => setHoveredWord(null)}
          >
            {part.term.bgColor ? (
              // 背景ハイライト（タイポ候補など）
              <span
                style={{
                  background: part.term.bgColor + '40',
                  outline: `1.5px solid ${part.term.bgColor}`,
                  borderRadius: 3,
                  padding: '0 2px',
                  cursor: 'help',
                }}
              >
                {part.text}
              </span>
            ) : (
              // アンダーライン（辞書用語マッチ）
              <span
                style={{
                  textDecoration: 'underline',
                  textDecorationColor: part.term.color ?? theme.textAccentLink,
                  textUnderlineOffset: 2,
                  textDecorationThickness: 2,
                  cursor: 'help',
                }}
              >
                {part.text}
              </span>
            )}
            {hoveredWord === part.term.word && (
              <span
                style={{
                  display: 'block',
                  position: 'absolute',
                  top: 'calc(100% + 6px)',
                  left: 0,
                  background: theme.balloonBg,
                  border: `1px solid ${part.term.bgColor ?? theme.balloonBorder}`,
                  borderRadius: 8,
                  padding: '8px 12px',
                  fontSize: 12,
                  color: theme.balloonText,
                  whiteSpace: 'normal',
                  minWidth: 180,
                  maxWidth: 260,
                  zIndex: 9999,
                  boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
                  pointerEvents: 'none',
                }}
              >
                {part.term.bgColor ? (
                  // タイポ候補バルーン
                  <>
                    <span style={{ fontWeight: 700, color: part.term.bgColor, display: 'block', marginBottom: 4 }}>
                      タイポの可能性
                    </span>
                    <span style={{ color: theme.balloonText, display: 'block' }}>
                      {part.text}
                      <span style={{ color: theme.balloonTextSecondary, margin: '0 6px' }}>→</span>
                      <span style={{ fontWeight: 700 }}>{part.term.expectedTranslation}</span>
                      <span style={{ color: theme.balloonTextSecondary }}> ?</span>
                    </span>
                  </>
                ) : (
                  // 辞書用語バルーン
                  <>
                    <span style={{ fontWeight: 700, color: theme.balloonText, display: 'block', marginBottom: 4 }}>
                      {part.term.expectedTranslation}
                      <span style={{ color: theme.balloonTextSecondary, margin: '0 4px' }}>→</span>
                      {part.term.word}
                    </span>
                    {part.term.insight && (
                      <span style={{ display: 'block', color: theme.balloonTextSecondary, fontWeight: 400, lineHeight: 1.5 }}>
                        {part.term.insight}
                      </span>
                    )}
                  </>
                )}
                {/* バルーンの矢印 */}
                <span style={{
                  position: 'absolute',
                  bottom: '100%',
                  left: 10,
                  width: 0,
                  height: 0,
                  borderLeft: '6px solid transparent',
                  borderRight: '6px solid transparent',
                  borderBottom: `6px solid ${part.term.bgColor ?? theme.balloonBorder}`,
                }} />
              </span>
            )}
          </span>
        ) : (
          wrapSearch(renderWithBreaks(part.text, theme.textMuted), part.search, i)
        )
      )}
    </span>
  )
}
