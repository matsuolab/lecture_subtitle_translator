import { useState } from 'react'
import type { ReactNode } from 'react'
import type { GlossaryTerm } from '@/types/subtitle'
import { useTheme } from '@/context/ThemeContext'

interface TermHighlightProps {
  text: string
  terms: GlossaryTerm[]
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

export function TermHighlight({ text, terms }: TermHighlightProps) {
  const { theme } = useTheme()
  const [hoveredWord, setHoveredWord] = useState<string | null>(null)

  if (terms.length === 0) return <span>{renderWithBreaks(text, theme.textMuted)}</span>

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

  // パーツに分割
  const parts: { text: string; term?: GlossaryTerm }[] = []
  let cursor = 0
  while (cursor < text.length) {
    if (!markedPositions[cursor]) {
      const start = cursor
      while (cursor < text.length && !markedPositions[cursor]) cursor++
      parts.push({ text: text.slice(start, cursor) })
    } else {
      const start = cursor
      while (cursor < text.length && markedPositions[cursor]) cursor++
      const word = text.slice(start, cursor)
      // スパン先頭位置の term を使用（長い用語優先で posToTerm に記録済み）
      const matchedTerm = posToTerm[start]
      parts.push({ text: word, term: matchedTerm })
    }
  }

  return (
    <span>
      {parts.map((part, i) =>
        part.term ? (
          <span
            key={i}
            style={{ position: 'relative', display: 'inline-block' }}
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
          <span key={i}>{renderWithBreaks(part.text, theme.textMuted)}</span>
        )
      )}
    </span>
  )
}
