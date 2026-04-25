from __future__ import annotations

import json
import os
import tempfile
import time
from pathlib import Path
from typing import Any

import boto3

from .pipeline.bootstrap import build_default_registry
from .pipeline.results import build_result_payload
from .pipeline.runner import DAGRunner
from .pipeline.workflows import drop_first_v1, drop_first_with_quality_v1


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

    workflow_name = payload.get("workflow", "drop_first_with_quality_v1")
    workflow = drop_first_v1() if workflow_name == "drop_first_v1" else drop_first_with_quality_v1()
    initial_data: dict[str, Any] = {
        "source_name": payload["source_name"],
        "source_media_path": str(input_path),
        "max_cps": 99,
        "glossary_terms": payload.get("glossary_terms", []),
        "runtime_settings": payload.get("runtime_settings", {}),
        "execution_mode": payload.get("execution_mode", "production"),
        "allow_transcribe_fallback": False,
    }
    if payload.get("semantic_score_override") is not None:
        initial_data["semantic_score_override"] = payload["semantic_score_override"]

    runner = DAGRunner(build_default_registry())
    completed_steps: list[str] = []

    def on_node_start(node_id: str) -> None:
        public_step = _to_public_step(node_id)
        if public_step not in completed_steps:
            completed_steps.append(public_step)
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
        max_total_steps=int(payload.get("max_total_steps", 200)),
        schema_version=str(payload.get("schema_version", "1.0")),
        on_node_start=on_node_start,
    )

    final_status = "success" if state.status == "success" else "failed"
    result_payload = build_result_payload(job_id, final_status, workflow.name, state)
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
        current_step="completed" if final_status == "success" else "failed",
        completed_steps=completed_steps,
        result_key=result_key,
        error=state.error,
    )


def _to_public_step(node_id: str) -> str:
    mapping = {
        "extract_audio": "extract_audio",
        "transcribe": "transcribe",
        "correct": "correct",
        "translate": "translate",
        "semantic_check": "translate",
        "terminology_check": "translate",
        "subtitle": "subtitle",
        "cps_guard": "subtitle",
    }
    return mapping.get(node_id, node_id)


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
