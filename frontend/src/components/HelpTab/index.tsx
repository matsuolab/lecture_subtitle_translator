import { useState } from 'react'
import { useTheme } from '@/context/ThemeContext'
import { useLocale } from '@/context/LocaleContext'

type HelpSection = 'guide' | 'shortcuts' | 'bestpractice'

function KeyBadge({ label }: { label: string }) {
  const { theme } = useTheme()
  const isClick = label.startsWith('クリック') || label.startsWith('ドラッグ') ||
                  label.startsWith('Click') || label.startsWith('Drag') ||
                  label.startsWith('点击') || label.startsWith('拖')
  if (isClick) {
    return (
      <span style={{ fontSize: 11, color: theme.textSecondary, fontStyle: 'italic' }}>{label}</span>
    )
  }
  return (
    <span style={{
      display: 'inline-block',
      padding: '1px 7px',
      borderRadius: 4,
      border: `1px solid ${theme.btnBorder}`,
      background: theme.btnBg,
      fontSize: 11,
      fontFamily: 'monospace',
      color: theme.btnText,
      lineHeight: '18px',
    }}>
      {label}
    </span>
  )
}

function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
  const { theme } = useTheme()
  return (
    <div style={{
      padding: '12px 14px',
      borderRadius: 8,
      border: `1px solid ${theme.panelBorder}`,
      background: theme.cardBg,
    }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: theme.textPrimary, marginBottom: 10 }}>
        {title}
      </div>
      {children}
    </div>
  )
}

