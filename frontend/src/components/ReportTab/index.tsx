import { useState } from 'react'
import { Play, Download } from 'lucide-react'
import type { PipelineRunResult } from '@/types/pipeline'
import { useTheme } from '@/context/ThemeContext'
import { useLocale } from '@/context/LocaleContext'
import { SummaryTab } from './SummaryTab'
import { ExecutionLogTab } from './ExecutionLogTab'
import { BlockDetailTab } from './BlockDetailTab'

interface ReportTabProps {
  runs: PipelineRunResult[]
  pipelineRun: PipelineRunResult
  videoSourceName: string | null
  onRunPipeline: () => void
  onRerunFromTranscript?: (run: PipelineRunResult) => void
}

type SubTab = 'summary' | 'log' | 'block'

function downloadJson(obj: unknown, filename: string): void {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export function ReportTab({ runs, pipelineRun, videoSourceName, onRunPipeline, onRerunFromTranscript }: ReportTabProps) {
  const { theme } = useTheme()
  useLocale() // locale strings は SummaryTab で使用
  const [subTab, setSubTab] = useState<SubTab>('summary')
  const isRunning = pipelineRun.status === 'running'

  // 最新の実行ログ: pipelineRun（直近）を優先、なければ history から
  const latestLog = pipelineRun.log ?? runs.find(r => r.log)?.log

  const subTabs: Array<{ key: SubTab; label: string; disabled?: boolean }> = [
    { key: 'summary', label: '概要' },
    { key: 'log', label: '実行ログ', disabled: !latestLog },
    { key: 'block', label: 'ブロック詳細', disabled: !latestLog },
  ]

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
          {latestLog && (
            <button
              onClick={() => downloadJson(latestLog, `${latestLog.sourceFile}_log.json`)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 5,
                fontSize: 11,
                padding: '4px 10px',
                borderRadius: 6,
                border: `1px solid ${theme.panelBorder}`,
                background: theme.panelBg,
                color: theme.textSecondary,
                cursor: 'pointer',
                marginLeft: 'auto',
              }}
            >
              <Download size={11} />
              ログをエクスポート
            </button>
          )}
        </div>

        {/* 現在の実行状態インライン */}
        {pipelineRun.status !== 'idle' && (
          <div style={{ marginTop: 8, fontSize: 11 }}>
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
        )}
      </div>

      {/* サブタブ切り替え */}
      <div style={{ display: 'flex', gap: 0, marginBottom: 12, borderBottom: `1px solid ${theme.panelBorder}` }}>
        {subTabs.map(tab => (
          <button
            key={tab.key}
            onClick={() => !tab.disabled && setSubTab(tab.key)}
            disabled={tab.disabled}
            style={{
              fontSize: 12,
              fontWeight: subTab === tab.key ? 700 : 400,
              padding: '6px 14px',
              border: 'none',
              borderBottom: subTab === tab.key ? `2px solid ${theme.accent}` : '2px solid transparent',
              background: 'transparent',
              color: tab.disabled ? theme.textDisabled : subTab === tab.key ? theme.accent : theme.textSecondary,
              cursor: tab.disabled ? 'default' : 'pointer',
              marginBottom: -1,
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* タブコンテンツ */}
      {subTab === 'summary' && (
        <SummaryTab runs={runs} pipelineRun={pipelineRun} onRerunFromTranscript={onRerunFromTranscript} />
      )}
      {subTab === 'log' && latestLog && (
        <ExecutionLogTab log={latestLog} />
      )}
      {subTab === 'block' && latestLog && (
        <BlockDetailTab log={latestLog} />
      )}
      {(subTab === 'log' || subTab === 'block') && !latestLog && (
        <div style={{ fontSize: 12, color: theme.textMuted }}>
          パイプラインを実行するとログが表示されます。
        </div>
      )}
    </div>
  )
}
