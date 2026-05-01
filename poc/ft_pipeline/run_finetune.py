"""
OpenAI Fine-tuning ジョブ管理スクリプト。

使い方:
    python run_finetune.py                        # 新規FT
    python run_finetune.py --base ft:gpt-4o-...  # 既存FTモデルから継続学習

環境変数:
    OPENAI_API_KEY  (必須)

出力:
    完了後に fine_tuned_model ID を標準出力に表示
"""

import argparse
import os
import time
from pathlib import Path

from openai import OpenAI

BASE_MODEL = "gpt-4o-mini-2024-07-18"
POLL_INTERVAL = 60  # 秒

OUTPUT_DIR = Path(__file__).parent / "output"
TRAIN_PATH = OUTPUT_DIR / "train.jsonl"
VAL_PATH = OUTPUT_DIR / "val.jsonl"


def upload_file(client: OpenAI, path: Path) -> str:
    print(f"アップロード中: {path.name} ...", end=" ", flush=True)
    with open(path, "rb") as f:
        resp = client.files.create(file=f, purpose="fine-tune")
    print(f"done → {resp.id}")
    return resp.id


def create_job(client: OpenAI, train_id: str, val_id: str, base_model: str) -> str:
    print(f"\nFTジョブ作成中 (base: {base_model}) ...")
    resp = client.fine_tuning.jobs.create(
        training_file=train_id,
        validation_file=val_id,
        model=base_model,
        suffix="subtitle-style",
    )
    print(f"ジョブID: {resp.id}")
    return resp.id


def poll_until_done(client: OpenAI, job_id: str) -> str | None:
    print(f"\nジョブ完了待機中（{POLL_INTERVAL}秒ごとに確認）...")
    while True:
        job = client.fine_tuning.jobs.retrieve(job_id)
        status = job.status
        print(f"  [{time.strftime('%H:%M:%S')}] status: {status}")

        # 最新イベントを表示
        events = client.fine_tuning.jobs.list_events(fine_tuning_job_id=job_id, limit=3)
        for ev in reversed(events.data):
            print(f"    > {ev.message}")

        if status == "succeeded":
            model_id = job.fine_tuned_model
            print(f"\n完了！fine_tuned_model: {model_id}")
            return model_id
        elif status in ("failed", "cancelled"):
            print(f"\nジョブが {status} で終了しました。")
            if job.error:
                print(f"エラー: {job.error}")
            return None

        time.sleep(POLL_INTERVAL)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--base",
        default=BASE_MODEL,
        help="ベースモデルID。既存FTモデルIDを指定すると継続学習になる。",
    )
    args = parser.parse_args()

    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY 環境変数が設定されていません。")

    if not TRAIN_PATH.exists():
        raise FileNotFoundError(f"{TRAIN_PATH} が存在しません。先に prepare_data.py を実行してください。")

    client = OpenAI(api_key=api_key)

    train_id = upload_file(client, TRAIN_PATH)
    val_id = upload_file(client, VAL_PATH) if VAL_PATH.exists() else None

    job_id = create_job(client, train_id, val_id, args.base)

    model_id = poll_until_done(client, job_id)

    if model_id:
        print(f"\n.env に以下を追加してください:")
        print(f"  OPENAI_LLM_MODEL={model_id}")


if __name__ == "__main__":
    main()
