import { useState } from 'react'
import { useTheme } from '@/context/ThemeContext'
import { useLocale } from '@/context/LocaleContext'

type HelpSection = 'guide' | 'admin' | 'shortcuts' | 'bestpractice'

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
      <div style={{ fontSize: 11, color: theme.textMuted, marginBottom: 8 }}>
        このヘルプの操作手順・設定説明は subtitle-editor v0.4.4 準拠です。
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
          <SectionCard title="基本的な作業の流れ">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <p style={{ fontSize: 12, color: theme.textSecondary, lineHeight: 1.7, margin: 0 }}>
                このツールは日本語講義動画から英語字幕を作成し、字幕ブロックごとに内容・タイミング・用語・自動処理結果を確認して承認するための字幕エディタです。
              </p>
              <p style={{ fontSize: 12, color: theme.textSecondary, lineHeight: 1.7, margin: 0 }}>
                <strong style={{ color: theme.textPrimary }}>① 動画を読み込む</strong>（左パネルにドロップ、またはボタンから選択）→
                <strong style={{ color: theme.textPrimary }}> ② レポートタブでパイプラインを実行</strong> →
                <strong style={{ color: theme.textPrimary }}> ③ 提案・要確認・用語警告を確認</strong> →
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
                <strong style={{ color: theme.textPrimary }}>レポートタブ</strong>からパイプラインを実行できます。動画を読み込んだ状態で「パイプラインを実行」ボタンを押すと、書き起こし → 日本語補正 → 英語翻訳 → 字幕ブロック生成を自動で行います。
              </p>
              <p style={{ fontSize: 12, color: theme.textSecondary, lineHeight: 1.7, margin: 0 }}>
                初回は設定タブで実行先と接続先AIプロバイダを設定します。リモート実行する場合は Service URL と Service Auth Token を入力し、接続テストで OK が表示されることを確認してから実行します。
              </p>
            </div>
          </SectionCard>

          <SectionCard title="提案・要確認・自動処理ログの見方">
            <BulletList items={[
              '提案: 自動処理またはLLMが修正候補を出している状態です。内容を確認し、必要なら編集して承認します。',
              '要確認: 速度、表示時間、訳抜け、用語など、人間の判断を優先したい状態です。',
              '自動: 自動処理が適用済みで、大きな問題がなければ承認できます。',
              '自動処理 n: その字幕で試した分割、短縮、前後結合、表示時間調整などの履歴です。クリックすると、何を試して、採用されたか見送られたかを確認できます。',
              '処理全体の詳しいログはレポートタブの「処理ログ」から確認できます。管理者やエンジニアへ相談するときは、プロジェクトJSONも一緒に共有してください。',
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
        </div>
      )}

      {/* 管理者向けセクション */}
      {section === 'admin' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <SectionCard title="初回設定で確認する項目">
            <BulletList items={[
              '実行先: AWS / リモート実行を使うか、このPCで実行するかを選びます。',
              'Service URL / Service Auth Token: リモート実行する場合の接続先と認証情報です。入力後、接続テストでOKが出ればアクセス確認済みです。',
              '接続先AIプロバイダ: OpenAI または Gemini を選び、対応する API Key を入力します。READMEやチャットに公開しないでください。',
              'OpenAI Compatible Base URL: OpenAI互換APIを使う場合だけ入力します。通常は空欄です。',
              '用語辞書: CSV/XLSXを読み込み、確定済み用語をハイライト・用語漏れ・タイポ候補に使います。',
              'PDF辞書作成で数式・図表・画像化文字の抽出精度を上げたい場合は、辞書タブで Vision LLM を有効にし、設定タブの PDF抽出Visionモデル にVision対応モデルIDを指定します。',
              'PDF辞書作成の並列化ON/OFFは辞書タブで切り替えます。API並列リクエスト数は設定タブで調整します。OFFでは1ページずつ処理します。',
            ]} />
          </SectionCard>

          <SectionCard title="現在の推奨モデル・字幕制限">
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                <tbody>
                  {[
                    ['translationProvider', 'openai'],
                    ['translationModel', 'gpt-5.4-mini'],
                    ['correctionModel', 'gpt-5.4-mini'],
                    ['pdfExtractionVisionModel', 'gpt-5.4-mini'],
                    ['compressModel', 'gpt-5.4-mini'],
                    ['expandModel', 'gpt-5.4-mini'],
                    ['contextMergeModel', 'gpt-5.5'],
                    ['subtitleLanguageLabel', 'English'],
                    ['transcriptLanguageLabel', 'Japanese'],
                    ['enMaxCharsPerLine', '80'],
                    ['enMaxCps', '16.9'],
                    ['pipelineVerboseEnRatio', '1.5'],
                    ['glossaryMaxOutputTokens', '4096'],
                    ['glossaryRequestConcurrency', '7'],
                  ].map(([key, value]) => (
                    <tr key={key} style={{ borderBottom: `1px solid ${theme.panelBorder}` }}>
                      <td style={{ padding: '5px 8px', color: theme.textPrimary, fontWeight: 700, whiteSpace: 'nowrap' }}>{key}</td>
                      <td style={{ padding: '5px 8px', color: theme.textSecondary }}>{value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </SectionCard>

          <SectionCard title="言語プロファイルJSON">
            <BulletList items={[
              'Context Merge で source/target の取り違えを防ぐため、曖昧な source/target ではなく subtitle_text と transcript_text の役割でLLMに渡します。',
              'subtitleLanguageLabel は画面に表示する字幕の言語です。既定では English です。',
              'transcriptLanguageLabel は参照する書き起こし原文の言語です。既定では Japanese です。',
              'script は latin / japanese / generic から選びます。英日以外の言語では generic を使うと、文字種による強制判定を避けられます。',
              'sentenceEndPattern、continuationEndPattern、fragmentStartPattern は、短い断片を前後と統合する候補判定に使います。',
            ]} />
          </SectionCard>

          <SectionCard title="プロンプト上書きの注意">
            <BulletList items={[
              'compressPromptOverride と expandPromptOverride を入力すると、デフォルトプロンプトを完全に置き換えます。',
              '上書きプロンプトでは、CPS、行長、行数、講義らしさ、専門用語保持などの制約を自分で明示してください。',
              '一部だけ追記する欄ではないため、検証中は空欄に戻せるよう変更内容を別途控えてください。',
            ]} />
          </SectionCard>

          <SectionCard title="障害調査で共有する情報">
            <BulletList items={[
              'プロジェクトJSON: 字幕、レビュー状態、自動処理ログ、編集履歴、設定スナップショットを含みます。',
              'ReportTab の処理ログ: モジュール別ログ、進行イベント、設定スナップショットを確認できます。',
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

          <SectionCard title="プラットフォーム別 主要パラメータ比較">
            <RuleTable rows={[
              {
                label: 'CPS上限（英語）',
                netflix: '17 cps',
                youtube: '〜20 cps（目安）',
                bbc: '15〜20 cps',
                note: '既定上限は16.9。設定で変更可',
              },
              {
                label: '1行最大文字数',
                netflix: '42文字',
                youtube: '42文字（推奨）',
                bbc: '40〜42文字',
                note: 'このプロジェクトの既定上限は80文字',
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
              '1行最大42文字（半角）。2行まで。現在のプロジェクト既定値は講義字幕向けに80文字',
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
                ['CPS警告', '既定では16.9を上限として判定。設定タブの値に連動します'],
                ['行長警告', '既定では1行80文字を上限として判定。設定タブの値に連動します'],
                ['提案', '自動修正やLLMが修正候補を出しているブロック。内容確認後に承認します'],
                ['要確認', '人間の判断を優先するブロック。訳抜け、速度、表示時間、用語を確認します'],
                ['自動処理', 'そのブロックで試した分割・短縮・結合などの履歴を確認できます'],
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
