import { Play } from 'lucide-react'
import type { PipelineReviewItem, PipelineRunResult } from '@/types/pipeline'
import { useTheme } from '@/context/ThemeContext'
import { useLocale } from '@/context/LocaleContext'

interface ReportTabProps {
  runs: PipelineRunResult[]
  pipelineRun: PipelineRunResult
  videoSourceName: string | null
  onRunPipeline: () => void
  maxCharsPerLine: number
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

function categoryLabel(category: PipelineReviewItem['category']): string {
  if (category === 'timing') return '時間'
  if (category === 'readability') return '速度'
  if (category === 'line_length') return '行長'
  if (category === 'content') return '内容'
  if (category === 'terminology') return '用語'
  return 'その他'
}

function dispositionLabel(disposition: PipelineReviewItem['disposition']): string {
  if (disposition === 'manual_review') return '手動確認'
  if (disposition === 'proposed') return '修正提案'
  if (disposition === 'auto_applied') return '自動修正済み'
  return '問題なし'
}

function proposalKindLabel(kind: NonNullable<PipelineReviewItem['proposal']>['kind']): string {
  if (kind === 'replace_text') return '英文短縮'
  if (kind === 'split_block') return '分割'
  if (kind === 'merge_window') return '前後結合'
  if (kind === 'retime') return '時刻調整'
  return '用語確認'
}

function attemptLabel(attempt: NonNullable<PipelineReviewItem['attempts']>[number]): string {
  const result = attempt.changed ? '適用' : '不採用'
  const delta = attempt.beforeChars - attempt.afterChars
  const deltaText = delta !== 0 ? ` / ${delta > 0 ? '-' : '+'}${Math.abs(delta)}字` : ''
  return `${attempt.strategy}: ${result}${deltaText} / ${attempt.beforeViolation} → ${attempt.afterViolation}`
}

type ReportAttempt = NonNullable<PipelineReviewItem['attempts']>[number]

function hasAttemptTextFlow(attempt: ReportAttempt): boolean {
  return Boolean(
    attempt.beforeTranscriptText ||
    attempt.beforeSubtitleText ||
    attempt.afterTranscriptText ||
    attempt.afterSubtitleText,
  )
}

function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

export function ReportTab({ runs, pipelineRun, videoSourceName, onRunPipeline, maxCharsPerLine }: ReportTabProps) {
  const { theme } = useTheme()
  const { strings: t } = useLocale()
  const isRunning = pipelineRun.status === 'queued' || pipelineRun.status === 'running'

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

  const latestAudit = pipelineRun.audit ?? runs.find(r => r.audit)?.audit
  const latestRunWithLogs = pipelineRun.debug || pipelineRun.audit
    ? pipelineRun
    : runs.find(r => r.debug || r.audit)
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
    if (status === 'queued') return '待機中'
    if (status === 'running') return t.reportStatusRunning
    return t.reportStatusIdle
  }

