from __future__ import annotations

from typing import Any

from .contracts import NodeExecutionRecord, RunState

_SECRET_KEYS = {"openai_api_key", "gemini_api_key", "anthropic_api_key"}


def sanitize_state_data(data: dict[str, Any]) -> dict[str, Any]:
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


def to_trace_rows(records: list[NodeExecutionRecord]) -> list[dict[str, Any]]:
    return [
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
        for rec in records
    ]


def build_review_items(records: list[NodeExecutionRecord]) -> list[dict[str, Any]]:
    review_items: list[dict[str, Any]] = []
    for i, rec in enumerate(records):
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
            violations = int(rec.metrics.get("violation_count", 0))
            review_items.append({
                "id": f"cps-{i}",
                "node_id": "cps_guard",
                "reason": f"cps violations={violations}",
                "priority": "must_review" if violations > 0 else "auto_pass",
                "score": 0.1 if violations > 0 else 0.99,
            })

    return review_items


def build_result_payload(run_id: str, status: str, workflow: str, state: RunState) -> dict[str, Any]:
    traces = to_trace_rows(state.records)
    review_items = build_review_items(state.records)
    must_review = sum(1 for item in review_items if item["priority"] == "must_review")
    should_review = sum(1 for item in review_items if item["priority"] == "should_review")
    auto_pass = sum(1 for item in review_items if item["priority"] == "auto_pass")

    return {
        "run_id": run_id,
        "status": status,
        "workflow": workflow,
        "state": {
            "schema_version": state.schema_version,
            "final_node": state.final_node,
            "error": state.error,
            "data": sanitize_state_data(state.data),
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


def build_word_timestamps(transcript_segments: list[dict[str, Any]]) -> list[dict[str, Any]]:
    words: list[dict[str, Any]] = []
    for segment in transcript_segments:
        segment_words = segment.get("words")
        if not isinstance(segment_words, list):
            continue
        for word in segment_words:
            if not isinstance(word, dict):
                continue
            words.append({
                "word": str(word.get("word", "")),
                "start": float(word.get("start", 0.0)),
                "end": float(word.get("end", 0.0)),
                "score": float(word.get("score", 1.0)),
            })
    return words


def build_transcript_job_result(result: dict[str, Any], *, job_id: str) -> dict[str, Any]:
    state = result.get("state", {})
    state_data = state.get("data", {})
    transcript_segments = state_data.get("transcript_segments", [])
    audit = result.get("audit", {})
    metadata = {
        "workflow": result.get("workflow"),
        "schema_version": state.get("schema_version"),
        "final_node": state.get("final_node"),
        "error": state.get("error"),
        "node_traces": audit.get("node_traces", []),
    }
    return {
        "job_id": job_id,
        "status": result.get("status"),
        "transcript_segments": transcript_segments,
        "words": build_word_timestamps(transcript_segments if isinstance(transcript_segments, list) else []),
        "metadata": metadata,
    }
