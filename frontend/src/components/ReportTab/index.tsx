import type { PipelineRunResult } from '@/types/pipeline'
import { useTheme } from '@/context/ThemeContext'
import { useLocale } from '@/context/LocaleContext'

interface ReportTabProps {
  runs: PipelineRunResult[]
}

function formatFinishedAt(ts?: number): string {
  if (!ts) return '-'
  return new Date(ts).toLocaleString()
}

export function ReportTab({ runs }: ReportTabProps) {
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

  const statusLabel = (status: PipelineRunResult['status']) => {
    if (status === 'success') return t.reportStatusSuccess
    if (status === 'error') return t.reportStatusError
    if (status === 'running') return t.reportStatusRunning
    return t.reportStatusIdle
  }

  return (
    <div className="h-full overflow-y-auto" style={{ padding: 10 }}>
      <div style={{
        border: `1px solid ${theme.panelBorder}`,
        borderRadius: 8,
        background: theme.cardBg,
        padding: '10px 12px',
        marginBottom: 10,
      }}>
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

      <div style={{
        border: `1px solid ${theme.panelBorder}`,
        borderRadius: 8,
        background: theme.cardBg,
        padding: '10px 12px',
      }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: theme.textPrimary, marginBottom: 8 }}>
          {t.reportRecentRuns}
        </div>

        {runs.length === 0 ? (
          <div style={{ fontSize: 12, color: theme.textMuted }}>
            {t.reportEmpty}
          </div>
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
                  <th style={{ textAlign: 'left', padding: '6px 4px' }}>{t.reportColQuality}</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run, idx) => (
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
                    <td style={{ padding: '6px 4px', color: theme.textSecondary }}>
                      {run.metrics
                        ? `CPS ${(run.metrics.quality.cpsViolationRate * 100).toFixed(1)}% / 42字 ${(run.metrics.quality.overLengthRate * 100).toFixed(1)}%`
                        : '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
