# Sprint Plan: DAG実行基盤と監査レポート統合（2026-04-04）

## スプリント目標

- Drop-First UXを維持したまま、実行系を「フロント内スタブ」から「バックエンドDAG実行」へ移行する。
- 人間レビューのために、全ノードの実行根拠を保存し、要確認項目を優先度で絞り込める状態にする。

## スコープ（今回）

### 1. バックエンド実行APIの固定
- `POST /api/pipeline/runs`（start）
- `GET /api/pipeline/runs/{run_id}`（status）
- `GET /api/pipeline/runs/{run_id}/result`（result）
- `POST /api/pipeline/runs/{run_id}/cancel`（cancel）

### 2. DAG 4コアノードの実処理化
- `transcribe`
- `correct`
- `translate`
- `subtitle`

### 3. 監査ログをバックエンド起点へ統一
- `RunState` から `node_traces` / `review_items` を生成
- provider/model/retry/error/duration を保存

### 4. 品質ゲート3ノードを有効化
- `semantic_check`
- `terminology_check`
- `cps_guard`

### 5. Policyループを有効化
- NG時の再実行
- 最大試行回数・停止理由の記録

### 6. フロントReportを本番データ接続
- APIレスポンスの監査データで表示
- `must_review / should_review / auto_pass` を優先表示

## 今回スコープ外

- 7. ASRダブルチェック（`transcribe_checker + consensus_check`）
  - 効果検証PoC後に採用判断する

## 実装順（固定）

1. API実装
2. 4コアノード実処理化
3. 監査ログ統一
4. 品質ゲート有効化
5. Policyループ有効化
6. フロント接続

## 受け入れ条件（DoD）

- フロントから`start -> status/result`の一連が通る
- 1実行ごとにノードトレースとレビュー優先度が保存される
- `must_review`項目の理由が画面で読める
- ビルドとテストが通る
