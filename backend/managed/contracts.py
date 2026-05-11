from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Protocol


@dataclass(frozen=True)
class ManagedServiceConfig:
    service: str
    version: str
    upload_strategy: str
    max_size_bytes: int
    workflow: str
    auth_mode: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "service": self.service,
            "version": self.version,
            "auth": {"mode": self.auth_mode},
            "upload": {
                "strategy": self.upload_strategy,
                "max_size_bytes": self.max_size_bytes,
            },
            "jobs": {"workflow": self.workflow},
        }


@dataclass(frozen=True)
class ManagedUploadTarget:
    object_key: str
    upload_url: str
    upload_method: str = "PUT"
    upload_headers: dict[str, str] = field(default_factory=dict)
    filename: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "upload_url": self.upload_url,
            "upload_method": self.upload_method,
            "upload_headers": self.upload_headers,
            "object_key": self.object_key,
            "filename": self.filename,
        }


@dataclass(frozen=True)
class ManagedJobHandle:
    job_id: str
    status: str
    workflow: str
    input_key: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "job_id": self.job_id,
            "status": self.status,
            "workflow": self.workflow,
            "input_key": self.input_key,
        }


class UploadTargetService(Protocol):
    def create_upload(self, filename: str, upload_url_factory: Callable[[str], str] | None = None) -> ManagedUploadTarget: ...

    def receive_upload(self, upload_id: str, body: bytes) -> dict[str, Any]: ...


class JobOrchestrator(Protocol):
    def create_job(
        self,
        *,
        source_name: str,
        input_key: str,
        workflow: str,
        execution_mode: str,
        schema_version: str,
    ) -> ManagedJobHandle: ...

    def get_job_status(self, job_id: str) -> dict[str, Any] | None: ...


class ResultStore(Protocol):
    def get_job_result(self, job_id: str) -> dict[str, Any] | None: ...


class ManagedAdapter(UploadTargetService, JobOrchestrator, ResultStore, Protocol):
    def get_service_config(self) -> ManagedServiceConfig: ...

    def check_connection(self) -> dict[str, Any]: ...
