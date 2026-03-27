import type { LocaleStrings } from './types'

export const ja: LocaleStrings = {
  id: 'ja',
  label: '日本語',

  videoPlayer: '動画プレイヤー',
  tabSubtitles: '字幕ブロック',
  tabDictionary: '用語辞書',
  tabHelp: 'ヘルプ',
  saving: '保存中…',
  saved: '✓ 保存済み',
  loadProject: '読み込み',
  saveProject: '保存',
  exportSrt: 'SRT出力',
  loadProjectTitle: 'プロジェクト JSON を読み込む',
  saveProjectTitle: 'プロジェクト JSON として保存',
  exportSrtTitle: 'SRT ファイルとしてエクスポート',
  restored: '前回の作業を復元しました',
  approvedCount: (a, t) => `${a} / ${t} 承認済み`,
  reSplitAlert: (id) => `ブロック #${id} を再分割します（本番では LLM API を呼び出し）`,
  reTranslateAlert: (id) => `ブロック #${id} を再翻訳します（本番では LLM API を呼び出し）`,
  importError: 'プロジェクトファイルの読み込みに失敗しました',

  approve: '承認',
  approvedBtn: '承認済 ✓',
  reSplit: '再分割',
  reTranslate: '再翻訳',
  editHint: 'Enter で改行 ／ Shift+Enter で分割 ／ Ctrl+Enter で保存 ／ Esc でキャンセル',
  charCount: (lines, isOver) => `文字数: ${lines.join(' / ')}${isOver ? ' ⚠' : ''}`,
  timeErrorFormat: '形式: MM:SS.mmm',
  timeErrorStartNeg: '開始は 0 以上',
  timeErrorOrder: '開始 < 終了 が必要',
  timeEditTitle: 'クリックで時間を直接編集',

  gapLabel: (s) =>
    s >= 60
      ? `${Math.floor(s / 60)}m${(s % 60).toFixed(1)}s の空き`
      : `${s.toFixed(1)}s の空き`,
  gapDragHint: '← Ctrl+ドラッグで調整',
  boundaryDragging: '⟷ 境界調整中（Ctrl離すとキャンセル）',
  boundaryHover: 'Ctrl+ドラッグで時間境界を調整',

  registeredTerms: (n) => `登録済み用語 (${n})`,
  unregisteredTerms: (n) => `参考資料から検出・辞書未登録 (${n})`,
  confirmed: '確定済',
  unconfirmed: '未確認',
  unregistered: '未登録',
  source: '出典:',
  requestConfirmation: 'イシューを作成',
  confirmedBtn: '確定済 ✓',
  addToDictionary: '辞書に追加',
  noDesc: '（説明未入力）',

  guide: [
    {
      title: '基本的な作業の流れ',
      paragraphs: [
        'このツールは字幕SRTファイルと動画を読み込み、ブロックごとに内容・タイミングを確認・編集して最終SRTを書き出すエディタです。',
        '① SRT/プロジェクトを読み込む　② 動画を再生しながら各ブロックを確認　③ テキスト・タイミングを編集　④ 問題なければ承認　⑤ SRTとして書き出す',
        'プロジェクトはブラウザに自動保存されます。JSON形式でのエクスポート・インポートも可能です。',
      ],
    },
    {
      title: '字幕ブロックと CPS（文字/秒）',
      paragraphs: [
        '各ブロックは「開始時刻〜終了時刻」の区間に画面へ表示される字幕の1単位です。原文テキストと訳文テキストをそれぞれ持ちます。',
        'CPS（Characters Per Second）はテキストの読みやすさの指標で、文字数 ÷ 表示秒数で計算されます。Netflixガイドラインに準拠した3段階で色分けされます。',
        '🟢 緑（CPS 15以下）: 読みやすい速度　🟡 黄（15〜20）: やや速い・要確認　🔴 赤（20超）: 速すぎる・分割を推奨',
      ],
    },
    {
      title: '承認（ロック）の仕組み',
      paragraphs: [
        '承認ボタンを押すとブロックの内容と時間が確定します。誤操作防止のため、承認済みブロックは時間編集・合体・境界ドラッグがすべてロックされます。',
        '翻訳作業が完了したブロックから順番に承認していくことで、作業の進捗を管理できます。間違えた場合は承認ボタンをもう一度押してロックを解除できます。',
      ],
    },
    {
      title: 'タイムラインと動画の連携',
      paragraphs: [
        '画面左下のタイムラインはすべてのブロックを時間軸上に表示します。ブロックの色はCPSに連動しており、問題のあるブロックを一目で把握できます。',
        '2時間の講義でもホイールでズームして細部を確認できます。ズーム中はミニマップが表示され、全体のどこにいるかを把握しながら作業できます。',
        '動画を再生しながら I キーで開始点、O キーで終了点を設定するのが最も直感的なタイミング調整の方法です。動画編集ソフトのイン/アウト点マーキングと同じ操作感です。',
      ],
    },
    {
      title: '用語辞書の使い方',
      paragraphs: [
        '用語辞書タブでは専門用語の訳語を一元管理します。確定済みの用語は字幕ブロック内で自動的にハイライト表示されます。',
        '参考資料から検出された未登録用語はオレンジ色で警告表示されます。「イシューを作成」ボタンでレビュー依頼の Issue を発行できます（将来実装予定）。',
      ],
    },
  ],
  shortcutsTitle: 'キーボード・マウス操作一覧',
  shortcuts: [
    {
      category: '編集',
      items: [
        { keys: ['クリック（原文テキスト）'], desc: '編集モードに入る' },
        { keys: ['Enter'], desc: '改行を挿入（1行42文字以内を推奨）' },
        { keys: ['Ctrl', 'Enter'], desc: '編集を保存' },
        { keys: ['Esc'], desc: '編集をキャンセル' },
        { keys: ['Shift', 'Enter'], desc: 'カーソル位置でブロックを分割' },
      ],
    },
    {
      category: '分割',
      items: [
        { keys: ['✂ 再生位置'], desc: '再生ヘッドの位置でブロックを分割（再生位置がブロック内にある時のみ有効）' },
        { keys: ['÷ 均等割り'], desc: 'ブロックを時間・テキストともに2等分' },
      ],
    },
    {
      category: '合体',
      items: [
        { keys: ['ドラッグ & ドロップ'], desc: '2つのブロックを合体（承認済みは不可）' },
        { keys: ['Ctrl', 'M'], desc: 'アクティブブロックを次と合体' },
        { keys: ['Ctrl', 'Shift', 'M'], desc: 'アクティブブロックを前と合体' },
      ],
    },
    {
      category: '承認',
      items: [
        { keys: ['承認ボタン'], desc: 'ブロックを承認済みに変更（時間・内容を確定）' },
        { keys: ['承認済み'], desc: '時間編集・合体・境界ドラッグが禁止される' },
      ],
    },
    {
      category: '履歴',
      items: [
        { keys: ['Ctrl', 'Z'], desc: '元に戻す' },
        { keys: ['Ctrl', 'Shift', 'Z'], desc: 'やり直し' },
        { keys: ['Ctrl', 'Y'], desc: 'やり直し（別表記）' },
      ],
    },
    {
      category: '時間調整',
      items: [
        { keys: ['I'], desc: 'アクティブブロックの開始時刻 = 再生位置（イン点マーク）' },
        { keys: ['O'], desc: 'アクティブブロックの終了時刻 = 再生位置（アウト点マーク）' },
        { keys: ['‹← / →›（時間表示横）'], desc: '開始・終了を ±0.1s 微調整' },
        { keys: ['クリック（時間表示）'], desc: '時間を MM:SS.mmm 形式で直接入力' },
        { keys: ['Ctrl', 'ドラッグ（境界線）←→'], desc: '隣接ブロックの時間境界をシフト（CPS調整、Ctrl離しでキャンセル）' },
        { keys: ['Ctrl', 'ドラッグ（タイムライン境界）'], desc: '下部タイムラインで境界を直接ドラッグして調整' },
        { keys: ['クリック / ドラッグ（タイムライン）'], desc: 'タイムラインをクリック・ドラッグしてシーク' },
        { keys: ['ホイール（タイムライン上）'], desc: 'カーソル位置を中心にズームイン/アウト（最大20倍）' },
        { keys: ['ミニマップドラッグ'], desc: 'ズーム時に上部表示されるミニマップをドラッグしてパン' },
      ],
    },
    {
      category: '動画',
      items: [
        { keys: ['クリック（動画）'], desc: '再生 / 一時停止' },
        { keys: ['クリック（ブロック）'], desc: 'その字幕の位置にシーク' },
        { keys: ['ドラッグ（シークバー）'], desc: 'シークバーをドラッグして任意の位置へ移動' },
      ],
    },
    {
      category: 'パネル操作',
      items: [
        { keys: ['←→ドラッグ（中央ハンドル）'], desc: '左右パネルの幅を調整（25〜72%）' },
        { keys: ['↕ドラッグ（動画/タイムライン境界）'], desc: 'タイムラインの高さを調整（30〜200px）' },
      ],
    },
  ],
  aiAskTitle: 'AI に質問する',
  aiAskDesc: '将来的にはこの画面でツールの使い方やプロンプト調整の疑問を AI に直接聞けるようにする予定です。',

  settingsColorTheme: 'カラーテーマ',
  settingsLanguage: '言語',
  pocThemeDesc: 'ダークブルー系（開発用デフォルト）',
  matsuoThemeDesc: 'ホワイト×グレー×東大ブルー',
}
