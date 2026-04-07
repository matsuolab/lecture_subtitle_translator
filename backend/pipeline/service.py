from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Literal

from .bootstrap import build_default_registry
from .runner import DAGRunner
from .workflows import drop_first_v1, drop_first_with_quality_v1

RunLifecycleStatus = Literal["queued", "running", "success", "failed", "cancelled"]
_SECRET_KEYS = {"openai_api_key", "gemini_api_key", "deepl_api_key", "anthropic_api_key"}

log = logging.getLogger(__name__)


@dataclass
class StoredRun:
    run_id: str
    status: RunLifecycleStatus
    request: dict[str, Any]
    # 進行状況
    current_node: str | None = None
    completed_nodes: list[str] = field(default_factory=list)
    total_nodes: int = 0
    node_started_at: float | None = None
    # 完了後
    state: Any | None = None


class PipelineService:
    """In-memory service for DAG pipeline runs."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._runs: dict[str, StoredRun] = {}
        self._runner = DAGRunner(build_default_registry())

    def start_run(self, payload: dict[str, Any]) -> dict[str, Any]:
        workflow_name = str(payload.get("workflow", "drop_first_with_quality_v1"))
        initial_data = dict(payload.get("initial_data", {}))
        schema_version = str(payload.get("schema_version", "1.0"))
        max_total_steps = int(payload.get("max_total_steps", 200))

        workflow = drop_first_v1() if workflow_name == "drop_first_v1" else drop_first_with_quality_v1()

        initial_data.setdefault("source_name", payload.get("source_name", "unknown.mp4"))
        initial_data.setdefault("max_cps", 99.0)
        initial_data.setdefault("glossary_terms", [])

        run = StoredRun(
            run_id=_new_run_id(),
            status="queued",
            request=payload,
            total_nodes=len(workflow.nodes),
        )

        with self._lock:
            self._runs[run.run_id] = run

        thread = threading.Thread(
            target=self._execute,
            args=(run, workflow, initial_data, max_total_steps, schema_version),
            daemon=True,
        )
        thread.start()

        log.info("[service] run %s queued: workflow=%s", run.run_id[:8], workflow.name)

        return {
            "run_id": run.run_id,
            "status": "queued",
            "workflow": workflow.name,
        }

    def _execute(
        self,
        run: StoredRun,
        workflow: Any,
        initial_data: dict[str, Any],
        max_total_steps: int,
        schema_version: str,
    ) -> None:
        with self._lock:
            run.status = "running"

        def on_node_start(node_id: str) -> None:
            with self._lock:
                if run.current_node is not None:
                    run.completed_nodes.append(run.current_node)
                run.current_node = node_id
                run.node_started_at = time.time()
            log.info("[service] run %s → node: %s", run.run_id[:8], node_id)

        try:
            state = self._runner.run(
                workflow,
                initial_data=initial_data,
                max_total_steps=max_total_steps,
                schema_version=schema_version,
                on_node_start=on_node_start,
            )
            with self._lock:
                if run.current_node is not None:
                    run.completed_nodes.append(run.current_node)
                run.current_node = None
                run.status = "success" if state.status == "success" else "failed"
                run.state = state
            log.info("[service] run %s finished: status=%s", run.run_id[:8], run.status)
        except Exception as exc:
            with self._lock:
                run.status = "failed"
                run.current_node = None
            log.error("[service] run %s crashed: %s", run.run_id[:8], exc)

    def get_status(self, run_id: str) -> dict[str, Any] | None:
        with self._lock:
            run = self._runs.get(run_id)
        if not run:
            return None

        node_elapsed_sec: float | None = None
        if run.node_started_at is not None and run.current_node is not None:
            node_elapsed_sec = round(time.time() - run.node_started_at, 1)

        return {
            "run_id": run_id,
            "status": run.status,
            "current_node": run.current_node,
            "completed_nodes": list(run.completed_nodes),
            "total_nodes": run.total_nodes,
            "node_elapsed_sec": node_elapsed_sec,
            "final_node": run.state.final_node if run.state else None,
            "error": run.state.error if run.state else None,
        }

    def get_result(self, run_id: str) -> dict[str, Any] | None:
        with self._lock:
            run = self._runs.get(run_id)
        if not run or not run.state:
            return None

        state = run.state
        traces = [
            {
                "node_id": rec.node_id,
                "attempt": rec.attempt,
                "status": rec.status,
                "duration_ms": rec.duration_ms,
                "provider": rec.provider,
                "model": rec.model,
                "issues": rec.issues,
                "metrics": rec.metrics,
                "error": rec.error,
            }
            for rec in state.records
        ]

        review_items: list[dict[str, Any]] = []
        for i, rec in enumerate(state.records):
            if rec.status == "failure":
                review_items.append({
                    "id": f"fail-{rec.node_id}-{i}",
                    "node_id": rec.node_id,
                    "reason": rec.error or ", ".join(rec.issues) or "node failed",
                    "priority": "must_review",
                    "score": 0.0,
                })

            if rec.node_id == "semantic_check":
                score = float(rec.metrics.get("score", 1.0))
                threshold = float(rec.metrics.get("threshold", 0.85))
                review_items.append({
                    "id": f"semantic-{i}",
                    "node_id": "semantic_check",
                    "reason": f"semantic score={score:.2f}, threshold={threshold:.2f}",
                    "priority": "must_review" if score < threshold else ("should_review" if score < 0.92 else "auto_pass"),
                    "score": score,
                })

            if rec.node_id == "terminology_check":
                miss = int(rec.metrics.get("miss_count", 0))
                review_items.append({
                    "id": f"term-{i}",
                    "node_id": "terminology_check",
                    "reason": "terminology misses found" if miss > 0 else "terminology ok",
                    "priority": "must_review" if miss > 0 else "auto_pass",
                    "score": 0.2 if miss > 0 else 0.98,
                })

            if rec.node_id == "cps_guard":
                v = int(rec.metrics.get("violation_count", 0))
                review_items.append({
                    "id": f"cps-{i}",
                    "node_id": "cps_guard",
                    "reason": f"cps violations={v}",
                    "priority": "must_review" if v > 0 else "auto_pass",
                    "score": 0.1 if v > 0 else 0.99,
                })

        must_review = sum(1 for item in review_items if item["priority"] == "must_review")
        should_review = sum(1 for item in review_items if item["priority"] == "should_review")
        auto_pass = sum(1 for item in review_items if item["priority"] == "auto_pass")

        return {
            "run_id": run_id,
            "status": run.status,
            "workflow": run.request.get("workflow", "drop_first_with_quality_v1"),
            "state": {
                "schema_version": state.schema_version,
                "final_node": state.final_node,
                "error": state.error,
                "data": _sanitize_state_data(state.data),
                "records": traces,
            },
            "audit": {
                "must_review_count": must_review,
                "should_review_count": should_review,
                "auto_pass_count": auto_pass,
                "review_items": review_items,
                "node_traces": traces,
            },
        }

    def cancel_run(self, run_id: str) -> dict[str, Any] | None:
        with self._lock:
            run = self._runs.get(run_id)
            if not run:
                return None
            if run.status in ("success", "failed"):
                return {"run_id": run_id, "status": run.status, "cancelled": False}
            run.status = "cancelled"
        return {"run_id": run_id, "status": "cancelled", "cancelled": True}


def _new_run_id() -> str:
    import uuid
    return str(uuid.uuid4())


def _sanitize_state_data(data: dict[str, Any]) -> dict[str, Any]:
    sanitized = dict(data)
    runtime_settings = sanitized.get("runtime_settings")
    if isinstance(runtime_settings, dict):
        safe_runtime_settings: dict[str, Any] = {}
        for key, value in runtime_settings.items():
            if key in _SECRET_KEYS and value:
                safe_runtime_settings[key] = "***"
            else:
                safe_runtime_settings[key] = value
        sanitized["runtime_settings"] = safe_runtime_settings
    return sanitized
