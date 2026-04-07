"""
AWS Batch WhisperX Provider。
S3 に音声をアップロード → Batch ジョブ投入 → ポーリング → 結果取得。

設計: docs/research/20260326_whisperx_deployment_options.md の
      AWS Batch 構成をそのまま実装。
"""

from __future__ import annotations

import asyncio
import json
import os
import uuid
from pathlib import Path

import boto3  # type: ignore[import]

from ..models.segment import TranscriptSegment, WordTimestamp
from .base import TranscribeProvider


class AWSBatchWhisperXProvider(TranscribeProvider):
    def __init__(
        self,
        job_queue: str | None = None,
        job_definition: str | None = None,
        s3_bucket: str | None = None,
        region: str | None = None,
        poll_interval: int = 30,
    ) -> None:
        self._job_queue = job_queue or os.environ["AWS_BATCH_JOB_QUEUE"]
        self._job_definition = job_definition or os.environ["AWS_BATCH_JOB_DEFINITION"]
        self._s3_bucket = s3_bucket or os.environ["AWS_S3_BUCKET"]
        self._region = region or os.getenv("AWS_REGION", "ap-northeast-1")
        self._poll_interval = poll_interval

        self._batch = boto3.client("batch", region_name=self._region)
        self._s3 = boto3.client("s3", region_name=self._region)

    async def transcribe(self, audio_path: str) -> list[TranscriptSegment]:
        job_id = str(uuid.uuid4())[:8]
        input_key = f"inputs/{Path(audio_path).name}_{job_id}.wav"
        output_key = f"outputs/{Path(audio_path).stem}_{job_id}.json"

        # 1. S3 にアップロード（非同期で executor 経由）
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(
            None, self._upload, audio_path, input_key
        )
        print(f"      [Batch] S3 アップロード完了: s3://{self._s3_bucket}/{input_key}")

        # 2. Batch ジョブ投入
        batch_job_id = await loop.run_in_executor(
            None, self._submit_job, input_key, output_key
        )
        print(f"      [Batch] ジョブ投入: {batch_job_id}")

        # 3. 完了待機（ポーリング）
        await self._wait_for_job(batch_job_id)
        print(f"      [Batch] ジョブ完了")

        # 4. 結果取得
        result = await loop.run_in_executor(
            None, self._fetch_result, output_key
        )

        return self._to_segments(result["segments"])

    def _upload(self, local_path: str, s3_key: str) -> None:
        self._s3.upload_file(local_path, self._s3_bucket, s3_key)

    def _submit_job(self, input_key: str, output_key: str) -> str:
        response = self._batch.submit_job(
            jobName=f"whisperx-{Path(input_key).stem[:40]}",
            jobQueue=self._job_queue,
            jobDefinition=self._job_definition,
            containerOverrides={
                "environment": [
                    {"name": "S3_BUCKET", "value": self._s3_bucket},
                    {"name": "INPUT_KEY", "value": input_key},
                    {"name": "OUTPUT_KEY", "value": output_key},
                ]
            },
        )
        return response["jobId"]

    async def _wait_for_job(self, job_id: str) -> None:
        loop = asyncio.get_event_loop()
        while True:
            status = await loop.run_in_executor(
                None, self._get_job_status, job_id
            )
            print(f"      [Batch] ステータス: {status}")
            if status == "SUCCEEDED":
                return
            if status == "FAILED":
                raise RuntimeError(f"Batch ジョブが失敗しました: {job_id}")
            await asyncio.sleep(self._poll_interval)

    def _get_job_status(self, job_id: str) -> str:
        resp = self._batch.describe_jobs(jobs=[job_id])
        return resp["jobs"][0]["status"]

    def _fetch_result(self, output_key: str) -> dict:
        obj = self._s3.get_object(Bucket=self._s3_bucket, Key=output_key)
        return json.loads(obj["Body"].read().decode("utf-8"))

    @staticmethod
    def _to_segments(raw_segments: list[dict]) -> list[TranscriptSegment]:
        segments: list[TranscriptSegment] = []
        for i, seg in enumerate(raw_segments):
            words = tuple(
                WordTimestamp(
                    word=w.get("word", w.get("char", "")),
                    start=w.get("start", seg["start"]),
                    end=w.get("end", seg["end"]),
                    confidence=w.get("probability", w.get("score", 1.0)),
                )
                for w in seg.get("words", seg.get("chars", []))
            )
            segments.append(
                TranscriptSegment(
                    id=i,
                    start=seg["start"],
                    end=seg["end"],
                    text=seg["text"].strip(),
                    words=words,
                )
            )
        return segments
