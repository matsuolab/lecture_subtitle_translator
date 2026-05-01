from __future__ import annotations

import json
import os
import tempfile
import time
from pathlib import Path
from typing import Any

import boto3

from .pipeline.bootstrap import build_default_registry
from .pipeline.results import build_transcript_job_result
from .pipeline.runner import DAGRunner
from .pipeline.workflow import Edge, NodeSpec, WorkflowDefinition


def main() -> None:
    payload = json.loads(os.environ["AWS_MANAGED_JOB_PAYLOAD"])
    region = os.environ["AWS_REGION"]
    session = boto3.session.Session(region_name=region)
    s3 = session.client("s3")
    ddb = session.client("dynamodb")

    input_bucket = os.environ["MANAGED_SERVICE_AWS_INPUT_BUCKET"]
    result_bucket = payload["result_bucket"]
    result_prefix = payload["result_prefix"]
    jobs_table = payload["jobs_table"]
    job_id = payload["job_id"]

    temp_dir = Path(tempfile.mkdtemp(prefix=f"subtitle-managed-{job_id}-"))
    input_path = temp_dir / Path(payload["input_key"]).name

    s3.download_file(input_bucket, payload["input_key"], str(input_path))

    workflow = _managed_transcript_workflow()
    initial_data: dict[str, Any] = {
        "source_name": payload["source_name"],
        "audio_path": str(input_path),
        "execution_mode": payload.get("execution_mode", "production"),
        "allow_transcribe_fallback": False,
    }

    runner = DAGRunner(build_default_registry())
    completed_steps: list[str] = []
    active_step: str | None = None

    def on_node_start(node_id: str) -> None:
        nonlocal active_step
        public_step = _to_public_step(node_id)
        if active_step and active_step not in completed_steps:
            completed_steps.append(active_step)
        active_step = public_step
        _update_job(
            ddb,
            jobs_table,
            job_id,
            status="running",
            current_step=public_step,
            completed_steps=completed_steps,
        )

    _update_job(ddb, jobs_table, job_id, status="running", current_step="queued", completed_steps=[])
    state = runner.run(
        workflow,
        initial_data=initial_data,
        max_total_steps=16,
        schema_version=str(payload.get("schema_version", "1.0")),
        on_node_start=on_node_start,
    )
    final_public_step = _to_public_step(state.final_node) if state.final_node else active_step
    if final_public_step and final_public_step not in completed_steps:
        completed_steps.append(final_public_step)

    final_status = "success" if state.status == "success" else "failed"
    result_payload = build_transcript_job_result(
        {
            "status": final_status,
            "workflow": workflow.name,
            "state": {
                "schema_version": state.schema_version,
                "final_node": state.final_node,
                "error": state.error,
                "data": state.data,
            },
            "audit": {
                "node_traces": [
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
            },
        },
        job_id=job_id,
    )
    result_key = f"{result_prefix}{job_id}.json"
    s3.put_object(
        Bucket=result_bucket,
        Key=result_key,
        Body=json.dumps(result_payload, ensure_ascii=False).encode("utf-8"),
        ContentType="application/json",
    )
    _update_job(
        ddb,
        jobs_table,
        job_id,
        status=final_status,
        current_step=final_public_step or "queued",
        completed_steps=completed_steps,
        result_key=result_key,
        error=state.error,
    )


def _to_public_step(node_id: str) -> str:
    mapping = {
        "transcribe": "transcribe",
    }
    return mapping.get(node_id, node_id)


def _managed_transcript_workflow() -> WorkflowDefinition:
    nodes = {
        "transcribe": NodeSpec(id="transcribe", implementation_key="transcribe", max_visits=2),
    }
    edges = {
        "transcribe": [],
    }
    return WorkflowDefinition(name="managed_transcript_v1", start_node="transcribe", nodes=nodes, edges=edges)


def _update_job(
    ddb: Any,
    table_name: str,
    job_id: str,
    *,
    status: str,
    current_step: str,
    completed_steps: list[str],
    result_key: str | None = None,
    error: str | None = None,
) -> None:
    expression_names: dict[str, str] = {
        "#status": "status",
        "#current_step": "current_step",
        "#completed_steps": "completed_steps",
        "#updated_at": "updated_at",
    }
    expression_values: dict[str, Any] = {
        ":status": {"S": status},
        ":current_step": {"S": current_step},
        ":completed_steps": {"L": [{"S": step} for step in completed_steps]},
        ":updated_at": {"S": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())},
    }
    update_parts = [
        "#status = :status",
        "#current_step = :current_step",
        "#completed_steps = :completed_steps",
        "#updated_at = :updated_at",
    ]
    if result_key:
        expression_names["#result_key"] = "result_key"
        expression_values[":result_key"] = {"S": result_key}
        update_parts.append("#result_key = :result_key")
    if error:
        expression_names["#error"] = "error"
        expression_values[":error"] = {"S": error}
        update_parts.append("#error = :error")

    ddb.update_item(
        TableName=table_name,
        Key={"job_id": {"S": job_id}},
        UpdateExpression="SET " + ", ".join(update_parts),
        ExpressionAttributeNames=expression_names,
        ExpressionAttributeValues=expression_values,
    )


if __name__ == "__main__":
    main()
