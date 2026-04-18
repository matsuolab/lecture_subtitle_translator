import type { PipelineReviewItem, PipelineRunResult } from '@/types/pipeline'
import type { DiagnosticPattern } from '@/lib/pipeline/types'
import { useTheme } from '@/context/ThemeContext'
import { useLocale } from '@/context/LocaleContext'

interface SummaryTabProps {
  runs: PipelineRunResult[]
  pipelineRun: PipelineRunResult
  onRerunFromTranscript?: (run: PipelineRunResult) => void
}

function formatFinishedAt(ts?: number): string {
  if (!ts) return '-'
  return new Date(ts).toLocaleString()
}

function priorityBadge(priority: PipelineReviewItem['priority']): string {
  if (priority === 'must_review') return 'MUST'
  if (priority === 'should_review') return 'SHOULD'
  return 'AUTO'
}

// DiagnosticPattern の表示設定
const PATTERN_META: Record<DiagnosticPattern, { label: string; color: string; fix: string }> = {
  ok:               { label: '問題なし',         color: '#22c55e', fix: '—' },
  verbose_en:       { label: '英訳冗長',          color: '#f97316', fix: 'compressEn' },
  over_compressed:  { label: '過剰圧縮',          color: '#ef4444', fix: 'expandEn' },
  long_segment:     { label: '長発話',            color: '#60a5fa', fix: 'splitLongBlock' },
  slow_speech:      { label: 'ゆっくり発話',       color: '#6ee7b7', fix: '対処不要' },
  short_duration:   { label: '分割しすぎ',        color: '#f59e0b', fix: 'mergeShort' },
  merged_long:      { label: 'マージ後長ブロック', color: '#34d399', fix: 'フラグのみ' },
  line_length_only: { label: '行長のみ',          color: '#94a3b8', fix: 'compressEn' },
  proportional_ts:  { label: 'TS推定値',          color: '#a78bfa', fix: '手動確認' },
}

const PATTERN_ORDER: DiagnosticPattern[] = [
  'ok', 'verbose_en', 'over_compressed', 'long_segment', 'slow_speech',
  'short_duration', 'merged_long', 'line_length_only', 'proportional_ts',
]

