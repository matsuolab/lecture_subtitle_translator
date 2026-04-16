import { useState, useEffect } from 'react'
import type { PipelineRunLog } from '@/types/pipeline'
import type { JapaneseSentenceBlock, DiagnosticPattern } from '@/lib/pipeline/types'
import { useTheme } from '@/context/ThemeContext'

const DIAG_INFO: Record<DiagnosticPattern, { label: string; color: string; bg: string; desc: string; action: string }> = {
  short_duration: {
    label: '分割しすぎ',
    color: '#f59e0b', bg: 'rgba(245,158,11,0.1)',
    desc: 'duration < 1.5s。splitJaが細かく分割しすぎています。CPS計算が不安定になります。',
    action: 'mergeShortで対処済みのはずですが、残っている場合は手動でマージを検討してください。',
  },
  long_segment: {
    label: '長発話セグメント',
    color: '#60a5fa', bg: 'rgba(96,165,250,0.1)',
    desc: 'duration > 10s かつ CPS < 4。WhisperXが長い息継ぎなし発話を1セグメントとして出力しました。ENテキストが短くなるのは自然です。',
    action: '字幕が長時間表示されます。必要であれば手動でタイムスタンプを分割してください。',
  },
  over_compressed: {
    label: '過剰圧縮',
    color: '#ef4444', bg: 'rgba(239,68,68,0.1)',
    desc: 'EN/JA文字比 < 0.25 かつ CPS < 5。translateEnまたはcompressEnが内容を要約しすぎた可能性があります。',
    action: '英訳を確認し、意味が失われていないか検証してください。必要なら再翻訳を検討。',
  },
  verbose_en: {
    label: '英訳冗長',
    color: '#f97316', bg: 'rgba(249,115,22,0.1)',
    desc: 'CPS > maxCps。英訳が長すぎて読みきれない速度になっています。',
    action: 'compressEnで対処済みのはず。残っている場合は手動で短縮してください。',
  },
  proportional_ts: {
    label: 'TS推定値',
    color: '#a78bfa', bg: 'rgba(167,139,250,0.1)',
    desc: 'word アライメントが失敗し、タイムスタンプはセグメント時間窓の均等配分で推定されています。',
    action: '実際の発話タイミングと合っていない可能性があります。TS を手動確認してください。',
  },
  merged_long: {
    label: 'マージ後長ブロック',
    color: '#34d399', bg: 'rgba(52,211,153,0.1)',
    desc: 'mergeShortで複数文をマージした結果、duration > 7sになりました。',
    action: '字幕が長時間表示されます。内容が自然かどうか確認してください。',
  },
  line_length_only: {
    label: '行長のみ',
    color: '#94a3b8', bg: 'rgba(148,163,184,0.1)',
    desc: '1行がmaxCharsを超えていますが、CPSはOKです。書式のみの問題です。',
    action: 'compressEnで対処済みのはず。残っている場合は手動で改行を調整してください。',
  },
  ok: {
    label: '問題なし',
    color: '#22c55e', bg: 'rgba(34,197,94,0.1)',
    desc: '検出された問題パターンなし。',
    action: '',
  },
}

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

  useEffect(() => {
    if (activeBlockId == null) return
    setQuery(String(activeBlockId))
    setSearched(true)
  }, [activeBlockId])

  const search = () => setSearched(true)

  const normalizedQuery = query.trim().toLowerCase()

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

  const sectionLabel: React.CSSProperties = {
    color: theme.textMuted,
    fontSize: 10,
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    marginBottom: 4,
  }

  const infoRow = (label: string, value: React.ReactNode, highlight?: 'ok' | 'warn' | 'error') => (
    <div style={{ display: 'flex', gap: 6, alignItems: 'baseline', marginBottom: 3 }}>
      <span style={{ color: theme.textMuted, minWidth: 110, flexShrink: 0 }}>{label}</span>
      <span style={{
        color: highlight === 'ok' ? '#22c55e' : highlight === 'warn' ? '#f59e0b' : highlight === 'error' ? '#ef4444' : theme.textPrimary,
        fontWeight: highlight ? 700 : undefined,
        fontFamily: 'monospace',
      }}>{value}</span>
    </div>
  )

  return (
    <div>
      {/* 検索欄 */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <input
          type="text"
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && search()}
          placeholder="ID番号 または ブロックキー (a1s31)"
          style={{
            flex: 1, fontSize: 12, padding: '5px 10px', borderRadius: 6,
            border: `1px solid ${theme.panelBorder}`, background: theme.panelBg,
            color: theme.textPrimary, outline: 'none',
          }}
        />
        <button
          onClick={search}
          style={{
            fontSize: 12, padding: '5px 14px', borderRadius: 6, border: 'none',
            background: theme.accent, color: '#fff', cursor: 'pointer',
          }}
        >
          検索
        </button>
      </div>

      {!searched && (
        <div style={{ fontSize: 11, color: theme.textMuted }}>
          字幕エディタでブロックを選択すると自動で表示されます。
        </div>
      )}

      {searched && matchingFinalBlocks.length === 0 && (
        <div style={{ fontSize: 11, color: theme.textMuted }}>
          ブロックが見つかりません: <strong>{query}</strong>
        </div>
      )}

      {matchingFinalBlocks.map(block => {
        // ── splitJa 出力からこのブロックに対応するものを探す ──
        // blockKey ("a1s42") でマッチ。attempt が違う場合も考慮して全 attempt を検索
        let splitJaBlock: JapaneseSentenceBlock | undefined
        for (const att of log.cpsAttempts) {
          const found = att.splitJaOutput.find(b => b.blockKey === block.blockKey)
          if (found) { splitJaBlock = found; break }
        }

        // ── WhisperX ソースセグメント ──
        const sourceSegs = log.transcribeOutput.filter(s =>
          block.sourceSegmentIds.includes(s.id)
        )

        // ── correctJa 出力（補正テキスト） ──
        const correctedSegs = log.correctJaOutput.filter(s =>
          block.sourceSegmentIds.includes(s.original.id)
        )

        // ── CPS attempt 履歴 ──
        const attemptHistory = log.cpsAttempts.flatMap(att => {
          const atBlock = att.splitEnOutput.find(b =>
            b.blockKey === block.blockKey ||
            (b.id === block.id && b.attempt === att.attempt)
          )
          return atBlock ? [{
            attempt: att.attempt,
            jaText: atBlock.jaText,
            enText: atBlock.text,
            cps: atBlock.cps,
            cpsOk: atBlock.cpsOk,
          }] : []
        })

        return (
          <div key={block.blockKey}>

            {/* ━━ 1. 最終ブロック概要 ━━ */}
            <div style={card}>
              <div style={sectionLabel}>最終ブロック</div>
              {infoRow('ID / Key', `#${block.id}  ${block.blockKey}`)}
              {infoRow('TS (最終)', `${formatTime(block.start)} → ${formatTime(block.end)}  (${(block.end - block.start).toFixed(2)}s)`)}
              {infoRow('CPS', `${block.cps.toFixed(1)}`, block.cpsOk ? 'ok' : 'error')}
              {infoRow('EN', block.text)}
              {infoRow('JA', block.jaText)}

              {/* 数値シグナル */}
              {(() => {
                const dur = block.end - block.start
                const jaChars = block.jaText.replace(/\s/g, '').length
                const enChars = block.charCount
                const ratio = jaChars > 0 ? (enChars / jaChars).toFixed(2) : 'N/A'
                return (
                  <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 8, fontSize: 10 }}>
                    <span style={{ color: theme.textMuted }}>JA文字数: <strong style={{ color: theme.textSecondary }}>{jaChars}</strong></span>
                    <span style={{ color: theme.textMuted }}>EN文字数: <strong style={{ color: theme.textSecondary }}>{enChars}</strong></span>
                    <span style={{ color: theme.textMuted }}>EN/JA比: <strong style={{ color: Number(ratio) < 0.25 ? '#ef4444' : theme.textSecondary }}>{ratio}</strong></span>
                    <span style={{ color: theme.textMuted }}>duration: <strong style={{ color: dur > 10 ? '#60a5fa' : dur < 1.5 ? '#f59e0b' : theme.textSecondary }}>{dur.toFixed(2)}s</strong></span>
                    <span style={{ color: theme.textMuted }}>alignConf: <strong style={{ color: block.alignConfidence === 'exact' ? '#22c55e' : '#f59e0b' }}>{block.alignConfidence}</strong></span>
                  </div>
                )
              })()}

              {/* 診断パターン */}
              {(() => {
                const info = DIAG_INFO[block.diagPattern ?? 'ok']
                return (
                  <div style={{ marginTop: 8, padding: '6px 8px', borderRadius: 4, background: info.bg, border: `1px solid ${info.color}40` }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: info.desc ? 4 : 0 }}>
                      <span style={{ fontSize: 10, fontWeight: 700, color: info.color, padding: '1px 6px', background: `${info.color}20`, borderRadius: 3 }}>
                        {info.label}
                      </span>
                    </div>
                    {info.desc && <div style={{ fontSize: 10, color: theme.textSecondary }}>{info.desc}</div>}
                    {info.action && <div style={{ fontSize: 10, color: theme.textMuted, marginTop: 2 }}>→ {info.action}</div>}
                  </div>
                )
              })()}

              {/* QA 違反一覧 */}
              {block.qaViolations?.length > 0 && (
                <div style={{ marginTop: 6 }}>
                  {block.qaViolations.map((v, i) => (
                    <div key={i} style={{ fontSize: 10, color: '#f59e0b', marginBottom: 1 }}>⚠ {v.detail}</div>
                  ))}
                </div>
              )}
            </div>

            {/* ━━ 2. splitJa タイムスタンプ割り当て詳細 ━━ */}
            <div style={card}>
              <div style={sectionLabel}>splitJa — TS割り当て</div>
              {splitJaBlock ? (
                <>
                  {infoRow(
                    'alignConfidence',
                    splitJaBlock.alignConfidence,
                    splitJaBlock.alignConfidence === 'exact' ? 'ok' : 'warn',
                  )}
                  {infoRow(
                    'TS (splitJa)',
                    `${formatTime(splitJaBlock.start)} → ${formatTime(splitJaBlock.end)}  (${(splitJaBlock.end - splitJaBlock.start).toFixed(2)}s)`,
                    Math.abs(splitJaBlock.start - block.start) < 0.01 && Math.abs(splitJaBlock.end - block.end) < 0.01
                      ? undefined : 'warn',
                  )}
                  {infoRow('attempt', String(splitJaBlock.attempt))}
                  {splitJaBlock.parentBlockId != null &&
                    infoRow('parentBlockId', String(splitJaBlock.parentBlockId))}
                  {splitJaBlock.alignConfidence === 'proportional' && (
                    <div style={{ marginTop: 6, padding: '4px 8px', borderRadius: 4, background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.3)', fontSize: 10, color: '#f59e0b' }}>
                      ⚠ word マッチ失敗 → セグメント時間窓の均等配分を使用
                    </div>
                  )}
                </>
              ) : (
                <div style={{ color: theme.textMuted }}>splitJa ログが見つかりません（blockKey: {block.blockKey}）</div>
              )}
            </div>

            {/* ━━ 3. WhisperX ソースセグメント + words[] ━━ */}
            <div style={card}>
              <div style={sectionLabel}>WhisperX セグメント（TS源泉）</div>
              {sourceSegs.length === 0 && (
                <div style={{ color: theme.textMuted }}>セグメントが見つかりません</div>
              )}
              {sourceSegs.map(seg => {
                const corrected = correctedSegs.find(c => c.original.id === seg.id)
                return (
                  <div key={seg.id} style={{ marginBottom: 10 }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', marginBottom: 4 }}>
                      <span style={{ fontWeight: 700, color: theme.textPrimary }}>seg #{seg.id}</span>
                      <span style={{ color: theme.textMuted, fontFamily: 'monospace' }}>
                        {formatTime(seg.start)} → {formatTime(seg.end)}
                      </span>
                      <span style={{ color: theme.textMuted }}>words: {seg.words.length}</span>
                    </div>

                    {infoRow('WhisperX生', seg.text)}
                    {corrected && infoRow('補正後', corrected.correctedText)}
                    {corrected?.correctionFlagged && (
                      <div style={{ fontSize: 10, color: '#f59e0b', marginBottom: 4 }}>⚠ 補正フラグあり（意味が大きく変わった可能性）</div>
                    )}

                    {/* words[] */}
                    {seg.words.length > 0 ? (
                      <div style={{ marginTop: 6 }}>
                        <div style={{ fontSize: 10, color: theme.textMuted, marginBottom: 4 }}>
                          word タイムスタンプ（{seg.words.length}件 / MIN_WORD_LENGTH≥2 でフィルタ後 {seg.words.filter(w => w.word.trim().length >= 2).length}件有効）
                        </div>
                        <div style={{
                          display: 'flex', flexWrap: 'wrap', gap: 4,
                          maxHeight: 120, overflowY: 'auto',
                          padding: '4px 6px', borderRadius: 4,
                          background: theme.panelBg, border: `1px solid ${theme.panelBorder}`,
                        }}>
                          {seg.words.map((w, i) => {
                            const isShort = w.word.trim().length < 2
                            return (
                              <span
                                key={i}
                                title={`${w.word}: ${formatTime(w.start)}→${formatTime(w.end)}`}
                                style={{
                                  fontSize: 10,
                                  padding: '1px 5px',
                                  borderRadius: 3,
                                  background: isShort ? 'rgba(239,68,68,0.1)' : 'rgba(34,197,94,0.1)',
                                  border: `1px solid ${isShort ? 'rgba(239,68,68,0.3)' : 'rgba(34,197,94,0.2)'}`,
                                  color: isShort ? '#ef4444' : theme.textSecondary,
                                  fontFamily: 'monospace',
                                  textDecoration: isShort ? 'line-through' : undefined,
                                }}
                              >
                                {w.word}
                              </span>
                            )
                          })}
                        </div>
                        {seg.words.filter(w => w.word.trim().length < 2).length > 0 && (
                          <div style={{ fontSize: 10, color: '#ef4444', marginTop: 4 }}>
                            赤=1文字トークン（MIN_WORD_LENGTH=2 で除外される）
                          </div>
                        )}
                      </div>
                    ) : (
                      <div style={{ fontSize: 10, color: '#ef4444', marginTop: 4 }}>
                        ⚠ words[] が空（WhisperXがword TSを出力していない）
                      </div>
                    )}
                  </div>
                )
              })}
            </div>

            {/* ━━ 4. CPS ループ履歴 ━━ */}
            {attemptHistory.length > 0 && (
              <div style={card}>
                <div style={sectionLabel}>CPS ループ履歴</div>
                {attemptHistory.map(ah => (
                  <div key={ah.attempt} style={{
                    padding: '5px 8px', borderRadius: 4,
                    background: ah.cpsOk ? 'rgba(34,197,94,0.07)' : 'rgba(239,68,68,0.07)',
                    border: `1px solid ${ah.cpsOk ? 'rgba(34,197,94,0.2)' : 'rgba(239,68,68,0.2)'}`,
                    marginBottom: 4,
                  }}>
                    <div style={{ display: 'flex', gap: 8, marginBottom: 2 }}>
                      <span style={{ fontWeight: 700, color: theme.textMuted }}>attempt {ah.attempt}</span>
                      <span style={{ color: ah.cpsOk ? '#22c55e' : '#ef4444' }}>
                        CPS {ah.cps.toFixed(1)} {ah.cpsOk ? '→ OK' : '→ 違反・retry'}
                      </span>
                    </div>
                    <div style={{ color: theme.textSecondary, fontSize: 10 }}>{ah.enText}</div>
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