function RuleTable({ rows }: { rows: { label: string; netflix?: string; youtube?: string; bbc?: string; note?: string }[] }) {
  const { theme } = useTheme()
  const cols = ['項目', 'Netflix', 'YouTube', 'BBC / 一般', '備考']
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
        <thead>
          <tr style={{ borderBottom: `1px solid ${theme.panelBorder}` }}>
            {cols.map(c => (
              <th key={c} style={{ textAlign: 'left', padding: '4px 8px', color: theme.textMuted, fontWeight: 600, whiteSpace: 'nowrap' }}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} style={{ borderBottom: `1px solid ${theme.panelBorder}` }}>
              <td style={{ padding: '5px 8px', color: theme.textPrimary, fontWeight: 600, whiteSpace: 'nowrap' }}>{r.label}</td>
              <td style={{ padding: '5px 8px', color: theme.textSecondary }}>{r.netflix ?? '—'}</td>
              <td style={{ padding: '5px 8px', color: theme.textSecondary }}>{r.youtube ?? '—'}</td>
              <td style={{ padding: '5px 8px', color: theme.textSecondary }}>{r.bbc ?? '—'}</td>
              <td style={{ padding: '5px 8px', color: theme.textMuted, fontSize: 10 }}>{r.note ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function BulletList({ items }: { items: string[] }) {
  const { theme } = useTheme()
  return (
    <ul style={{ margin: 0, paddingLeft: 16, display: 'flex', flexDirection: 'column', gap: 4 }}>
      {items.map((item, i) => (
        <li key={i} style={{ fontSize: 12, color: theme.textSecondary, lineHeight: 1.6 }}>{item}</li>
      ))}
    </ul>
  )
}

export function HelpTab() {
  const { theme } = useTheme()
  const { strings: t } = useLocale()
  const [section, setSection] = useState<HelpSection>('guide')

  const tabStyle = (active: boolean) => ({
    padding: '6px 14px',
    fontSize: 12,
    fontWeight: 600,
    borderRadius: 6,
    border: 'none',
    cursor: 'pointer',
    whiteSpace: 'nowrap' as const,
    background: active ? theme.accent : 'transparent',
    color: active ? '#fff' : theme.textSecondary,
    transition: 'background 0.15s, color 0.15s',
  })

  return (
    <div className="h-full overflow-y-auto" style={{ padding: 14 }}>

      {/* セクション切り替えタブ */}
      <div style={{
        display: 'flex', gap: 4, marginBottom: 16, flexWrap: 'wrap',
        padding: 3, borderRadius: 8,
        background: theme.cardBg, border: `1px solid ${theme.panelBorder}`,
        width: 'fit-content',
      }}>
        <button style={tabStyle(section === 'guide')} onClick={() => setSection('guide')}>
          使い方ガイド
        </button>
        <button style={tabStyle(section === 'shortcuts')} onClick={() => setSection('shortcuts')}>
          キー操作
        </button>
        <button style={tabStyle(section === 'bestpractice')} onClick={() => setSection('bestpractice')}>
          字幕ベストプラクティス
        </button>
      </div>

      {/* ガイドセクション */}
      {section === 'guide' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <SectionCard title="基本的な作業の流れ">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <p style={{ fontSize: 12, color: theme.textSecondary, lineHeight: 1.7, margin: 0 }}>
                このツールは動画と字幕SRTを読み込み、ブロックごとに内容・タイミングを確認・編集して最終SRTを書き出す字幕エディタです。
              </p>
              <p style={{ fontSize: 12, color: theme.textSecondary, lineHeight: 1.7, margin: 0 }}>
                <strong style={{ color: theme.textPrimary }}>① 動画を読み込む</strong>（左パネルにドロップ、またはボタンから選択）→
                <strong style={{ color: theme.textPrimary }}> ② SRTを読み込む</strong>（右パネルにドロップ、またはツールバーから） →
                <strong style={{ color: theme.textPrimary }}> ③ 動画を再生しながら各ブロックを確認・編集</strong> →
                <strong style={{ color: theme.textPrimary }}> ④ 問題なければ承認</strong> →
                <strong style={{ color: theme.textPrimary }}> ⑤ SRTとして書き出す</strong>
              </p>
              <p style={{ fontSize: 12, color: theme.textSecondary, lineHeight: 1.7, margin: 0 }}>
                プロジェクトはブラウザに自動保存されます。JSON形式でのエクスポート・インポートも可能です。<br />
                新しい動画を読み込むと字幕はリセットされます（確認ダイアログが表示されます）。
              </p>
            </div>
          </SectionCard>

          <SectionCard title="パイプライン（自動書き起こし・翻訳）【実装作業中】">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <p style={{ fontSize: 12, color: theme.textSecondary, lineHeight: 1.7, margin: 0 }}>
                <strong style={{ color: theme.textPrimary }}>レポートタブ</strong>からパイプラインを実行できます。動画を読み込んだ状態で「パイプラインを実行」ボタンを押すと、書き起こし → 日本語補正 → 英語翻訳 → 字幕ブロック生成を自動で行います。
              </p>
              <p style={{ fontSize: 12, color: theme.textSecondary, lineHeight: 1.7, margin: 0 }}>
                パイプラインを使用するには設定タブでバックエンドAPIのURLを設定する必要があります。未設定の場合はデモ用のスタブ結果が表示されます。
              </p>
            </div>
          </SectionCard>

          <SectionCard title="字幕ブロックと CPS（文字/秒）">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <p style={{ fontSize: 12, color: theme.textSecondary, lineHeight: 1.7, margin: 0 }}>
                各ブロックは「開始時刻〜終了時刻」の区間に表示される字幕の1単位です。原文テキストと訳文テキストをそれぞれ持ちます。
              </p>
              <p style={{ fontSize: 12, color: theme.textSecondary, lineHeight: 1.7, margin: 0 }}>
                CPS（Characters Per Second）は読みやすさの指標で、文字数 ÷ 表示秒数で計算されます。3段階で色分けされます：
              </p>
              <p style={{ fontSize: 12, color: theme.textSecondary, lineHeight: 1.7, margin: 0 }}>
                🟢 緑（CPS 15以下）: 読みやすい　🟡 黄（15〜20）: やや速い・要確認　🔴 赤（20超）: 速すぎる・分割推奨
              </p>
            </div>
          </SectionCard>

          <SectionCard title="承認（ロック）の仕組み">
            <BulletList items={[
              '承認ボタンを押すとブロックの内容と時間が確定します。',
              '承認済みブロックは時間編集・合体・境界ドラッグがすべてロックされます（誤操作防止）。',
              '間違えた場合は承認ボタンをもう一度押してロックを解除できます。',
              '翻訳が完了したブロックから順番に承認していくことで作業の進捗を管理できます。',
            ]} />
          </SectionCard>

          <SectionCard title="タイムラインと動画の連携">
            <BulletList items={[
              '左下のタイムラインはすべてのブロックを時間軸上に表示します。ブロックの色はCPSに連動しています。',
              'ホイールでズームして細部を確認できます（最大20倍）。ズーム中はミニマップが表示されます。',
              'I キーで開始点、O キーで終了点を設定するのが最も直感的なタイミング調整の方法です。',
            ]} />
          </SectionCard>

          <SectionCard title="用語辞書の使い方">
            <BulletList items={[
              'CSV/XLSXをボタンまたはドラッグ&ドロップで読み込めます。',
              '字幕ブロックでは用語ハイライトに加えて用語漏れ・タイポ候補を表示します。',
              '誤検出は × で無視、↩ で復帰できます。',
              '用語辞書タブの「全ブロックに適用」ボタンで一括適用も可能です。',
            ]} />
          </SectionCard>
        </div>
      )}

      {/* ショートカットセクション */}
      {section === 'shortcuts' && (
        <div>
          {t.shortcuts.map(sec => (
            <div key={sec.category} style={{ marginBottom: 20 }}>
              <div style={{
                fontSize: 11, fontWeight: 700,
                color: theme.textSecondary, letterSpacing: '0.5px', marginBottom: 8,
              }}>
                {sec.category}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {sec.items.map((item, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 200, flexWrap: 'wrap' }}>
                      {item.keys.map((k, j) => (
                        <span key={j} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                          {j > 0 && <span style={{ fontSize: 10, color: theme.textMuted }}>+</span>}
                          <KeyBadge label={k} />
                        </span>
                      ))}
                    </div>
                    <span style={{ fontSize: 12, color: theme.textSecondary }}>{item.desc}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ベストプラクティスセクション */}
      {section === 'bestpractice' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

          <SectionCard title="プラットフォーム別 主要パラメータ比較">
            <RuleTable rows={[
              {
                label: 'CPS上限（英語）',
                netflix: '17 cps',
                youtube: '〜20 cps（目安）',
                bbc: '15〜20 cps',
                note: 'このツールは15/20で警告',
              },
              {
                label: '1行最大文字数',
                netflix: '42文字',
                youtube: '42文字（推奨）',
                bbc: '40〜42文字',
                note: '半角換算',
              },
              {
                label: '最大行数',
                netflix: '2行',
                youtube: '2行',
                bbc: '2行',
                note: '3行以上は読みにくい',
              },
              {
                label: '最短表示時間',
                netflix: '0.833秒（24fpsで20f）',
                youtube: '約1秒推奨',
                bbc: '0.5〜1秒',
                note: '短すぎると読めない',
              },
              {
                label: '最長表示時間',
                netflix: '7秒',
                youtube: '7〜8秒',
                bbc: '8秒',
                note: '長すぎると残り続けて不自然',
              },
              {
                label: 'ブロック間隔',
                netflix: '最低2フレーム（〜83ms）',
                youtube: '〜100ms推奨',
                bbc: '特に規定なし',
                note: 'ギャップゼロは避ける',
              },
            ]} />
          </SectionCard>

          <SectionCard title="読みやすい字幕のルール">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, color: theme.textPrimary, marginBottom: 4 }}>改行位置</div>
                <BulletList items={[
                  '意味のまとまりで改行する（文法的な区切りを優先）',
                  '1行目より2行目を短くするのが自然（逆三角形を避ける）',
                  '前置詞・冠詞・助動詞の直前では改行しない',
                  '固有名詞や熟語はできるだけ同じ行に収める',
                ]} />
              </div>
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, color: theme.textPrimary, marginBottom: 4 }}>句読点・記号</div>
                <BulletList items={[
                  '行末に句読点（。、.）を置かない（Netflixガイドライン）',
                  'ダッシュ（—）で文章が途切れた場合は次ブロックの先頭にも — を付ける',
                  '三点リーダー（…）は文章が途切れた場合に使う',
                  '感嘆符・疑問符の後にスペースを入れない',
                ]} />
              </div>
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, color: theme.textPrimary, marginBottom: 4 }}>タイミング</div>
                <BulletList items={[
                  'セリフの発話開始から0〜200ms以内に表示開始する',
                  '発話終了から0〜100ms程度で消える（遅れすぎると違和感）',
                  '無音区間が長い場合は字幕も早めに消してよい',
                  '複数のセリフが重なる場合は話者ごとにブロックを分ける',
                ]} />
              </div>
            </div>
          </SectionCard>

          <SectionCard title="Netflix 字幕ガイドライン（英語字幕の主要ルール）">
            <BulletList items={[
              'CPS: 最大17（英語）。このツールでは15超で黄色、20超で赤で警告',
              '1行最大42文字（半角）。2行まで',
              '最短表示時間: 5フレーム（24fpsで0.208秒）、推奨は0.833秒（20フレーム）',
              '最長表示時間: 7秒',
              'ブロック間の最小間隔: 2フレーム（24fpsで83ms）',
              '行末にピリオド・カンマを置かない（例外: 略語、省略形）',
              '話者が変わる場合は「—」をブロック先頭に付ける',
              '上付き文字・特殊フォント・色指定は使わない（SRTでは対応外）',
            ]} />
          </SectionCard>

          <SectionCard title="YouTube / 一般動画向けのポイント">
            <BulletList items={[
              'Netflix ほど厳密でなくてよいが、CPS 20以下を目安にすると視聴者体験が向上する',
              'YouTubeの自動字幕に合わせて修正する場合は、誤認識されやすい固有名詞を重点的に確認する',
              '長い動画（講義・セミナー）では1ブロックを4〜5秒以内に抑えると読みやすい',
              'テロップや図解と字幕が重ならないよう、必要に応じて表示位置を調整する（SRTのLine指定）',
            ]} />
          </SectionCard>

          <SectionCard title="BBC / 放送向けのポイント">
            <BulletList items={[
              'BBCガイドラインでは CPS 17以下を推奨。複雑な内容は15以下を目標にする',
              '話者の交代には — を使い、複数話者が同じブロックに含まれないようにする',
              '音響描写（[拍手]、[笑い声]等）は [] または () で囲み、通常の発話と区別する',
              '方言・アクセントは標準表記で書くが、話者の特徴を反映した語彙を選ぶ',
              'ニュース・ドキュメンタリーでは固有名詞のスペルを事前に確認する',
              'ライブ放送字幕では最短 0.5秒、通常番組では最短 1秒の表示時間を確保する',
            ]} />
          </SectionCard>

          <SectionCard title="このツールでの品質チェックポイント">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {[
                ['🔴 CPS > 20', '赤表示。即座に分割を検討する'],
                ['🟡 CPS 15〜20', '黄表示。読めるが速め。内容によって分割を検討'],
                ['⚠ 42文字超過', '1行が42文字を超えているブロック。改行または短縮する'],
                ['🚩 要確認フラグ', '翻訳品質に疑問があるブロックに手動でフラグを立てられる'],
                ['用語ハイライト', '用語辞書に登録した語が正しく訳されているか確認する'],
              ].map(([badge, desc], i) => (
                <div key={i} style={{ display: 'flex', gap: 10, fontSize: 12, alignItems: 'flex-start' }}>
                  <span style={{ color: theme.textPrimary, fontWeight: 600, whiteSpace: 'nowrap', minWidth: 120 }}>{badge}</span>
                  <span style={{ color: theme.textSecondary, lineHeight: 1.6 }}>{desc}</span>
                </div>
              ))}
            </div>
          </SectionCard>

        </div>
      )}

    </div>
  )
}
