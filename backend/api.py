from __future__ import annotations

import logging
import time
from typing import Any

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from .managed import build_managed_services
from .pipeline.service import PipelineService

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger(__name__)

app = FastAPI(title="Subtitle Pipeline API", version="0.3.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://127.0.0.1:5173",
        "http://localhost:5173",
        "http://tauri.localhost",
        "https://tauri.localhost",
        "tauri://localhost",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def log_requests(request: Request, call_next: Any) -> Response:
    t0 = time.perf_counter()
    response: Response = await call_next(request)
    elapsed_ms = int((time.perf_counter() - t0) * 1000)
    if request.method != "OPTIONS":
        log.info("%s %s → %d (%dms)", request.method, request.url.path, response.status_code, elapsed_ms)
    return response


managed_services = build_managed_services()
service: PipelineService = managed_services.pipeline_service
managed_adapter = managed_services.adapter
managed_settings = managed_services.settings


class StartRunRequest(BaseModel):
    workflow: str = Field(default="drop_first_with_quality_v1")
    source_name: str = Field(default="unknown.mp4")
    initial_data: dict[str, Any] = Field(default_factory=dict)
    schema_version: str = Field(default="1.0")
    max_total_steps: int = Field(default=200)


class CreateUploadRequest(BaseModel):
    filename: str = Field(default="unknown.mp4")
    content_type: str | None = None


class CreateJobRequest(BaseModel):
    source_name: str = Field(default="unknown.mp4")
    input_key: str
    workflow: str = Field(default="drop_first_with_quality_v1")
    runtime_settings: dict[str, Any] = Field(default_factory=dict)
    execution_mode: str = Field(default="production")
    glossary_terms: list[dict[str, Any]] = Field(default_factory=list)
    semantic_score_override: float | None = None
    schema_version: str = Field(default="1.0")
    max_total_steps: int = Field(default=200)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/v1/service-config")
def get_service_config() -> dict[str, Any]:
    return managed_adapter.get_service_config().to_dict()


@app.post("/v1/uploads")
def create_upload(req: CreateUploadRequest, request: Request) -> dict[str, Any]:
    _require_managed_auth(request)
    upload = managed_adapter.create_upload(
        filename=req.filename,
        upload_url_factory=lambda upload_id: str(request.url_for("put_upload_content", upload_id=upload_id)),
    )
    return upload.to_dict()


@app.put("/v1/uploads/{upload_id}/content", name="put_upload_content")
async def put_upload_content(upload_id: str, request: Request) -> dict[str, Any]:
    _require_managed_auth(request)
    body = await request.body()
    if not body:
        raise HTTPException(status_code=400, detail="upload body is empty")
    try:
        return managed_adapter.receive_upload(upload_id, body)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except NotImplementedError as exc:
        raise HTTPException(status_code=405, detail=str(exc)) from exc


@app.post("/v1/jobs")
def create_job(req: CreateJobRequest, request: Request) -> dict[str, Any]:
    _require_managed_auth(request)
    try:
        handle = managed_adapter.create_job(
            source_name=req.source_name,
            input_key=req.input_key,
            workflow=req.workflow,
            runtime_settings=req.runtime_settings,
            execution_mode=req.execution_mode,
            glossary_terms=req.glossary_terms,
            semantic_score_override=req.semantic_score_override,
            schema_version=req.schema_version,
            max_total_steps=req.max_total_steps,
        )
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return handle.to_dict()


@app.get("/v1/jobs/{job_id}")
def get_job_status(job_id: str, request: Request) -> dict[str, Any]:
    _require_managed_auth(request)
    status = managed_adapter.get_job_status(job_id)
    if not status:
        raise HTTPException(status_code=404, detail="job not found")
    return status


@app.get("/v1/jobs/{job_id}/result")
def get_job_result(job_id: str, request: Request) -> dict[str, Any]:
    _require_managed_auth(request)
    status = managed_adapter.get_job_status(job_id)
    if not status:
        raise HTTPException(status_code=404, detail="job not found")
    if status["status"] in ("queued", "running"):
        raise HTTPException(status_code=202, detail="job not finished yet")
    result = managed_adapter.get_job_result(job_id)
    if not result:
        raise HTTPException(status_code=404, detail="result not available")
    return result


@app.post("/api/pipeline/runs")
def start_run(req: StartRunRequest) -> dict[str, Any]:
    return service.start_run(req.model_dump())


@app.get("/api/pipeline/runs/{run_id}")
def get_status(run_id: str) -> dict[str, Any]:
    status = service.get_status(run_id)
    if not status:
        raise HTTPException(status_code=404, detail="run not found")
    return status


@app.get("/api/pipeline/runs/{run_id}/result")
def get_result(run_id: str) -> dict[str, Any]:
    status = service.get_status(run_id)
    if not status:
        raise HTTPException(status_code=404, detail="run not found")
    if status["status"] in ("queued", "running"):
        raise HTTPException(status_code=202, detail="run not finished yet")
    result = service.get_result(run_id)
    if not result:
        raise HTTPException(status_code=404, detail="result not available")
    return result


@app.post("/api/pipeline/runs/{run_id}/cancel")
def cancel_run(run_id: str) -> dict[str, Any]:
    result = service.cancel_run(run_id)
    if not result:
        raise HTTPException(status_code=404, detail="run not found")
    return result


def _require_managed_auth(request: Request) -> None:
    if managed_settings.auth_mode != "bearer_token":
        return
    auth_header = request.headers.get("authorization", "")
    scheme, _, token = auth_header.partition(" ")
    if scheme.lower() != "bearer" or not managed_settings.verify_bearer_token(token.strip()):
        raise HTTPException(status_code=401, detail="invalid bearer token")
