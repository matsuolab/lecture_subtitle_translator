import { useState, useEffect } from 'react'
import type { PipelineRunLog } from '@/types/pipeline'
import { useTheme } from '@/context/ThemeContext'

interface BlockDetailTabProps {
  log: PipelineRunLog
  activeBlockId?: number | null
}

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = (sec % 60).toFixed(1).padStart(4, '0')
  return `${m}:${s}`
}

export function BlockDetailTab({ log, activeBlockId }: BlockDetailTabProps) {
  const { theme } = useTheme()
  const [query, setQuery] = useState('')
  const [searched, setSearched] = useState(false)

  // 字幕エディタでアクティブなブロックが変わったら自動検索
  useEffect(() => {
    if (activeBlockId == null) return
    setQuery(String(activeBlockId))
    setSearched(true)
  }, [activeBlockId])

  const search = () => setSearched(true)

  const normalizedQuery = query.trim().toLowerCase()

  // blockKey ("a2s31") または id 数字 で検索
  const matchingFinalBlocks = searched && normalizedQuery
    ? log.finalBlocks.filter(b =>
        b.blockKey.toLowerCase() === normalizedQuery ||
        String(b.id) === normalizedQuery
      )
    : []

  const card: React.CSSProperties = {
    border: `1px solid ${theme.panelBorder}`,
    borderRadius: 6,
    padding: '10px 12px',
    background: theme.cardBg,
    marginBottom: 10,
    fontSize: 11,
  }

  const label: React.CSSProperties = {
    color: theme.textMuted,
    fontSize: 10,
    marginBottom: 2,
  }

  return (
    <div>
      {/* 検索欄 */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <input
          type="text"
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && search()}
          placeholder="ブロックキー (a2s31) または ID番号 を入力"
          style={{
            flex: 1,
            fontSize: 12,
            padding: '5px 10px',
            borderRadius: 6,
            border: `1px solid ${theme.panelBorder}`,
            background: theme.panelBg,
            color: theme.textPrimary,
            outline: 'none',
          }}
        />
        <button
          onClick={search}
          style={{
            fontSize: 12,
            padding: '5px 14px',
            borderRadius: 6,
            border: 'none',
            background: theme.accent,
            color: '#fff',
            cursor: 'pointer',
          }}
        >
          検索
        </button>
      </div>

      {/* 検索前のヒント */}
      {!searched && (
        <div style={{ fontSize: 11, color: theme.textMuted }}>
          <p style={{ marginBottom: 6 }}>ブロックキー例: <code style={{ background: theme.panelBg, padding: '1px 5px', borderRadius: 4 }}>a1s31</code>（attempt 1, id 31）</p>
          <p>単純なID検索も可能: <code style={{ background: theme.panelBg, padding: '1px 5px', borderRadius: 4 }}>31</code></p>
        </div>
      )}

      {/* 検索結果なし */}
      {searched && matchingFinalBlocks.length === 0 && (
        <div style={{ fontSize: 11, color: theme.textMuted }}>
          ブロックが見つかりません: <strong>{query}</strong>
        </div>
      )}

      {/* 検索結果 */}
      {matchingFinalBlocks.map(block => {
        // このブロックのソースセグメント
        const sourceSegs = log.correctJaOutput.filter(s =>
          block.sourceSegmentIds.includes(s.original.id)
        )

        // attempt履歴（このblockのparent chainをたどる）
        const attemptHistory: Array<{
          attempt: number
          jaText: string
          enText: string
          cps: number
          cpsOk: boolean
          violations: boolean
        }> = []

        for (const attemptLog of log.cpsAttempts) {
          // この attempt での対応ブロックを探す（blockKey の attempt部分で照合）
          const atBlock = attemptLog.splitEnOutput.find(b =>
            b.blockKey === block.blockKey ||
            // attempt の違うブロックで parentBlockId チェーンを辿る
            (b.id === block.id && b.attempt === attemptLog.attempt)
          )
          if (atBlock) {
            attemptHistory.push({
              attempt: attemptLog.attempt,
              jaText: atBlock.jaText,
              enText: atBlock.text,
              cps: atBlock.cps,
              cpsOk: atBlock.cpsOk,
              violations: !atBlock.cpsOk,
            })
          }
        }

        return (
          <div key={block.blockKey} style={card}>
            {/* ブロック概要 */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
              <span style={{ fontWeight: 700, color: theme.textPrimary }}>最終ブロック #{block.id}</span>
              <span style={{ color: theme.textMuted }}>key: {block.blockKey}</span>
              <span style={{ color: block.cpsOk ? '#22c55e' : '#ef4444' }}>
                CPS: {block.cps.toFixed(1)}
              </span>
              <span style={{ color: theme.textMuted }}>
                {formatTime(block.start)} - {formatTime(block.end)}
              </span>
            </div>

            <div style={{ marginBottom: 4 }}>
              <div style={label}>英語（字幕）</div>
              <div style={{ color: theme.textPrimary }}>{block.text}</div>
            </div>
            <div style={{ marginBottom: 10 }}>
              <div style={label}>日本語（原文）</div>
              <div style={{ color: theme.textSecondary }}>{block.jaText}</div>
            </div>

            {/* ソースセグメント */}
            {sourceSegs.length > 0 && (
              <div style={{ marginBottom: 10 }}>
                <div style={{ ...label, marginBottom: 6 }}>ソースセグメント（WhisperX）</div>
                {sourceSegs.map(seg => (
                  <div key={seg.original.id} style={{
                    padding: '5px 8px',
                    borderRadius: 4,
                    background: theme.panelBg,
                    marginBottom: 4,
                  }}>
                    <span style={{ color: theme.textMuted }}>seg #{seg.original.id}　</span>
                    <span style={{ color: theme.textMuted }}>生: </span>
                    <span style={{ color: theme.textSecondary }}>{seg.original.text}　</span>
                    <span style={{ color: theme.textMuted }}>補正: </span>
                    <span style={{ color: theme.textPrimary }}>{seg.correctedText}</span>
                    {seg.correctionFlagged && (
                      <span style={{ color: '#f59e0b', marginLeft: 6 }}>フラグ</span>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Attempt履歴 */}
            {attemptHistory.length > 1 && (
              <div>
                <div style={{ ...label, marginBottom: 6 }}>CPSループ履歴</div>
                {attemptHistory.map(ah => (
                  <div key={ah.attempt} style={{
                    padding: '5px 8px',
                    borderRadius: 4,
                    background: ah.violations ? 'rgba(239,68,68,0.07)' : 'rgba(34,197,94,0.07)',
                    border: `1px solid ${ah.violations ? 'rgba(239,68,68,0.2)' : 'rgba(34,197,94,0.2)'}`,
                    marginBottom: 4,
                    fontSize: 11,
                  }}>
                    <div style={{ display: 'flex', gap: 8, marginBottom: 2 }}>
                      <span style={{ fontWeight: 700, color: theme.textMuted }}>Attempt {ah.attempt}</span>
                      <span style={{ color: ah.violations ? '#ef4444' : '#22c55e' }}>
                        CPS={ah.cps.toFixed(1)} {ah.violations ? '→ 違反・retry' : '→ OK'}
                      </span>
                    </div>
                    <div style={{ color: theme.textSecondary }}>{ah.enText}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