  return (
    <div className="h-full overflow-y-auto" style={{ padding: 10 }}>
      {/* パイプライン実行パネル */}
      <div style={{
        border: `1px solid ${theme.panelBorder}`,
        borderRadius: 8,
        background: theme.cardBg,
        padding: '10px 12px',
        marginBottom: 10,
      }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: theme.textPrimary, marginBottom: 8 }}>
          パイプライン実行
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <button
            onClick={onRunPipeline}
            disabled={isRunning || !videoSourceName}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 12,
              fontWeight: 600,
              padding: '6px 14px',
              borderRadius: 6,
              border: 'none',
              background: isRunning || !videoSourceName ? theme.textDisabled : theme.accent,
              color: '#fff',
              cursor: isRunning || !videoSourceName ? 'not-allowed' : 'pointer',
              opacity: isRunning || !videoSourceName ? 0.6 : 1,
            }}
          >
            <Play size={11} />
            {isRunning ? '実行中...' : 'パイプラインを実行'}
          </button>
          <span style={{ fontSize: 11, color: theme.textSecondary }}>
            {videoSourceName ? `対象: ${videoSourceName}` : '動画プレイヤーに動画を読み込んでください'}
          </span>
        </div>

        {/* 現在の実行状態 */}
        {pipelineRun.status !== 'idle' && (
          <div style={{ marginTop: 8, fontSize: 11 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{
                display: 'inline-block',
                width: 7,
                height: 7,
                borderRadius: 999,
                background:
                  pipelineRun.status === 'queued' || pipelineRun.status === 'running' ? '#f59e0b'
                  : pipelineRun.status === 'success' ? '#22c55e'
                  : '#ef4444',
              }} />
              <span style={{ color: theme.textSecondary, fontWeight: 600 }}>
                {pipelineRun.status === 'queued' ? '待機中'
                  : pipelineRun.status === 'running' ? '実行中'
                  : pipelineRun.status === 'success' ? '完了'
                  : '失敗'}
              </span>
              <span style={{ color: theme.textMuted }}>{pipelineRun.message}</span>
            </div>
            {pipelineRun.runId && (
              <div style={{ marginTop: 4, fontSize: 10, color: theme.textSecondary }}>
                job_id: <code style={{ fontFamily: 'ui-monospace, SFMono-Regular, monospace' }}>{pipelineRun.runId}</code>
              </div>
            )}
            {pipelineRun.metrics && (
              <div style={{ marginTop: 4, display: 'flex', flexWrap: 'wrap', gap: 10, fontSize: 10, color: theme.textSecondary }}>
                <span>CPS違反率: {(pipelineRun.metrics.quality.cpsViolationRate * 100).toFixed(1)}%</span>
                <span>{maxCharsPerLine}文字超過率: {(pipelineRun.metrics.quality.overLengthRate * 100).toFixed(1)}%</span>
                <span>推定コスト: ${pipelineRun.metrics.cost.estimatedUsd.toFixed(6)}</span>
                <span>処理時間: {(pipelineRun.metrics.cost.durationMs / 1000).toFixed(2)}s</span>
              </div>
            )}
          </div>
        )}
      </div>

      <div style={{
        border: `1px solid ${theme.panelBorder}`,
        borderRadius: 8,
        background: theme.cardBg,
        padding: '10px 12px',
        marginBottom: 10,
      }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: theme.textPrimary, marginBottom: 8 }}>
          処理ログ
        </div>

        {!latestRunWithLogs ? (
          <div style={{ fontSize: 12, color: theme.textMuted }}>
            パイプライン実行後に、各モジュールの処理ログを確認できます。
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 8, fontSize: 11 }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, color: theme.textSecondary }}>
              <span>状態: {statusLabel(latestRunWithLogs.status)}</span>
              <span>step: {latestRunWithLogs.step}</span>
              {latestRunWithLogs.runId && <span>job_id: {latestRunWithLogs.runId}</span>}
              {latestRunWithLogs.finishedAt && <span>完了: {formatFinishedAt(latestRunWithLogs.finishedAt)}</span>}
            </div>

            <details>
              <summary style={{ cursor: 'pointer', color: theme.textPrimary, fontWeight: 700 }}>
                モジュール別ログ
              </summary>
              <div style={{ display: 'grid', gap: 6, marginTop: 8 }}>
                {(latestRunWithLogs.audit?.nodeTraces ?? []).length === 0 ? (
                  <div style={{ color: theme.textMuted }}>node trace はありません。</div>
                ) : (
                  latestRunWithLogs.audit!.nodeTraces.map((trace, index) => (
                    <div
                      key={`${trace.nodeId}-${index}`}
                      style={{
                        border: `1px solid ${theme.panelBorder}`,
                        borderRadius: 6,
                        padding: '6px 8px',
                        background: theme.panelBg,
                        color: theme.textSecondary,
                      }}
                    >
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, color: theme.textPrimary, fontWeight: 700 }}>
                        <span>{trace.nodeId}</span>
                        <span style={{ color: trace.status === 'success' ? '#22c55e' : '#ef4444' }}>
                          {trace.status === 'success' ? '成功' : '失敗'}
                        </span>
                        <span>{formatDurationMs(trace.durationMs)}</span>
                      </div>
                      <div style={{ marginTop: 3 }}>
                        provider: {trace.provider} / model: {trace.model} / attempt: {trace.attempt}
                      </div>
                      {trace.summary && (
                        <div style={{ marginTop: 3, color: theme.textMuted, whiteSpace: 'pre-wrap' }}>
                          {trace.summary}
                        </div>
                      )}
                    </div>
                  ))
                )}
              </div>
            </details>

            <details>
              <summary style={{ cursor: 'pointer', color: theme.textPrimary, fontWeight: 700 }}>
                進行イベント
              </summary>
              <div style={{ display: 'grid', gap: 4, marginTop: 8, color: theme.textSecondary }}>
                {(latestRunWithLogs.debug?.progressEvents ?? []).length === 0 ? (
                  <div style={{ color: theme.textMuted }}>progress event はありません。</div>
                ) : (
                  latestRunWithLogs.debug!.progressEvents.map((event, index) => (
                    <div
                      key={`${event.at}-${index}`}
                      style={{
                        borderBottom: `1px solid ${theme.panelBorder}`,
                        paddingBottom: 4,
                      }}
                    >
                      <span style={{ color: theme.textMuted }}>{new Date(event.at).toLocaleTimeString()}</span>
                      <span style={{ marginLeft: 8, color: theme.textPrimary }}>{event.step}</span>
                      <span style={{ marginLeft: 8 }}>{event.message}</span>
                      {event.currentNode && <span style={{ marginLeft: 8, color: theme.textMuted }}>node: {event.currentNode}</span>}
                    </div>
                  ))
                )}
              </div>
            </details>

            <details>
              <summary style={{ cursor: 'pointer', color: theme.textPrimary, fontWeight: 700 }}>
                設定スナップショット
              </summary>
              <pre style={{
                margin: '8px 0 0',
                padding: 8,
                borderRadius: 6,
                background: theme.panelBg,
                color: theme.textSecondary,
                overflowX: 'auto',
                fontSize: 10,
              }}>
                {JSON.stringify(latestRunWithLogs.debug?.settingsSnapshot ?? {}, null, 2)}
              </pre>
            </details>
          </div>
        )}
      </div>

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
        marginBottom: 10,
      }}>
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
                    <span style={{ color: theme.textSecondary, fontWeight: 700 }}>
                      {dispositionLabel(item.disposition)}
                    </span>
                    <span style={{ color: theme.textPrimary }}>{item.nodeId}</span>
                    <span style={{ color: theme.textMuted }}>score: {item.score.toFixed(2)}</span>
                    {item.blockId !== undefined && <span style={{ color: theme.textMuted }}>block: {item.blockId}</span>}
                  </div>
                  <div style={{ color: theme.textPrimary, fontWeight: 600 }}>
                    {item.title ?? item.reason}
                  </div>
                  {item.action && (
                    <div style={{ marginTop: 2 }}>
                      {item.action}
                    </div>
                  )}
                  {item.details && item.details.length > 0 && (
                    <div style={{ marginTop: 3, color: theme.textMuted }}>
                      {item.details.join(' / ')}
                    </div>
                  )}
                  {item.proposal && (
                    <div style={{ marginTop: 3, color: theme.textSecondary }}>
                      提案: {proposalKindLabel(item.proposal.kind)} / 信頼度 {(item.proposal.confidence * 100).toFixed(0)}% / {item.proposal.rationale}
                    </div>
                  )}
                  {item.attempts && item.attempts.length > 0 && (
                    <div style={{ marginTop: 6, display: 'grid', gap: 5 }}>
                      <div style={{ color: theme.textMuted, fontWeight: 700 }}>このブロックの自動処理履歴</div>
                      {item.attempts.slice(-3).map((attempt, attemptIndex) => (
                        <div
                          key={`${attempt.strategy}-${attemptIndex}`}
                          style={{
                            border: `1px solid ${theme.panelBorder}`,
                            borderRadius: 6,
                            background: theme.cardBg,
                            padding: '6px 8px',
                            display: 'grid',
                            gap: 4,
                          }}
                        >
                          <div style={{ color: theme.textSecondary, fontWeight: 700 }}>
                            {attemptLabel(attempt)}
                          </div>
                          {hasAttemptTextFlow(attempt) && (
                            <div style={{ display: 'grid', gap: 3, color: theme.textMuted }}>
                              {(attempt.beforeTranscriptText || attempt.afterTranscriptText) && (
                                <div style={{ display: 'grid', gridTemplateColumns: '64px 1fr', gap: 6 }}>
                                  <span style={{ fontWeight: 700 }}>書き起こし</span>
                                  <span style={{ color: theme.textSecondary, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                                    {attempt.beforeTranscriptText || '（なし）'}
                                    {attempt.afterTranscriptText && attempt.afterTranscriptText !== attempt.beforeTranscriptText
                                      ? `\n→ ${attempt.afterTranscriptText}`
                                      : ''}
                                  </span>
                                </div>
                              )}
                              {(attempt.beforeSubtitleText || attempt.afterSubtitleText) && (
                                <div style={{ display: 'grid', gridTemplateColumns: '64px 1fr', gap: 6 }}>
                                  <span style={{ fontWeight: 700 }}>字幕</span>
                                  <span style={{ color: theme.textSecondary, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                                    {attempt.beforeSubtitleText || '（なし）'}
                                    {attempt.afterSubtitleText && attempt.afterSubtitleText !== attempt.beforeSubtitleText
                                      ? `\n→ ${attempt.afterSubtitleText}`
                                      : ''}
                                  </span>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                  {item.category && (
                    <div style={{ marginTop: 3, color: theme.textMuted }}>
                      {categoryLabel(item.category)}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
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
                        ? `CPS ${(run.metrics.quality.cpsViolationRate * 100).toFixed(1)}% / ${maxCharsPerLine}字 ${(run.metrics.quality.overLengthRate * 100).toFixed(1)}%`
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
