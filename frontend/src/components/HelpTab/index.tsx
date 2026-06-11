import { useState } from 'react'
import { useTheme } from '@/context/ThemeContext'
import { useLocale } from '@/context/LocaleContext'

type HelpSection = 'guide' | 'admin' | 'shortcuts' | 'bestpractice'

const WIKI_BASE = 'https://github.com/matsuolab/lecture_subtitle_translator/wiki'

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

interface LinkItem {
  label: string
  href: string
  note: string
}

function LinkList({ items }: { items: LinkItem[] }) {
  const { theme } = useTheme()
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {items.map((item, i) => (
        <div key={i} style={{ fontSize: 12, lineHeight: 1.6 }}>
          <a
            href={item.href}
            target="_blank"
            rel="noreferrer"
            style={{ color: theme.glossaryLinkColor, fontWeight: 600 }}
          >
            {item.label}
          </a>
          <span style={{ color: theme.textMuted, marginLeft: 8, fontSize: 11 }}>{item.note}</span>
        </div>
      ))}
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
      <div style={{ fontSize: 11, color: theme.textMuted, marginBottom: 8 }}>
        このヘルプはオフラインで参照できる要約です。詳しい手順・設定・動作原理は Wiki（使い方ガイド内のリンク集）を参照してください。
      </div>

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
        <button style={tabStyle(section === 'admin')} onClick={() => setSection('admin')}>
          管理者向け
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
          <SectionCard title="📖 詳しいドキュメント（Wiki）">
            <p style={{ fontSize: 12, color: theme.textSecondary, lineHeight: 1.7, margin: '0 0 8px 0' }}>
              このヘルプは要約版です。手順・設定・動作原理の正式なドキュメントは Wiki にあります（閲覧にはインターネット接続が必要です）。
            </p>
            <LinkList items={[
              { label: 'Getting Started', href: `${WIKI_BASE}/Getting-Started`, note: 'インストールして使い始める' },
              { label: '操作マニュアル', href: `${WIKI_BASE}/Operator-Manual`, note: '日々の字幕作成・レビュー作業の手順' },
              { label: '画面リファレンス', href: `${WIKI_BASE}/UI-Reference`, note: '画面の各ボタン・機能の意味' },
              { label: '字幕ベストプラクティス・参考資料', href: `${WIKI_BASE}/Subtitle-Best-Practices`, note: '読みやすい字幕の原則と外部資料リンク集' },
              { label: '管理者セットアップ', href: `${WIKI_BASE}/Admin-Setup`, note: '環境構築〜接続テスト〜配布（管理者）' },
              { label: 'チューニング＆トラブルシュート', href: `${WIKI_BASE}/Admin-Tuning`, note: '品質・コスト・接続の調整と対処（症状から引く）' },
              { label: '上級設定リファレンス', href: `${WIKI_BASE}/Settings-Reference`, note: '設定項目の意味（表示名↔キー↔既定値）' },
              { label: '設定ファイルリファレンス', href: `${WIKI_BASE}/Config-Files-Reference`, note: 'JSON・プロンプト設定の書式' },
              { label: '動作原理', href: `${WIKI_BASE}/Pipeline-Behavior`, note: 'パイプラインが内部で何をしているか' },
            ]} />
          </SectionCard>

          <SectionCard title="基本的な作業の流れ">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <p style={{ fontSize: 12, color: theme.textSecondary, lineHeight: 1.7, margin: 0 }}>
                このツールは日本語講義動画から英語字幕を作成し、字幕ブロックごとに内容・タイミング・用語・自動処理結果を確認して承認するための字幕エディタです。
              </p>
              <p style={{ fontSize: 12, color: theme.textSecondary, lineHeight: 1.7, margin: 0 }}>
                <strong style={{ color: theme.textPrimary }}>① 動画を読み込む</strong>（左パネルにドロップ、またはボタンから選択）→
                <strong style={{ color: theme.textPrimary }}> ② 字幕生成タブで字幕生成を実行</strong> →
                <strong style={{ color: theme.textPrimary }}> ③ 要確認・用語警告を確認</strong> →
                <strong style={{ color: theme.textPrimary }}> ④ 問題なければ承認</strong> →
                <strong style={{ color: theme.textPrimary }}> ⑤ JSONまたはSRTとして書き出す</strong>
              </p>
              <p style={{ fontSize: 12, color: theme.textSecondary, lineHeight: 1.7, margin: 0 }}>
                プロジェクトJSONには日本語原文、英語字幕、レビュー状態、自動処理ログ、編集履歴が保存されます。SRTは英語字幕の提出・確認用です。
              </p>
            </div>
          </SectionCard>

          <SectionCard title="パイプライン（自動書き起こし・翻訳）">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <p style={{ fontSize: 12, color: theme.textSecondary, lineHeight: 1.7, margin: 0 }}>
                <strong style={{ color: theme.textPrimary }}>字幕生成タブ</strong>から字幕生成パイプラインを実行できます。動画を読み込んだ状態で「字幕生成を実行」ボタンを押すと、書き起こし → 日本語補正 → 英語翻訳 → 字幕ブロック生成を自動で行います。
              </p>
              <p style={{ fontSize: 12, color: theme.textSecondary, lineHeight: 1.7, margin: 0 }}>
                初回は設定タブで実行先と接続先AIプロバイダを設定します。リモート実行する場合は Service URL と Service Auth Token を入力し、接続テストで OK が表示されることを確認してから実行します。
              </p>
            </div>
          </SectionCard>

          <SectionCard title="要確認バッジ・自動処理ログの見方">
            <BulletList items={[
              '要確認 🚩: CPS・行長・表示時間などの測定形式違反が残っている、または未訳のブロックに付きます。内容を確認し、必要なら編集して承認します。',
              '自動処理の履歴: その字幕で試した分割、短縮、前後結合、表示時間調整などの履歴は、字幕生成タブの「このブロックの自動処理履歴」で、何を試して、採用されたか見送られたかを確認できます。',
              '処理全体の詳しいログは字幕生成タブの「処理ログ」から確認できます。管理者やエンジニアへ相談するときは、プロジェクトJSONも一緒に共有してください。',
            ]} />
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
                既定値では CPS 16.9 を上限、1行80文字を上限として表示します。値は管理者が設定タブで変更できます。
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

          <SectionCard title="困ったとき">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {[
                ['「字幕生成を実行」が押せない', '動画が読み込まれているか確認します（左パネル）'],
                ['接続エラーが出る', '設定タブで接続テスト・APIキーを確認。直らなければ管理者へ相談します'],
                ['[UNTRANSLATED: ...] が残っている', '自動翻訳が失敗したブロックです。書きおこしを見て手動で翻訳します'],
                ['要確認 🚩 が多すぎる', '品質基準（CPS・行長など）が動画に対して厳しすぎる可能性。管理者に設定調整を相談します'],
                ['処理が途中で失敗する', '字幕生成タブの実行状態・処理ログを確認し、その内容を添えて管理者へ報告します'],
                ['編集を間違えた', 'Ctrl+Z で戻せます。承認済みブロックは一度承認解除してから編集します'],
                ['用語漏れ・タイポ表示が誤検出', '表示の × で個別に無視できます（↩ で復帰）'],
              ].map(([symptom, action], i) => (
                <div key={i} style={{ display: 'flex', gap: 10, fontSize: 12, alignItems: 'flex-start' }}>
                  <span style={{ color: theme.textPrimary, fontWeight: 600, minWidth: 200 }}>{symptom}</span>
                  <span style={{ color: theme.textSecondary, lineHeight: 1.6 }}>{action}</span>
                </div>
              ))}
            </div>
          </SectionCard>
        </div>
      )}

      {/* 管理者向けセクション */}
      {section === 'admin' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <SectionCard title="初回設定チェックリスト">
            <BulletList items={[
              '実行先: AWS / リモート実行を使うか、このPCで実行するかを選びます。',
              'Service URL / Service Auth Token: リモート実行する場合の接続先と認証情報です。入力後、接続テストでOKが出ればアクセス確認済みです。',
              '接続先AIプロバイダ: OpenAI / Gemini / OpenAI互換 を選び、対応する API Key を入力します。READMEやチャットに公開しないでください。',
              'AI Gateway 接続チェック: Chat / Embedding / Vision の疎通を確認してからパイプラインを実行します。',
              '用語辞書: CSV/XLSXを読み込み、確定済み用語をハイライト・用語漏れ・タイポ候補に使います。',
            ]} />
          </SectionCard>

          <SectionCard title="設定・チューニングの正式ドキュメント（Wiki）">
            <p style={{ fontSize: 12, color: theme.textSecondary, lineHeight: 1.7, margin: '0 0 8px 0' }}>
              推奨モデル・既定値・各設定項目の意味は、アプリのバージョンアップで変わるためこのヘルプには記載していません。常に Wiki の最新版を参照してください。
            </p>
            <LinkList items={[
              { label: '管理者セットアップ', href: `${WIKI_BASE}/Admin-Setup`, note: '環境構築〜接続テスト〜共有用設定の配布までの順路' },
              { label: '上級設定リファレンス', href: `${WIKI_BASE}/Settings-Reference`, note: 'モデル・品質基準（行長/CPS）など全設定項目の意味と既定値' },
              { label: '設定ファイルリファレンス', href: `${WIKI_BASE}/Config-Files-Reference`, note: '言語プロファイルJSON・プロンプト上書き等の書式と注意点' },
              { label: 'チューニング＆トラブルシュート', href: `${WIKI_BASE}/Admin-Tuning`, note: '品質・コスト・接続の問題を症状から引いて対処する' },
            ]} />
          </SectionCard>

          <SectionCard title="障害調査で共有する情報">
            <BulletList items={[
              'プロジェクトJSON: 字幕、レビュー状態、自動処理ログ、編集履歴、設定スナップショットを含みます。',
              '字幕生成タブの処理ログ: モジュール別ログ、進行イベント、設定スナップショットを確認できます。',
              'job_id または runId: Managed Service の実行結果を追跡するときに必要です。',
              '不要な提案、危険な自動修正、良かった自動修正、UIで迷った点をメモとして残してください。',
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

          <SectionCard title="読みやすい字幕の一般原則">
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
                  '行末に句読点（。、.）を置かない',
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

          <SectionCard title="このツールでの品質チェックポイント">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {[
                ['CPS警告', '既定では16.9を上限として判定。設定タブの値に連動します'],
                ['行長警告', '既定では1行80文字を上限として判定。設定タブの値に連動します'],
                ['要確認 🚩', '測定形式違反（CPS・行長・表示時間など）や未訳が残っているブロック。内容を確認して承認します'],
                ['自動処理履歴', '字幕生成タブの「このブロックの自動処理履歴」で、分割・短縮・結合などの履歴を確認できます'],
                ['用語ハイライト', '用語辞書に登録した語が正しく訳されているか確認する'],
              ].map(([badge, desc], i) => (
                <div key={i} style={{ display: 'flex', gap: 10, fontSize: 12, alignItems: 'flex-start' }}>
                  <span style={{ color: theme.textPrimary, fontWeight: 600, whiteSpace: 'nowrap', minWidth: 120 }}>{badge}</span>
                  <span style={{ color: theme.textSecondary, lineHeight: 1.6 }}>{desc}</span>
                </div>
              ))}
            </div>
          </SectionCard>

          <SectionCard title="参考資料">
            <p style={{ fontSize: 12, color: theme.textSecondary, lineHeight: 1.7, margin: 0 }}>
              CPS・行長・表示時間などの具体的な数値基準を参考にしたい場合は、各プラットフォームの公式ガイドライン最新版を参照してください。
              注釈付きのリンク集（Netflix / BBC / EBU の公式ガイドライン、教育向けガイドライン、学術文献）は{' '}
              <a href={`${WIKI_BASE}/Subtitle-Best-Practices`} target="_blank" rel="noreferrer" style={{ color: theme.glossaryLinkColor, fontWeight: 600 }}>
                Wiki: 字幕ベストプラクティス・参考資料
              </a>
              {' '}にまとめています（閲覧にはインターネット接続が必要です）。
            </p>
          </SectionCard>

        </div>
      )}

    </div>
  )
}