export function SummaryTab({ runs, pipelineRun, onRerunFromTranscript }: SummaryTabProps) {
  const { theme } = useTheme()
  const { strings: t } = useLocale()

  const successRuns = runs.filter(r => r.status === 'success')
  const measuredRuns = runs.filter(r => r.metrics)

  const totalRuns = runs.length
  const successRate = totalRuns > 0 ? successRuns.length / totalRuns : 0
  const avgCost = measuredRuns.length > 0
    ? measuredRuns.reduce((sum, r) => sum + (r.metrics?.cost.estimatedUsd ?? 0), 0) / measuredRuns.length
    : 0
  const avgDurationSec = measuredRuns.length > 0
    ? measuredRuns.reduce((sum, r) => sum + (r.metrics?.cost.durationMs ?? 0), 0) / measuredRuns.length / 1000
    : 0

  const latestAudit = runs.find(r => r.audit)?.audit
  const topReviewItems = latestAudit
    ? [...latestAudit.reviewItems]
      .sort((a, b) => {
        const weight = (p: PipelineReviewItem['priority']) => (p === 'must_review' ? 3 : p === 'should_review' ? 2 : 1)
        return weight(b.priority) - weight(a.priority)
      })
      .slice(0, 8)
    : []

  const statusLabel = (status: PipelineRunResult['status']) => {
    if (status === 'success') return t.reportStatusSuccess
    if (status === 'error') return t.reportStatusError
    if (status === 'running') return t.reportStatusRunning
    return t.reportStatusIdle
  }

  // 最新ログから DiagnosticPattern 分布を計算
  const latestLog = pipelineRun.log ?? runs.find(r => r.log)?.log
  const diagCounts = latestLog
    ? latestLog.finalBlocks.reduce<Record<string, number>>((acc, b) => {
        const p = b.diagPattern ?? 'ok'
        acc[p] = (acc[p] ?? 0) + 1
        return acc
      }, {})
    : null
  const totalBlocks = latestLog?.finalBlocks.length ?? 0
  const flaggedBlocks = latestLog?.finalBlocks.filter(b => b.flagged).length ?? 0

  const card: React.CSSProperties = {
    border: `1px solid ${theme.panelBorder}`,
    borderRadius: 8,
    background: theme.cardBg,
    padding: '10px 12px',
    marginBottom: 10,
  }

  return (
    <>
      {/* ── 診断パターン分布（最新実行） ── */}
      {diagCounts && (
        <div style={card}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 8 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: theme.textPrimary }}>
              診断パターン分布
            </div>
            <div style={{ fontSize: 10, color: theme.textMuted }}>
              {totalBlocks}ブロック / 要確認: {flaggedBlocks}件（{totalBlocks > 0 ? ((flaggedBlocks / totalBlocks) * 100).toFixed(1) : 0}%）
            </div>
          </div>

          {/* パターンバー */}
          <div style={{ display: 'flex', height: 8, borderRadius: 4, overflow: 'hidden', marginBottom: 10, gap: 1 }}>
            {PATTERN_ORDER.map(p => {
              const count = diagCounts[p] ?? 0
              if (count === 0) return null
              const meta = PATTERN_META[p]
              return (
                <div
                  key={p}
                  title={`${meta.label}: ${count}件`}
                  style={{
                    flex: count,
                    background: meta.color,
                    opacity: 0.85,
                  }}
                />
              )
            })}
          </div>

          {/* パターンテーブル */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr auto auto auto', gap: '2px 8px', fontSize: 10, alignItems: 'center' }}>
            {/* ヘッダー */}
            <span style={{ color: theme.textMuted, fontWeight: 700 }}>パターン</span>
            <span style={{ color: theme.textMuted, fontWeight: 700, textAlign: 'right' }}>件数</span>
            <span style={{ color: theme.textMuted, fontWeight: 700, textAlign: 'right' }}>%</span>
            <span style={{ color: theme.textMuted, fontWeight: 700 }}>自動対処</span>
            {/* データ行 */}
            {PATTERN_ORDER.map(p => {
              const count = diagCounts[p] ?? 0
              if (count === 0 && p === 'ok') return null  // ok が 0 なら表示不要
              const meta = PATTERN_META[p]
              const pct = totalBlocks > 0 ? ((count / totalBlocks) * 100).toFixed(1) : '0.0'
              return (
                <>
                  <span key={`${p}-label`} style={{
                    color: count > 0 ? meta.color : theme.textMuted,
                    display: 'flex', alignItems: 'center', gap: 4,
                  }}>
                    <span style={{
                      display: 'inline-block', width: 7, height: 7,
                      borderRadius: 2, background: meta.color, opacity: count > 0 ? 0.9 : 0.3,
                      flexShrink: 0,
                    }} />
                    {meta.label}
                  </span>
                  <span key={`${p}-count`} style={{
                    color: count > 0 ? theme.textPrimary : theme.textMuted,
                    fontWeight: count > 0 ? 700 : 400,
                    textAlign: 'right',
                    fontFamily: 'monospace',
                  }}>{count}</span>
                  <span key={`${p}-pct`} style={{
                    color: theme.textMuted,
                    textAlign: 'right',
                    fontFamily: 'monospace',
                  }}>{pct}%</span>
                  <span key={`${p}-fix`} style={{ color: theme.textMuted }}>
                    {meta.fix}
                  </span>
                </>
              )
            })}
          </div>

          {/* splitLongBlock 統計（あれば） */}
          {latestLog?.splitLongBlockStats && latestLog.splitLongBlockStats.longSegments > 0 && (
            <div style={{
              marginTop: 8, padding: '4px 8px',
              background: 'rgba(96,165,250,0.08)',
              border: '1px solid rgba(96,165,250,0.2)',
              borderRadius: 4, fontSize: 10, color: '#60a5fa',
            }}>
              splitLongBlock: {latestLog.splitLongBlockStats.splitBlocks}/{latestLog.splitLongBlockStats.longSegments}件 分割
              → +{latestLog.splitLongBlockStats.newBlocks}ブロック生成
              {latestLog.splitLongBlockStats.skipped > 0 &&
                `  /  「、」なし スキップ: ${latestLog.splitLongBlockStats.skipped}件`}
            </div>
          )}
        </div>
      )}

      {/* ── 統計サマリー ── */}
      <div style={card}>
        <div style={{ fontSize: 12, fontWeight: 700, color: theme.textPrimary, marginBottom: 8 }}>
          {t.reportSummary}
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, fontSize: 11, color: theme.textSecondary }}>
          <span>{t.reportTotalRuns}: {totalRuns}</span>
          <span>{t.reportSuccessRate}: {(successRate * 100).toFixed(1)}%</span>
          <span>{t.reportAvgCost}: ${avgCost.toFixed(6)}</span>
          <span>{t.reportAvgDuration}: {avgDurationSec.toFixed(2)}s</span>
        </div>
      </div>

      {/* ── レビューキュー ── */}
      <div style={card}>
        <div style={{ fontSize: 12, fontWeight: 700, color: theme.textPrimary, marginBottom: 8 }}>
          {t.reportReviewQueue}
        </div>
        {!latestAudit ? (
          <div style={{ fontSize: 12, color: theme.textMuted }}>{t.reportReviewQueueEmpty}</div>
        ) : (
          <>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 8, fontSize: 11, color: theme.textSecondary }}>
              <span>MUST: {latestAudit.mustReviewCount}</span>
              <span>SHOULD: {latestAudit.shouldReviewCount}</span>
              <span>AUTO: {latestAudit.autoPassCount}</span>
              <span>{t.reportNodeTraceCount(latestAudit.nodeTraces.length)}</span>
            </div>
            <div style={{ display: 'grid', gap: 6 }}>
              {topReviewItems.map(item => (
                <div
                  key={item.id}
                  style={{
                    border: `1px solid ${theme.panelBorder}`,
                    borderRadius: 6,
                    padding: '6px 8px',
                    background: theme.panelBg,
                    fontSize: 11,
                    color: theme.textSecondary,
                  }}
                >
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 2 }}>
                    <span style={{ fontWeight: 700, color: item.priority === 'must_review' ? '#ef4444' : item.priority === 'should_review' ? '#f59e0b' : '#22c55e' }}>
                      {priorityBadge(item.priority)}
                    </span>
                    <span style={{ color: theme.textPrimary }}>{item.nodeId}</span>
                    <span style={{ color: theme.textMuted }}>score: {item.score.toFixed(2)}</span>
                    {item.blockId !== undefined && <span style={{ color: theme.textMuted }}>block: {item.blockId}</span>}
                  </div>
                  <div>{item.reason}</div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {/* ── 実行履歴 ── */}
      <div style={{ ...card, marginBottom: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: theme.textPrimary, marginBottom: 8 }}>
          {t.reportRecentRuns}
        </div>
        {runs.length === 0 ? (
          <div style={{ fontSize: 12, color: theme.textMuted }}>{t.reportEmpty}</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
              <thead>
                <tr style={{ color: theme.textMuted, borderBottom: `1px solid ${theme.panelBorder}` }}>
                  <th style={{ textAlign: 'left', padding: '6px 4px' }}>{t.reportColSource}</th>
                  <th style={{ textAlign: 'left', padding: '6px 4px' }}>{t.reportColStatus}</th>
                  <th style={{ textAlign: 'left', padding: '6px 4px' }}>{t.reportColFinishedAt}</th>
                  <th style={{ textAlign: 'left', padding: '6px 4px' }}>{t.reportColCost}</th>
                  <th style={{ textAlign: 'left', padding: '6px 4px' }}>{t.reportColDuration}</th>
                  <th style={{ textAlign: 'left', padding: '6px 4px' }}>要確認</th>
                  {onRerunFromTranscript && <th style={{ textAlign: 'left', padding: '6px 4px' }}>再実行</th>}
                </tr>
              </thead>
              <tbody>
                {runs.map((run, idx) => {
                  const flagged = run.log?.finalBlocks.filter(b => b.flagged).length
                  const total   = run.log?.finalBlocks.length
                  return (
                    <tr key={`${run.startedAt ?? 0}-${idx}`} style={{ borderBottom: `1px solid ${theme.panelBorder}` }}>
                      <td style={{ padding: '6px 4px', color: theme.textPrimary }}>{run.sourceName ?? '-'}</td>
                      <td style={{ padding: '6px 4px', color: theme.textSecondary }}>{statusLabel(run.status)}</td>
                      <td style={{ padding: '6px 4px', color: theme.textSecondary }}>{formatFinishedAt(run.finishedAt)}</td>
                      <td style={{ padding: '6px 4px', color: theme.textSecondary }}>
                        {run.metrics ? `$${run.metrics.cost.estimatedUsd.toFixed(6)}` : '-'}
                      </td>
                      <td style={{ padding: '6px 4px', color: theme.textSecondary }}>
                        {run.metrics ? `${(run.metrics.cost.durationMs / 1000).toFixed(2)}s` : '-'}
                      </td>
                      <td style={{ padding: '6px 4px', color: flagged && flagged > 0 ? '#f59e0b' : theme.textSecondary }}>
                        {total != null ? `${flagged}/${total}件` : '-'}
                      </td>
                      {onRerunFromTranscript && (
                        <td style={{ padding: '6px 4px' }}>
                          {run.log?.transcribeOutput && run.log.transcribeOutput.length > 0 ? (
                            <button
                              onClick={() => onRerunFromTranscript(run)}
                              title="WhisperXをスキップしてcorrectJa以降を再実行"
                              style={{
                                fontSize: 10,
                                padding: '2px 8px',
                                borderRadius: 4,
                                border: `1px solid ${theme.panelBorder}`,
                                background: theme.panelBg,
                                color: theme.textSecondary,
                                cursor: 'pointer',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              ▶ 書き起こし再利用
                            </button>
                          ) : (
                            <span style={{ color: theme.textDisabled, fontSize: 10 }}>-</span>
                          )}
                        </td>
                      )}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  )
}
