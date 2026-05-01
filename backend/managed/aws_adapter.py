from __future__ import annotations

import json
import time
import uuid
from pathlib import Path
from typing import Any

from .contracts import ManagedAdapter, ManagedJobHandle, ManagedServiceConfig, ManagedUploadTarget
from .settings import ManagedServiceSettings


class AwsManagedAdapter(ManagedAdapter):
    def __init__(self, settings: ManagedServiceSettings) -> None:
        settings.require_aws()
        import boto3

        self.settings = settings
        self.session = boto3.session.Session(region_name=settings.aws_region)
        self.s3 = self.session.client("s3")
        self.ddb = self.session.client("dynamodb")
        self.batch = self.session.client("batch")

    def get_service_config(self) -> ManagedServiceConfig:
        return ManagedServiceConfig(
            service=self.settings.service_name,
            version=self.settings.service_version,
            upload_strategy="s3-presigned-put",
            max_size_bytes=self.settings.max_upload_size_bytes,
            workflow=self.settings.default_workflow,
            auth_mode=self.settings.auth_mode,
        )

    def create_upload(self, filename: str, upload_url_factory: callable | None = None) -> ManagedUploadTarget:
        upload_id = str(uuid.uuid4())
        safe_name = Path(filename).name or f"upload-{upload_id}"
        object_key = f"{self.settings.aws_input_prefix}{upload_id}-{safe_name}"
        upload_url = self.s3.generate_presigned_url(
            "put_object",
            Params={
                "Bucket": self.settings.aws_input_bucket,
                "Key": object_key,
                "ContentType": "application/octet-stream",
            },
            ExpiresIn=900,
        )
        return ManagedUploadTarget(
            object_key=object_key,
            upload_url=upload_url,
            upload_method="PUT",
            upload_headers={"Content-Type": "application/octet-stream"},
            filename=safe_name,
        )

    def receive_upload(self, upload_id: str, body: bytes) -> dict[str, Any]:
        raise NotImplementedError("AWS adapter does not support in-process upload receiving")

    def create_job(
        self,
        *,
        source_name: str,
        input_key: str,
        workflow: str,
        execution_mode: str,
        schema_version: str,
    ) -> ManagedJobHandle:
        job_id = str(uuid.uuid4())
        created_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        self.ddb.put_item(
            TableName=self.settings.aws_jobs_table,
            Item={
                "job_id": {"S": job_id},
                "status": {"S": "queued"},
                "current_step": {"S": "queued"},
                "completed_steps": {"L": []},
                "source_name": {"S": source_name},
                "input_key": {"S": input_key},
                "workflow": {"S": workflow},
                "created_at": {"S": created_at},
                "updated_at": {"S": created_at},
            },
        )

        payload = json.dumps(
            {
                "job_id": job_id,
                "source_name": source_name,
                "input_key": input_key,
                "workflow": workflow,
                "execution_mode": execution_mode,
                "schema_version": schema_version,
                "result_bucket": self.settings.aws_result_bucket,
                "result_prefix": self.settings.aws_result_prefix,
                "jobs_table": self.settings.aws_jobs_table,
            },
            ensure_ascii=True,
        )
        batch_response = self.batch.submit_job(
            jobName=f"subtitle-managed-{job_id}",
            jobQueue=self.settings.aws_batch_job_queue,
            jobDefinition=self.settings.aws_batch_job_definition,
            containerOverrides={
                "environment": [
                    {"name": self.settings.aws_job_payload_env, "value": payload},
                ]
            },
        )
        self.ddb.update_item(
            TableName=self.settings.aws_jobs_table,
            Key={"job_id": {"S": job_id}},
            UpdateExpression="SET batch_job_id = :batch_job_id, updated_at = :updated_at",
            ExpressionAttributeValues={
                ":batch_job_id": {"S": str(batch_response["jobId"])},
                ":updated_at": {"S": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())},
            },
        )
        return ManagedJobHandle(job_id=job_id, status="queued", workflow=workflow, input_key=input_key)

    def get_job_status(self, job_id: str) -> dict[str, Any] | None:
        response = self.ddb.get_item(
            TableName=self.settings.aws_jobs_table,
            Key={"job_id": {"S": job_id}},
            ConsistentRead=True,
        )
        item = response.get("Item")
        if not item:
            return None
        completed_steps = [entry.get("S", "") for entry in item.get("completed_steps", {}).get("L", []) if entry.get("S")]
        return {
            "job_id": job_id,
            "status": item.get("status", {}).get("S", "queued"),
            "current_step": item.get("current_step", {}).get("S"),
            "completed_steps": completed_steps,
            "total_steps": 1,
            "result_key": item.get("result_key", {}).get("S"),
            "error": item.get("error", {}).get("S"),
            "created_at": item.get("created_at", {}).get("S"),
            "updated_at": item.get("updated_at", {}).get("S"),
        }

    def get_job_result(self, job_id: str) -> dict[str, Any] | None:
        status = self.get_job_status(job_id)
        if not status:
            return None
        result_key = status.get("result_key")
        if not result_key:
            return None
        result_obj = self.s3.get_object(Bucket=self.settings.aws_result_bucket, Key=result_key)
        body = result_obj["Body"].read().decode("utf-8")
        payload = json.loads(body)
        payload.setdefault("job_id", job_id)
        payload.setdefault("status", status["status"])
        return payload
