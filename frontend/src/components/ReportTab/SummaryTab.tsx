import type { PipelineReviewItem, PipelineRunResult } from '@/types/pipeline'
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

  const card: React.CSSProperties = {
    border: `1px solid ${theme.panelBorder}`,
    borderRadius: 8,
    background: theme.cardBg,
    padding: '10px 12px',
    marginBottom: 10,
  }

  return (
    <>
      {/* 現在の実行状態 */}
      {pipelineRun.status !== 'idle' && (
        <div style={card}>
          <div style={{ fontSize: 12, fontWeight: 700, color: theme.textPrimary, marginBottom: 8 }}>
            直近の実行
          </div>
          <div style={{ fontSize: 11 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{
                display: 'inline-block',
                width: 7,
                height: 7,
                borderRadius: 999,
                background:
                  pipelineRun.status === 'running' ? '#f59e0b'
                  : pipelineRun.status === 'success' ? '#22c55e'
                  : '#ef4444',
              }} />
              <span style={{ color: theme.textSecondary, fontWeight: 600 }}>
                {pipelineRun.status === 'running' ? '実行中'
                  : pipelineRun.status === 'success' ? '完了'
                  : '失敗'}
              </span>
              <span style={{ color: theme.textMuted }}>{pipelineRun.message}</span>
            </div>
            {pipelineRun.metrics && (
              <div style={{ marginTop: 4, display: 'flex', flexWrap: 'wrap', gap: 10, fontSize: 10, color: theme.textSecondary }}>
                <span>CPS違反率: {(pipelineRun.metrics.quality.cpsViolationRate * 100).toFixed(1)}%</span>
                <span>42文字超過率: {(pipelineRun.metrics.quality.overLengthRate * 100).toFixed(1)}%</span>
                <span>推定コスト: ${pipelineRun.metrics.cost.estimatedUsd.toFixed(6)}</span>
                <span>処理時間: {(pipelineRun.metrics.cost.durationMs / 1000).toFixed(2)}s</span>
              </div>
            )}
          </div>
        </div>
      )}

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
                  <th style={{ textAlign: 'left', padding: '6px 4px' }}>{t.reportColQuality}</th>
                  {onRerunFromTranscript && <th style={{ textAlign: 'left', padding: '6px 4px' }}>再実行</th>}
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
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  )
}
