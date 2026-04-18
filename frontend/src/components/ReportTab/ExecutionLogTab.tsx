import { useState } from 'react'
import { ChevronDown, ChevronRight, CheckCircle, AlertCircle, AlertTriangle } from 'lucide-react'
import type { PipelineRunLog, CpsAttemptLog, PipelineNodeTrace, ExpandEnStats, SplitLongBlockStats } from '@/types/pipeline'
import { useTheme } from '@/context/ThemeContext'

interface ExecutionLogTabProps {
  log: PipelineRunLog
}

function formatMs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

// ── ノードトレース タイムライン ──────────────────────────────────────────

function NodeTraceLine({ trace }: { trace: PipelineNodeTrace }) {
  const { theme } = useTheme()
  const isFailure = trace.status === 'failure'

  const nodeColors: Record<string, string> = {
    correctJa:      '#a78bfa',
    splitJa:        '#60a5fa',
    mergeShort:     '#34d399',
    translateEn:    '#f59e0b',
    expandEn:       '#84cc16',
    formatLines:    '#fb923c',
    compressEn:     '#ec4899',
    splitEn:        '#22d3ee',
    splitLongBlock: '#f97316',
    finalQA:        '#ef4444',
    exportSrt:      '#6ee7b7',
  }
  const color = nodeColors[trace.nodeId] ?? theme.textMuted

  return (
    <div style={{
      display: 'flex',
      alignItems: 'flex-start',
      gap: 8,
      fontSize: 11,
      padding: '4px 0',
      borderBottom: `1px solid ${theme.panelBorder}`,
    }}>
      <span style={{ color: isFailure ? '#ef4444' : '#22c55e', lineHeight: '16px', flexShrink: 0 }}>
        {isFailure ? '✗' : '✓'}
      </span>
      <span style={{ color, fontWeight: 600, minWidth: 100, lineHeight: '16px' }}>
        {trace.nodeId}{trace.attempt > 1 ? ` #${trace.attempt}` : ''}
      </span>
      <span style={{ color: theme.textMuted, minWidth: 50, lineHeight: '16px' }}>
        {formatMs(trace.durationMs)}
      </span>
      {trace.summary && (
        <span style={{ color: theme.textSecondary, lineHeight: '16px', flex: 1 }}>
          {trace.summary}
        </span>
      )}
      {isFailure && trace.error && (
        <span style={{ color: '#ef4444', lineHeight: '16px', flex: 1 }}>
          {trace.error}
        </span>
      )}
    </div>
  )
}

// ── CPSループ 試行カード ───────────────────────────────────────────────────

