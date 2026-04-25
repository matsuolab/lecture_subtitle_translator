"""
ローカル FastAPI サーバー — フロントエンドの pipelineClient.ts が期待するエンドポイントを提供する。

起動方法（poc/ ディレクトリから）:
    step2_pipeline\\.venv\\Scripts\\uvicorn.exe step2_pipeline.server:app --port 8765

または:
    step2_pipeline\\.venv\\Scripts\\python.exe -m uvicorn step2_pipeline.server:app --port 8765

フロントエンドの管理設定でパイプライン API URL を http://localhost:8765 に設定してから使う。
"""
from __future__ import annotations

import asyncio
import os
import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

load_dotenv()

app = FastAPI(title="V2S-AIE Local Pipeline Server", version="1.0.0")

# CORS — Tauri (localhost) + dev サーバーからのリクエストを許可
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# ジョブ管理
# ---------------------------------------------------------------------------

STEP_IDS = [
    "extract_audio",
    "transcribe",
    "pdf_extract",
    "correct",
    "translate",
    "split",
    "align",
    "srt_export",
    "report",
]


@dataclass
class Job:
    run_id: str
    status: str = "queued"           # queued | running | success | failed | cancelled
    current_node: str | None = None
    completed_nodes: list[str] = field(default_factory=list)
    total_nodes: int = len(STEP_IDS)
    node_elapsed_sec: float | None = None
    result: Any = None
    error: str | None = None
    _node_start: float | None = None


_jobs: dict[str, Job] = {}
_jobs_lock = threading.Lock()


# ---------------------------------------------------------------------------
# リクエストモデル
# ---------------------------------------------------------------------------

class RuntimeSettings(BaseModel):
    translation_provider: str | None = None
    openai_api_key: str | None = None
    gemini_api_key: str | None = None
    deepl_api_key: str | None = None
    openai_compatible_base_url: str | None = None
    hf_token: str | None = None


class InitialData(BaseModel):
    source_name: str = ""
    source_media_path: str | None = None
    max_cps: float | None = None
    glossary_terms: list[str] = []
    runtime_settings: RuntimeSettings = RuntimeSettings()
    execution_mode: str = "production"
    allow_transcribe_fallback: bool = False


class StartRunRequest(BaseModel):
    workflow: str = "drop_first_with_quality_v1"
    source_name: str = ""
    initial_data: InitialData = InitialData()


# ---------------------------------------------------------------------------
# エンドポイント
# ---------------------------------------------------------------------------

@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/api/pipeline/runs", status_code=201)
def start_run(req: StartRunRequest):
    run_id = str(uuid.uuid4())
    job = Job(run_id=run_id)
    with _jobs_lock:
        _jobs[run_id] = job

    thread = threading.Thread(
        target=_run_pipeline_thread,
        args=(job, req.initial_data),
        daemon=True,
    )
    thread.start()

    return {"run_id": run_id}


@app.get("/api/pipeline/runs/{run_id}")
def get_run_status(run_id: str):
    with _jobs_lock:
        job = _jobs.get(run_id)
    if job is None:
        raise HTTPException(status_code=404, detail="run not found")

    elapsed: float | None = None
    if job._node_start is not None and job.status == "running":
        elapsed = round(time.time() - job._node_start, 1)

    return {
        "run_id": job.run_id,
        "status": job.status,
        "current_node": job.current_node,
        "completed_nodes": list(job.completed_nodes),
        "total_nodes": job.total_nodes,
        "node_elapsed_sec": elapsed,
        "error": job.error,
    }


@app.get("/api/pipeline/runs/{run_id}/result")
def get_run_result(run_id: str):
    with _jobs_lock:
        job = _jobs.get(run_id)
    if job is None:
        raise HTTPException(status_code=404, detail="run not found")
    if job.status != "success":
        raise HTTPException(status_code=400, detail=f"run status: {job.status}")
    return job.result


