from __future__ import annotations

import os
from dataclasses import dataclass
from functools import cached_property


def _env(name: str, default: str | None = None) -> str | None:
    value = os.getenv(name)
    return value if value not in ("", None) else default


def _require_env(name: str) -> str:
    value = _env(name)
    if not value:
        raise RuntimeError(f"missing required environment variable: {name}")
    return value


@dataclass(frozen=True)
class ManagedServiceSettings:
    backend_mode: str = "local"
    service_name: str = "subtitle-managed-service"
    service_version: str = "0.3.0"
    default_workflow: str = "managed_transcript_v1"
    max_upload_size_bytes: int = 5 * 1024 * 1024 * 1024
    auth_mode: str = "none"
    bearer_token: str | None = None
    bearer_token_secret_name: str | None = None
    aws_region: str | None = None
    aws_input_bucket: str | None = None
    aws_result_bucket: str | None = None
    aws_jobs_table: str | None = None
    aws_batch_job_queue: str | None = None
    aws_batch_job_definition: str | None = None
    aws_result_prefix: str = "results/"
    aws_input_prefix: str = "input-audio/"
    aws_job_payload_env: str = "AWS_MANAGED_JOB_PAYLOAD"

    @classmethod
    def from_env(cls) -> "ManagedServiceSettings":
        auth_mode = _env("MANAGED_SERVICE_AUTH_MODE", "none") or "none"
        bearer_token = _env("MANAGED_SERVICE_BEARER_TOKEN")
        bearer_token_secret_name = _env("MANAGED_SERVICE_BEARER_TOKEN_SECRET_NAME")
        return cls(
            backend_mode=_env("MANAGED_SERVICE_BACKEND", "local") or "local",
            service_name=_env("MANAGED_SERVICE_NAME", "subtitle-managed-service") or "subtitle-managed-service",
            service_version=_env("MANAGED_SERVICE_VERSION", "0.3.0") or "0.3.0",
            default_workflow=_env("MANAGED_SERVICE_DEFAULT_WORKFLOW", "managed_transcript_v1") or "managed_transcript_v1",
            max_upload_size_bytes=int(_env("MANAGED_SERVICE_MAX_UPLOAD_SIZE_BYTES", str(5 * 1024 * 1024 * 1024)) or str(5 * 1024 * 1024 * 1024)),
            auth_mode=auth_mode,
            bearer_token=bearer_token,
            bearer_token_secret_name=bearer_token_secret_name,
            aws_region=_env("AWS_REGION") or _env("AWS_DEFAULT_REGION"),
            aws_input_bucket=_env("MANAGED_SERVICE_AWS_INPUT_BUCKET"),
            aws_result_bucket=_env("MANAGED_SERVICE_AWS_RESULT_BUCKET"),
            aws_jobs_table=_env("MANAGED_SERVICE_AWS_JOBS_TABLE"),
            aws_batch_job_queue=_env("MANAGED_SERVICE_AWS_BATCH_JOB_QUEUE"),
            aws_batch_job_definition=_env("MANAGED_SERVICE_AWS_BATCH_JOB_DEFINITION"),
            aws_result_prefix=_env("MANAGED_SERVICE_AWS_RESULT_PREFIX", "results/") or "results/",
            aws_input_prefix=_env("MANAGED_SERVICE_AWS_INPUT_PREFIX", "input-audio/") or "input-audio/",
            aws_job_payload_env=_env("MANAGED_SERVICE_AWS_JOB_PAYLOAD_ENV", "AWS_MANAGED_JOB_PAYLOAD") or "AWS_MANAGED_JOB_PAYLOAD",
        )

    @cached_property
    def resolved_bearer_token(self) -> str | None:
        if self.bearer_token:
            return self.bearer_token
        if not self.bearer_token_secret_name:
            return None
        import boto3

        session = boto3.session.Session(region_name=self.aws_region)
        secrets = session.client("secretsmanager")
        response = secrets.get_secret_value(SecretId=self.bearer_token_secret_name)
        return response.get("SecretString")

    def verify_bearer_token(self, token: str | None) -> bool:
        if self.auth_mode != "bearer_token":
            return True
        if not token:
            return False
        expected = self.resolved_bearer_token
        if not expected:
            return False
        return token == expected

    def require_aws(self) -> None:
        _require_env("AWS_REGION")
        _require_env("MANAGED_SERVICE_AWS_INPUT_BUCKET")
        _require_env("MANAGED_SERVICE_AWS_RESULT_BUCKET")
        _require_env("MANAGED_SERVICE_AWS_JOBS_TABLE")
        _require_env("MANAGED_SERVICE_AWS_BATCH_JOB_QUEUE")
        _require_env("MANAGED_SERVICE_AWS_BATCH_JOB_DEFINITION")
