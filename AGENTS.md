# matsuo-subtitle-pipeline プロジェクト指示

## プロジェクト概要

東京大学 松尾研DXプロジェクト第三期。講義動画の英語字幕化パイプラインの研究・開発。

---

## AWS MCP 運用ルール

AWS 関連の作業では、`list_mcp_resources` / `list_mcp_resource_templates` が空でも
AWS MCP が使えないとは判断しないこと。
この環境では AWS MCP は resource ではなく専用ツールとして提供されることがある。

### 可用性確認の必須手順

まず次のいずれかを直接実行して、現ターンでの AWS MCP 可用性を確認すること。

- `mcp__aws_mcp__aws___list_regions`
- `mcp__aws_mcp__aws___search_documentation`

直接の tool 呼び出しが失敗した場合にのみ、
AWS MCP がこのターンで使えない可能性を検討する。

### `call_aws` 単発失敗の扱い

`mcp__aws_mcp__aws___call_aws` の単発失敗だけを根拠に、
AWS MCP 不可と判断してはいけない。

`call_aws` が失敗した場合は、次の順で切り分けること。

1. 失敗種別を分類する
   - `Unknown tool`:
     tool 登録 / 可視性の問題の可能性。AWS API 失敗とは扱わない
   - `AccessDeniedException` / `ExpiredTokenException` / `UnrecognizedClientException`:
     AWS MCP は使えているが、認証・認可の問題
   - `ValidationException` / `ResourceNotFoundException`:
     コマンド引数、対象名、リージョン、対象状態の問題
   - `ThrottlingException` / `ServiceUnavailable` / `RequestTimeout`:
     一時的な AWS 側失敗。少し待って再試行する

2. `call_aws` 失敗直後に canary を再実行する
   - `mcp__aws_mcp__aws___list_regions`
   - または `mcp__aws_mcp__aws___search_documentation`

3. canary が成功した場合
   - AWS MCP は利用可能とみなし、`call_aws` の引数・権限・対象状態を修正して続行する

4. AWS MCP 不可と判断してよい条件
   - 少なくとも 2 種類の AWS MCP 専用ツール
     （例: `list_regions` と `search_documentation`）が
     現ターンで直接失敗した場合のみ

5. 長いスレッドやコンテキスト圧縮後でも、
   過去の失敗ログを根拠に不可判定しないこと。
   必ず現ターンで canary を再実行して判定すること。

---

## リサーチログのルール（必須）

**調査・リサーチを行ったときは必ず `docs/research/` 配下にログファイルを作成すること。**

### ファイル命名規則

```
docs/research/YYYYMMDD_<トピック名>.md
```

例：
- `docs/research/20260327_whisperx_deployment_options.md`
- `docs/research/20260327_cat_tools_survey.md`

### ファイルの必須構成

```markdown
# <調査タイトル>

> 作成: YYYY-MM-DD
> 目的: <なぜこの調査を行ったか・何を判断するための調査か>

---

## 調査先・調査方法

<調査したソース・URL・ドキュメント・コードリポジトリの一覧>

---

## 調査結果

<調査内容の詳細。表・コードブロック・引用を積極的に使う>

---

## 本プロジェクトへの示唆

<調査結果が設計・実装判断にどう影響するか>

---

## 未解決・追加調査が必要なテーマ（あれば）

<今回調査しきれなかったことや、将来調査すべきテーマ>
```

### 粒度・詳しさの基準

- **数値・バージョン・URL は必ず記録する**（「安い」ではなく「$0.21/時間」）
- **比較した選択肢は全て残す**（採用しなかった理由も記録する）
- **「なぜその結論になったか」の論拠を書く**（結論だけでなく推論過程も）
- コードサンプル・設定例・アーキテクチャ図（ASCII）は積極的に含める

### 既存の調査ファイルが存在する場合

追加調査した場合は新規ファイルを作らず、既存ファイルに `## 追記: YYYY-MM-DD` セクションを追加すること。

---

## 会議準備ルール

### ongoing_issues.md（必須メンテ）

`10_meetings/ongoing_issues.md` は継続課題・決定事項の一元管理ファイル。
以下のタイミングで必ず更新すること：

- 新しい課題が判明したとき → 未解決課題テーブルに追記
- 課題が解決したとき → 取り消し線 + 解決日を記入して「解決済み」セクションへ移動
- 会議で決定事項が出たとき → 決定事項テーブルに追記
- 次回に持ち込む議題が決まったとき → 議題候補リストに追記

### /mtg コマンド

`/mtg` を実行すると、次回会議のドラフト資料を自動生成する。
会議の1〜2日前に実行し、ドラフトを確認・編集してから使用すること。

---

## ドキュメント管理ルール

### 単一情報源の原則（Single Source of Truth）

