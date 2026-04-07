# Backend (DAG Runner Scaffold)

このディレクトリは、字幕パイプラインのDAG実装の最小骨格です。

## 目的

- ノード差し替え可能な実行基盤を先に用意する
- 直列4工程をDAG上で再現する
- 将来の品質ゲート（意味近似/用語漏れ/CPS）を追加しやすくする

## 主なモジュール

- `pipeline/contracts.py`: NodeContract / NodeResult / RunState
- `pipeline/workflow.py`: NodeSpec / Edge / WorkflowDefinition
- `pipeline/registry.py`: ノード実装の登録・解決
- `pipeline/policy.py`: retry/fail判定
- `pipeline/runner.py`: DAG実行
- `pipeline/service.py`: 実行Runの保持と監査データ生成
- `pipeline/workflows/drop_first.py`: ワークフロー定義
- `pipeline/nodes/*`: スタブノード実装
- `api.py`: FastAPIエンドポイント

## API

- `POST /api/pipeline/runs` : 実行開始
- `GET /api/pipeline/runs/{run_id}` : ステータス取得
- `GET /api/pipeline/runs/{run_id}/result` : 実行結果 + 監査データ取得
- `POST /api/pipeline/runs/{run_id}/cancel` : 実行キャンセル

## 実行方法

```bash
cd backend
python -m pip install -r requirements.txt
uvicorn backend.api:app --reload --port 8765
```

## 次ステップ

1. スタブノードを `poc/step2_pipeline` の実処理へ差し替える
2. `schema_version` を用いた互換性チェックを厳密化する
3. フロントのReportタブをAPIレスポンスへ接続する


## ローカルWhisperX連携（任意）

`transcribe` ノードは次の入力を受けると、外部WhisperXプロジェクトを呼び出せます。

- `initial_data.whisperx_project_dir`: 例 `E:/TEMP/kaihatu/whisperx-transcriber`
- `initial_data.audio_path`: 処理対象の音声ファイル絶対パス
- `initial_data.strict_external_whisperx`: `true` の場合、外部WhisperX失敗時にフォールバックせず失敗終了

指定がない場合は、現在の決定論フォールバックでセグメントを生成します。
