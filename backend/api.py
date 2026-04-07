from __future__ import annotations

import logging
import time
from typing import Any

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from .pipeline.service import PipelineService

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger(__name__)

app = FastAPI(title="Subtitle Pipeline API", version="0.1.0")
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


service = PipelineService()


class StartRunRequest(BaseModel):
    workflow: str = Field(default="drop_first_with_quality_v1")
    source_name: str = Field(default="unknown.mp4")
    initial_data: dict[str, Any] = Field(default_factory=dict)
    schema_version: str = Field(default="1.0")
    max_total_steps: int = Field(default=200)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


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