| 知りたいこと | 参照すべきファイル |
|------------|----------------|
| 今どのフェーズ？R1は終わった？ | `00_context/project_overview.md` → ミニリリース計画 |
| 次MTGまでに何をやる？ | `10_meetings/ongoing_issues.md` → 実装タスク |
| 未解決の課題は？ | `10_meetings/ongoing_issues.md` → 未解決の課題 |
| あの会議で何が決まった？ | `10_meetings/YYYYMMDD_*.md` |
| この技術の調査結果は？ | `docs/research/YYYYMMDD_*.md` |
| **どうやって配布・リリースする？** | **`.github/workflows/release.yml`** |
| **ビルド・CIの仕組みは？** | **`.github/workflows/build.yml`** |

### いつ更新するか（トリガー）

**`ongoing_issues.md` を必ず更新するタイミング：**
- 実装タスクが完了したとき → 取り消し線 + 完了日を記入
- 新しい課題・バグが見つかったとき → 未解決課題テーブルに追記
- 会議が終わったとき → 決定事項・次回議題を反映

**`project_overview.md` を必ず更新するタイミング：**
- リリースフェーズ（R1〜R5）の状態が変わったとき
- 完了済み機能が増えたとき → 「完了済み機能」リストに追記
- `.github/workflows/` を変更したとき → 配布・ビルド方法の記述を合わせて更新する

**`docs/research/` に必ずログを作成するタイミング：**
- 技術調査・OSS評価・API比較を行ったとき（調査したら必ずログ残す）

### 「何をどこに書くか」一覧

| 書きたい内容 | 書く場所 | 備考 |
|------------|---------|------|
| フェーズ進捗（R1〜R5の状態） | `00_context/project_overview.md` の「ミニリリース計画」 | リリース単位の粒度 |
| 次MTGまでの実装タスク | `10_meetings/ongoing_issues.md` | スプリント単位。MTG後に更新 |
| 継続課題・未解決問題 | `10_meetings/ongoing_issues.md` | 解決したら取り消し線+解決日 |
| 会議の記録 | `10_meetings/YYYYMMDD_*.md` | 進捗情報は持たない。ログのみ |
| 技術調査結果 | `docs/research/YYYYMMDD_<トピック>.md` | 数値・URL・比較表を必ず含める |
| アイデア・機能提案 | `docs/ideas.md` | 実装決定前のストック置き場 |
| プロジェクト背景・要件 | `00_context/` 配下 | 変わらない前提情報 |

### 禁止事項

- `task_list.md` は廃止済み。**書かない・更新しない**（アーカイブ: `task_list_archived_20260324.md`）
- 同じ情報を複数ファイルに書かない（ongoing_issues と project_overview の重複禁止）
- スプリントタスクを会議ログに直接書かない（ongoing_issues に書く）
- 開発状況を確認するとき `task_list.md` を参照しない（廃止済み）
- **配布・ビルド方法を文書に書くときは必ず `.github/workflows/` の実ファイルを参照して確認する**（思い込みで書かない）

## セッション終了フロー（/clear前に必ず実行）

`/clear` の前に必ずこの順番で実行すること。

```
① 下記チェックリストを実行（プロジェクト文書の更新）
② /save（重要な決定・アイデアをVaultに保存）
③ /clear
```

### チェックリスト

| # | チェック項目 | 参照・更新先 |
|---|------------|------------|
| 1 | このセッションで実装・完了した機能が完了済み機能リストに追記されているか | `00_context/project_overview.md` |
| 2 | R1〜R5の状態が実態（コード・GitHub Actions）と一致しているか | `00_context/project_overview.md` |
| 3 | 完了したタスクに取り消し線＋完了日が入っているか | `10_meetings/ongoing_issues.md` |
| 4 | 新たに判明した課題・バグが未解決課題テーブルに追記されているか | `10_meetings/ongoing_issues.md` |
| 5 | `.github/workflows/` を変更した場合、配布・ビルド方法の記述が更新されているか | `00_context/project_overview.md` |
| 6 | このセッションで技術調査を行った場合、`docs/research/` にログが作成されているか | `docs/research/YYYYMMDD_*.md` |
| 7 | 新しいアイデア・機能提案が出た場合、`docs/ideas.md` に記録されているか | `docs/ideas.md` |

---

## フォルダ構成

| フォルダ | 内容 |
|----------|------|
| `00_context/` | プロジェクト背景・要件・用語集 |
| `10_meetings/` | 会議ログ・議事録・発表資料 |
| `10_meetings/ongoing_issues.md` | **継続課題・決定事項（随時更新）** |
| `docs/` | 設計書・技術選定ドキュメント |
| `docs/research/` | **調査ログ（日付入り）** |
| `docs/ideas.md` | アイデア・機能提案メモ |
| `poc/` | PoC（概念実証）コード・実験メモ |
| `backend/` | バックエンド実装 |
| `frontend/` | 字幕エディタUIモック（React + Vite） |
