from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Literal

from .bootstrap import build_default_registry
from .results import build_result_payload
from .runner import DAGRunner
from .workflows import drop_first_v1, drop_first_with_quality_v1, managed_transcript_v1

RunLifecycleStatus = Literal["queued", "running", "success", "failed", "cancelled"]

log = logging.getLogger(__name__)


@dataclass
class StoredRun:
    run_id: str
    status: RunLifecycleStatus
    request: dict[str, Any]
    current_node: str | None = None
    completed_nodes: list[str] = field(default_factory=list)
    total_nodes: int = 0
    node_started_at: float | None = None
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

        if workflow_name == "drop_first_v1":
            workflow = drop_first_v1()
        elif workflow_name == "managed_transcript_v1":
            workflow = managed_transcript_v1()
        else:
            workflow = drop_first_with_quality_v1()

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

        return build_result_payload(
            run_id=run_id,
            status=run.status,
            workflow=str(run.request.get("workflow", "drop_first_with_quality_v1")),
            state=run.state,
        )

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