# ---------------------------------------------------------------------------
# パイプライン実行スレッド
# ---------------------------------------------------------------------------

def _on_step(job: Job, node_id: str) -> None:
    """各ステップ開始時に呼ばれる進捗コールバック。"""
    if job.current_node:
        job.completed_nodes.append(job.current_node)
    job.current_node = node_id
    job._node_start = time.time()


def _run_pipeline_thread(job: Job, data: InitialData) -> None:
    """バックグラウンドスレッドで pipeline.run_pipeline() を実行する。"""
    # ランタイム設定を環境変数に反映（フロントから渡された API キーで上書き）
    rs = data.runtime_settings
    if rs.openai_api_key:
        os.environ["OPENAI_API_KEY"] = rs.openai_api_key
    if rs.gemini_api_key:
        os.environ["GEMINI_API_KEY"] = rs.gemini_api_key
    if rs.hf_token:
        os.environ["HF_TOKEN"] = rs.hf_token
    if rs.openai_compatible_base_url:
        os.environ["OPENAI_COMPATIBLE_BASE_URL"] = rs.openai_compatible_base_url

    video_path = (data.source_media_path or "").strip()
    if not video_path:
        job.status = "failed"
        job.error = "source_media_path は必須です"
        return

    job.status = "running"

    try:
        from .constraints import apply_overrides, load_constraints
        from .pipeline import run_pipeline

        constraints_cfg = load_constraints()
        if data.max_cps:
            constraints_cfg = apply_overrides(constraints_cfg, lang="en", max_cps=data.max_cps)

        result = asyncio.run(
            run_pipeline(
                video_path=video_path,
                constraints_cfg=constraints_cfg,
                progress_callback=lambda node_id: _on_step(job, node_id),
            )
        )

        # 最後のノードを completed に移す
        if job.current_node:
            job.completed_nodes.append(job.current_node)
        job.current_node = None

        job.result = _format_result(result)
        job.status = "success"

    except Exception as exc:
        job.status = "failed"
        job.error = str(exc)
        import traceback
        traceback.print_exc()


def _format_result(result: Any) -> dict:
    """PipelineResult → フロントエンドの BackendPipelineResult 形式に変換する。"""
    blocks = result.subtitle_blocks

    translated_segments = [
        {
            "id": b.id,
            "start": b.start,
            "end": b.end,
            "en": b.text,
            "translation_flagged": b.flagged,
        }
        for b in blocks
    ]

    review_items: list[dict] = []
    for seg in result.flagged_corrections:
        review_items.append({
            "id": f"corr-{seg.original.id}",
            "node_id": "correct",
            "reason": f"補正乖離 (distance={seg.correction_distance:.3f})",
            "priority": "should_review",
            "score": seg.correction_distance,
        })
    for seg in result.flagged_translations:
        review_items.append({
            "id": f"trans-{seg.corrected.original.id}",
            "node_id": "translate",
            "reason": f"翻訳乖離 (distance={seg.translation_distance:.3f})",
            "priority": "should_review",
            "score": seg.translation_distance,
        })
    for b in blocks:
        if not b.cps_ok:
            review_items.append({
                "id": f"cps-{b.id}",
                "node_id": "split",
                "reason": f"CPS違反 (cps={b.cps:.1f})",
                "priority": "must_review",
                "score": b.cps,
                "block_id": b.id,
            })

    must_count = sum(1 for r in review_items if r["priority"] == "must_review")
    should_count = sum(1 for r in review_items if r["priority"] == "should_review")
    auto_count = max(0, len(blocks) - len(set(r.get("block_id", -1) for r in review_items if r.get("block_id"))))

    return {
        "state": {
            "data": {
                "translated_segments": translated_segments,
                "subtitle_blocks": [],
            }
        },
        "audit": {
            "must_review_count": must_count,
            "should_review_count": should_count,
            "auto_pass_count": auto_count,
            "review_items": review_items,
            "node_traces": [],
        },
    }
