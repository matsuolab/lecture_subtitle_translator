from __future__ import annotations

import os
import tempfile
import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..pipeline.service import PipelineService
from ..pipeline.results import build_transcript_job_result
from .contracts import ManagedAdapter, ManagedJobHandle, ManagedServiceConfig, ManagedUploadTarget
from .settings import ManagedServiceSettings


@dataclass
class StoredUpload:
    upload_id: str
    filename: str
    path: Path
    created_at: float
    size_bytes: int = 0
    uploaded: bool = False


class LocalManagedAdapter(ManagedAdapter):
    def __init__(self, settings: ManagedServiceSettings, pipeline_service: PipelineService | None = None) -> None:
        self.settings = settings
        self.pipeline_service = pipeline_service or PipelineService()
        self._upload_lock = threading.Lock()
        self._uploads: dict[str, StoredUpload] = {}
        self._upload_root = Path(tempfile.gettempdir()) / "matsuo-subtitle-managed-uploads"
        self._upload_root.mkdir(parents=True, exist_ok=True)

    def get_service_config(self) -> ManagedServiceConfig:
        return ManagedServiceConfig(
            service=self.settings.service_name,
            version=self.settings.service_version,
            upload_strategy="local-put",
            max_size_bytes=self.settings.max_upload_size_bytes,
            workflow=self.settings.default_workflow,
            auth_mode=self.settings.auth_mode,
        )

    def check_connection(self) -> dict[str, Any]:
        config = self.get_service_config().to_dict()
        probe_path = self._upload_root / f".connection-check-{uuid.uuid4().hex}"
        checks: list[dict[str, Any]] = []
        try:
            self._upload_root.mkdir(parents=True, exist_ok=True)
            probe_path.write_bytes(b"ok")
            checks.append({"name": "upload_storage", "ok": True, "detail": str(self._upload_root)})
        except OSError as exc:
            checks.append({"name": "upload_storage", "ok": False, "detail": str(exc)})
        finally:
            try:
                os.unlink(probe_path)
            except FileNotFoundError:
                pass
            except OSError:
                pass

        return {
            **config,
            "ok": all(check["ok"] for check in checks),
            "checks": checks,
        }

    def create_upload(self, filename: str, upload_url_factory: callable | None = None) -> ManagedUploadTarget:
        if upload_url_factory is None:
            raise RuntimeError("local adapter requires upload_url_factory")
        upload_id = str(uuid.uuid4())
        safe_name = Path(filename).name or f"upload-{upload_id}"
        target_path = self._upload_root / f"{upload_id}-{safe_name}"
        with self._upload_lock:
            self._uploads[upload_id] = StoredUpload(
                upload_id=upload_id,
                filename=safe_name,
                path=target_path,
                created_at=time.time(),
            )
        return ManagedUploadTarget(
            object_key=upload_id,
            upload_url=upload_url_factory(upload_id),
            upload_method="PUT",
            upload_headers={},
            filename=safe_name,
        )

    def receive_upload(self, upload_id: str, body: bytes) -> dict[str, Any]:
        stored = self._get_upload(upload_id)
        if not stored:
            raise KeyError("upload not found")
        stored.path.parent.mkdir(parents=True, exist_ok=True)
        stored.path.write_bytes(body)
        with self._upload_lock:
            stored.size_bytes = len(body)
            stored.uploaded = True
        return {
            "upload_id": upload_id,
            "object_key": upload_id,
            "size_bytes": len(body),
            "status": "uploaded",
        }

    def create_job(
        self,
        *,
        source_name: str,
        input_key: str,
        workflow: str,
        execution_mode: str,
        schema_version: str,
    ) -> ManagedJobHandle:
        stored = self._get_upload(input_key)
        if not stored:
            raise KeyError("input upload not found")
        if not stored.uploaded or not stored.path.exists():
            raise RuntimeError("input upload is not ready")

        initial_data: dict[str, Any] = {
            "source_name": source_name,
            "audio_path": str(stored.path),
            "execution_mode": execution_mode,
            "allow_transcribe_fallback": False,
        }

        payload = {
            "workflow": workflow,
            "source_name": source_name,
            "initial_data": initial_data,
            "schema_version": schema_version,
        }
        started = self.pipeline_service.start_run(payload)
        run_id = str(started["run_id"])
        return ManagedJobHandle(
            job_id=run_id,
            status=str(started.get("status", "queued")),
            workflow=str(started.get("workflow", workflow)),
            input_key=input_key,
        )

    def get_job_status(self, job_id: str) -> dict[str, Any] | None:
        status = self.pipeline_service.get_status(job_id)
        if not status:
            return None
        return {
            "job_id": job_id,
            "status": status["status"],
            "current_step": status.get("current_node"),
            "completed_steps": status.get("completed_nodes", []),
            "total_steps": status.get("total_nodes", 0),
            "step_elapsed_sec": status.get("node_elapsed_sec"),
            "error": status.get("error"),
        }

    def get_job_result(self, job_id: str) -> dict[str, Any] | None:
        result = self.pipeline_service.get_result(job_id)
        if not result:
            return None
        return build_transcript_job_result(result, job_id=job_id)

    def _get_upload(self, upload_id: str) -> StoredUpload | None:
        with self._upload_lock:
            return self._uploads.get(upload_id)
