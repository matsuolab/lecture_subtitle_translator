import { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import type { PipelineRunLog, CpsAttemptLog } from '@/types/pipeline'
import { useTheme } from '@/context/ThemeContext'

interface ExecutionLogTabProps {
  log: PipelineRunLog
}

type Filter = 'all' | 'error' | 'cps' | 'correct' | 'translate'

function formatMs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

function AttemptCard({ attemptLog, isExpanded, onToggle }: {
  attemptLog: CpsAttemptLog
  isExpanded: boolean
  onToggle: () => void
}) {
  const { theme } = useTheme()
  const { attempt, result, durationMs, splitJaOutput, translateEnOutput, splitEnOutput, violations, splitHints } = attemptLog

  const resultColor = result === 'pass' ? '#22c55e' : result === 'retry' ? '#f59e0b' : '#ef4444'
  const resultLabel = result === 'pass' ? 'PASS' : result === 'retry' ? 'RETRY' : 'MAX_ATTEMPTS'

  return (
    <div style={{
      border: `1px solid ${theme.panelBorder}`,
      borderRadius: 6,
      marginBottom: 6,
      overflow: 'hidden',
    }}>
      <button
        onClick={onToggle}
        style={{
          width: '100%',
          textAlign: 'left',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '6px 10px',
          background: theme.cardBg,
          border: 'none',
          cursor: 'pointer',
          fontSize: 11,
        }}
      >
        {isExpanded ? <ChevronDown size={12} color={theme.textMuted} /> : <ChevronRight size={12} color={theme.textMuted} />}
        <span style={{ fontWeight: 700, color: theme.textPrimary }}>Attempt {attempt}</span>
        <span style={{ color: resultColor, fontWeight: 600 }}>{resultLabel}</span>
        <span style={{ color: theme.textMuted }}>{formatMs(durationMs)}</span>
        {splitHints.length > 0 && (
          <span style={{ color: '#f59e0b' }}>{splitHints.length}ヒント適用</span>
        )}
        <span style={{ color: theme.textSecondary, marginLeft: 'auto' }}>
          splitJa: {splitJaOutput.length}文 → translateEn: {translateEnOutput.length}文 → splitEn: {splitEnOutput.length}ブロック
        </span>
        {violations.length > 0 && (
          <span style={{ color: '#ef4444' }}>CPS違反: {violations.length}件</span>
        )}
      </button>

      {isExpanded && (
        <div style={{ padding: '8px 10px', background: theme.panelBg, borderTop: `1px solid ${theme.panelBorder}` }}>
          {/* Node rows */}
          {[
            { label: 'splitJa', count: splitJaOutput.length, unit: '文', extra: splitJaOutput.filter(b => b.alignConfidence === 'proportional').length > 0 ? `(proportional: ${splitJaOutput.filter(b => b.alignConfidence === 'proportional').length}件)` : '' },
            { label: 'translateEn', count: translateEnOutput.length, unit: '英訳', extra: '' },
            { label: 'splitEn', count: splitEnOutput.length, unit: 'ブロック', extra: violations.length > 0 ? `CPS違反: ${violations.length}件` : 'CPS OK' },
          ].map(row => (
            <div key={row.label} style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: 11, marginBottom: 4 }}>
              <span style={{ color: theme.textMuted, minWidth: 90 }}>{row.label}</span>
              <span style={{ color: theme.textSecondary }}>{row.count} {row.unit}</span>
              {row.extra && <span style={{ color: row.extra.startsWith('CPS違反') ? '#ef4444' : theme.textMuted }}>{row.extra}</span>}
            </div>
          ))}

          {violations.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: theme.textMuted, marginBottom: 4 }}>CPS違反ブロック</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {violations.map(v => (
                  <span key={v.blockId} style={{
                    fontSize: 10,
                    background: 'rgba(239,68,68,0.1)',
                    border: '1px solid rgba(239,68,68,0.3)',
                    borderRadius: 4,
                    padding: '2px 6px',
                    color: '#ef4444',
                  }}>
                    #{v.blockId} CPS={v.cps.toFixed(1)}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export function ExecutionLogTab({ log }: ExecutionLogTabProps) {
  const { theme } = useTheme()
  const [expandedAttempts, setExpandedAttempts] = useState<Set<number>>(new Set([1]))
  const [filter, setFilter] = useState<Filter>('all')

  const toggleAttempt = (attempt: number) => {
    setExpandedAttempts(prev => {
      const next = new Set(prev)
      if (next.has(attempt)) next.delete(attempt)
      else next.add(attempt)
      return next
    })
  }

  const filters: Array<{ key: Filter; label: string }> = [
    { key: 'all', label: '全て' },
    { key: 'error', label: 'エラー/警告' },
    { key: 'cps', label: 'CPS詳細' },
    { key: 'correct', label: '補正' },
    { key: 'translate', label: '翻訳' },
  ]

  // correctJa stats
  const flaggedCorrections = log.correctJaOutput.filter(s => s.correctionFlagged)

  return (
    <div>
      {/* フィルター */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
        {filters.map(f => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            style={{
              fontSize: 11,
              padding: '3px 10px',
              borderRadius: 12,
              border: `1px solid ${filter === f.key ? theme.accent : theme.panelBorder}`,
              background: filter === f.key ? theme.accent : theme.panelBg,
              color: filter === f.key ? '#fff' : theme.textSecondary,
              cursor: 'pointer',
            }}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* transcribe */}
      {(filter === 'all') && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 11, marginBottom: 6, padding: '6px 10px', background: theme.cardBg, borderRadius: 6, border: `1px solid ${theme.panelBorder}` }}>
          <span style={{ color: '#22c55e', fontWeight: 700 }}>✓</span>
          <span style={{ color: theme.textMuted, minWidth: 80 }}>transcribe</span>
          <span style={{ color: theme.textSecondary }}>{log.transcribeOutput.length}セグメント</span>
        </div>
      )}

      {/* correctJa */}
      {(filter === 'all' || filter === 'correct' || (filter === 'error' && flaggedCorrections.length > 0)) && (
        <div style={{ marginBottom: 6, padding: '6px 10px', background: theme.cardBg, borderRadius: 6, border: `1px solid ${theme.panelBorder}`, fontSize: 11 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span style={{ color: flaggedCorrections.length > 0 ? '#f59e0b' : '#22c55e', fontWeight: 700 }}>
              {flaggedCorrections.length > 0 ? '!' : '✓'}
            </span>
            <span style={{ color: theme.textMuted, minWidth: 80 }}>correctJa</span>
            <span style={{ color: theme.textSecondary }}>{log.correctJaOutput.length}セグメント補正</span>
            {flaggedCorrections.length > 0 && (
              <span style={{ color: '#f59e0b' }}>フラグ: {flaggedCorrections.length}件</span>
            )}
          </div>
          {(filter === 'correct' || filter === 'error') && flaggedCorrections.length > 0 && (
            <div style={{ marginTop: 8 }}>
              {flaggedCorrections.slice(0, 10).map(seg => (
                <div key={seg.original.id} style={{ marginBottom: 4, padding: '4px 8px', background: 'rgba(245,158,11,0.1)', borderRadius: 4 }}>
                  <div style={{ color: theme.textMuted, fontSize: 10 }}>seg #{seg.original.id}</div>
                  <div style={{ color: theme.textSecondary }}>元: {seg.original.text}</div>
                  <div style={{ color: theme.textPrimary }}>補正: {seg.correctedText}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* CPSループ各attempt */}
      {log.cpsAttempts
        .filter(a => {
          if (filter === 'all') return true
          if (filter === 'cps') return true
          if (filter === 'translate') return true
          if (filter === 'error') return a.violations.length > 0
          return false
        })
        .map(attemptLog => (
          <AttemptCard
            key={attemptLog.attempt}
            attemptLog={attemptLog}
            isExpanded={expandedAttempts.has(attemptLog.attempt)}
            onToggle={() => toggleAttempt(attemptLog.attempt)}
          />
        ))
      }

      {/* 最終出力 */}
      {(filter === 'all') && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 11, marginBottom: 6, padding: '6px 10px', background: theme.cardBg, borderRadius: 6, border: `1px solid ${theme.panelBorder}` }}>
          <span style={{ color: '#22c55e', fontWeight: 700 }}>✓</span>
          <span style={{ color: theme.textMuted, minWidth: 80 }}>exportSrt</span>
          <span style={{ color: theme.textSecondary }}>最終ブロック: {log.finalBlocks.length}件</span>
        </div>
      )}
    </div>
  )
}