function AttemptCard({ attemptLog, isExpanded, onToggle }: {
  attemptLog: CpsAttemptLog
  isExpanded: boolean
  onToggle: () => void
}) {
  const { theme } = useTheme()
  const { attempt, result, durationMs, splitJaOutput, translateEnOutput,
          expandEnStats, compressEnStats, splitEnOutput, violations, splitHints } = attemptLog

  const resultColor = result === 'pass' ? '#22c55e' : result === 'retry' ? '#f59e0b' : '#ef4444'
  const resultLabel = result === 'pass' ? 'PASS' : result === 'retry' ? 'RETRY' : 'MAX'

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
        {isExpanded
          ? <ChevronDown size={12} color={theme.textMuted} />
          : <ChevronRight size={12} color={theme.textMuted} />}
        <span style={{ fontWeight: 700, color: theme.textPrimary }}>Attempt {attempt}</span>
        <span style={{ color: resultColor, fontWeight: 600 }}>{resultLabel}</span>
        <span style={{ color: theme.textMuted }}>{formatMs(durationMs)}</span>
        {splitHints.length > 0 && (
          <span style={{ color: '#f59e0b' }}>{splitHints.length}ヒント</span>
        )}
        <span style={{ color: theme.textSecondary, marginLeft: 'auto', fontSize: 10 }}>
          splitJa {splitJaOutput.length} → en {translateEnOutput.length}
          {expandEnStats?.overCompressed > 0 ? ` → expand ${expandEnStats.expanded}/${expandEnStats.overCompressed}件` : ''}
          {' '}→ compress {compressEnStats?.compressed ?? '?'}件 → splitEn {splitEnOutput.length}
        </span>
        {violations.length > 0 && (
          <span style={{ color: '#ef4444', fontSize: 10 }}>CPS違反: {violations.length}</span>
        )}
      </button>

      {isExpanded && (
        <div style={{ padding: '8px 10px', background: theme.panelBg, borderTop: `1px solid ${theme.panelBorder}` }}>
          {/* ノード行 */}
          {[
            {
              label: 'splitJa',
              value: `${splitJaOutput.length}文`,
              sub: splitJaOutput.filter(b => b.alignConfidence === 'proportional').length > 0
                ? `proportional: ${splitJaOutput.filter(b => b.alignConfidence === 'proportional').length}件`
                : '',
              color: '',
            },
            {
              label: 'translateEn',
              value: `${translateEnOutput.length}英訳`,
              sub: '',
              color: '',
            },
            {
              label: 'expandEn',
              value: expandEnStats?.overCompressed > 0
                ? `拡張: ${expandEnStats.expanded}/${expandEnStats.overCompressed}件`
                : '対象なし',
              sub: expandEnStats?.flagged > 0 ? `フラグ: ${expandEnStats.flagged}件` : '',
              color: expandEnStats?.flagged > 0 ? '#f59e0b' : '',
            },
            {
              label: 'formatLines',
              value: '',
              sub: '',
              color: '',
            },
            {
              label: 'compressEn',
              value: compressEnStats
                ? `圧縮: ${compressEnStats.compressed}/${compressEnStats.violating}件`
                : '',
              sub: compressEnStats
                ? [
                    compressEnStats.skippedLowCps > 0 ? `低CPS スキップ: ${compressEnStats.skippedLowCps}件` : '',
                    compressEnStats.flagged > 0 ? `フラグ: ${compressEnStats.flagged}件` : '',
                  ].filter(Boolean).join(' / ')
                : '',
              color: compressEnStats?.flagged ? '#f59e0b' : '',
            },
            {
              label: 'splitEn',
              value: `${splitEnOutput.length}ブロック`,
              sub: violations.length > 0 ? `CPS違反: ${violations.length}件` : 'CPS OK',
              color: violations.length > 0 ? '#ef4444' : '#22c55e',
            },
          ].map(row => (
            <div key={row.label} style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 11, marginBottom: 3 }}>
              <span style={{ color: theme.textMuted, minWidth: 90 }}>{row.label}</span>
              {row.value && <span style={{ color: theme.textSecondary }}>{row.value}</span>}
              {row.sub && <span style={{ color: row.color || theme.textMuted, fontSize: 10 }}>{row.sub}</span>}
            </div>
          ))}

          {/* CPS 違反ブロック一覧 */}
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

// ── メインコンポーネント ──────────────────────────────────────────────────

type Filter = 'all' | 'error' | 'cps' | 'correct' | 'translate'

export function ExecutionLogTab({ log }: ExecutionLogTabProps) {
  const { theme } = useTheme()
  const [expandedAttempts, setExpandedAttempts] = useState<Set<number>>(new Set([1]))
  const [showTraces, setShowTraces] = useState(false)
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

  const flaggedCorrections = log.correctJaOutput.filter(s => s.correctionFlagged)

  // finalQA 違反サマリー
  const violationSummary: Record<string, number> = {}
  log.finalBlocks.forEach(b =>
    (b.qaViolations ?? []).forEach(v => {
      violationSummary[v.type] = (violationSummary[v.type] ?? 0) + 1
    })
  )
  const totalFlagged = log.finalBlocks.filter(b => b.flagged).length

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

      {/* ── ノードトレース タイムライン ── */}
      {(filter === 'all') && (
        <div style={{ marginBottom: 10 }}>
          <button
            onClick={() => setShowTraces(t => !t)}
            style={{
              width: '100%', textAlign: 'left',
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '6px 10px',
              background: theme.cardBg,
              border: `1px solid ${theme.panelBorder}`,
              borderRadius: showTraces ? '6px 6px 0 0' : 6,
              cursor: 'pointer', fontSize: 11,
            }}
          >
            {showTraces
              ? <ChevronDown size={12} color={theme.textMuted} />
              : <ChevronRight size={12} color={theme.textMuted} />}
            <span style={{ fontWeight: 700, color: theme.textPrimary }}>全ノードトレース</span>
            <span style={{ color: theme.textMuted }}>{log.nodeTraces.length}件</span>
            <span style={{ color: theme.textSecondary, marginLeft: 'auto' }}>
              合計 {formatMs(log.finishedAt - log.startedAt)}
            </span>
          </button>
          {showTraces && (
            <div style={{
              padding: '6px 10px',
              background: theme.panelBg,
              border: `1px solid ${theme.panelBorder}`,
              borderTop: 'none',
              borderRadius: '0 0 6px 6px',
            }}>
              {log.nodeTraces.map((t, i) => (
                <NodeTraceLine key={i} trace={t} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── transcribe ── */}
      {(filter === 'all') && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 11, marginBottom: 6, padding: '6px 10px', background: theme.cardBg, borderRadius: 6, border: `1px solid ${theme.panelBorder}` }}>
          <CheckCircle size={12} color='#22c55e' />
          <span style={{ color: theme.textMuted, minWidth: 80 }}>transcribe</span>
          <span style={{ color: theme.textSecondary }}>{log.transcribeOutput.length}セグメント</span>
        </div>
      )}

      {/* ── correctJa ── */}
      {(filter === 'all' || filter === 'correct' || (filter === 'error' && flaggedCorrections.length > 0)) && (
        <div style={{ marginBottom: 6, padding: '6px 10px', background: theme.cardBg, borderRadius: 6, border: `1px solid ${theme.panelBorder}`, fontSize: 11 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {flaggedCorrections.length > 0
              ? <AlertTriangle size={12} color='#f59e0b' />
              : <CheckCircle size={12} color='#22c55e' />}
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

      {/* ── CPSループ 各attempt ── */}
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

      {/* ── splitLongBlock ── */}
      {(filter === 'all' || filter === 'cps') && log.splitLongBlockStats && (
        <div style={{ marginBottom: 6, padding: '6px 10px', background: theme.cardBg, borderRadius: 6, border: `1px solid ${theme.panelBorder}`, fontSize: 11 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {log.splitLongBlockStats.longSegments > 0
              ? <AlertTriangle size={12} color='#f97316' />
              : <CheckCircle size={12} color='#22c55e' />}
            <span style={{ color: theme.textMuted, minWidth: 80 }}>splitLongBlock</span>
            <span style={{ color: theme.textSecondary }}>{log.splitLongBlockStats.total}ブロック入力</span>
            {log.splitLongBlockStats.longSegments > 0 ? (
              <>
                <span style={{ color: '#f97316' }}>long_segment: {log.splitLongBlockStats.longSegments}件</span>
                <span style={{ color: '#22c55e', marginLeft: 4 }}>分割: {log.splitLongBlockStats.splitBlocks}件 → +{log.splitLongBlockStats.newBlocks}ブロック</span>
                {log.splitLongBlockStats.skipped > 0 && (
                  <span style={{ color: theme.textMuted }}>「、」なし スキップ: {log.splitLongBlockStats.skipped}件</span>
                )}
              </>
            ) : (
              <span style={{ color: '#22c55e' }}>long_segment なし</span>
            )}
          </div>
        </div>
      )}

      {/* ── finalQA サマリー ── */}
      {(filter === 'all' || filter === 'error') && (
        <div style={{ marginBottom: 6, padding: '6px 10px', background: theme.cardBg, borderRadius: 6, border: `1px solid ${theme.panelBorder}`, fontSize: 11 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}>
            {totalFlagged > 0
              ? <AlertCircle size={12} color='#ef4444' />
              : <CheckCircle size={12} color='#22c55e' />}
            <span style={{ color: theme.textMuted, minWidth: 80 }}>finalQA</span>
            <span style={{ color: theme.textSecondary }}>
              {log.finalBlocks.length}ブロック
            </span>
            {totalFlagged > 0 && (
              <span style={{ color: '#ef4444' }}>フラグ: {totalFlagged}件</span>
            )}
          </div>
          {Object.keys(violationSummary).length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, paddingLeft: 20 }}>
              {Object.entries(violationSummary).map(([type, count]) => {
                const isP1 = type === 'cps' || type === 'lineLength'
                const isLow = type === 'cpsTooLow'
                return (
                  <span key={type} style={{
                    fontSize: 10,
                    padding: '2px 6px',
                    borderRadius: 4,
                    background: isP1 ? 'rgba(239,68,68,0.1)' : isLow ? 'rgba(96,165,250,0.1)' : 'rgba(245,158,11,0.1)',
                    border: `1px solid ${isP1 ? 'rgba(239,68,68,0.3)' : isLow ? 'rgba(96,165,250,0.3)' : 'rgba(245,158,11,0.3)'}`,
                    color: isP1 ? '#ef4444' : isLow ? '#60a5fa' : '#f59e0b',
                  }}>
                    {type}: {count}
                  </span>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* ── exportSrt ── */}
      {(filter === 'all') && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 11, padding: '6px 10px', background: theme.cardBg, borderRadius: 6, border: `1px solid ${theme.panelBorder}` }}>
          <CheckCircle size={12} color='#22c55e' />
          <span style={{ color: theme.textMuted, minWidth: 80 }}>exportSrt</span>
          <span style={{ color: theme.textSecondary }}>最終ブロック: {log.finalBlocks.length}件</span>
        </div>
      )}
    </div>
  )
}
