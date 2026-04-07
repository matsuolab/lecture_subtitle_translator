from __future__ import annotations

import time
import uuid
from collections.abc import Callable

from .contracts import NodeExecutionRecord, RunState
from .policy import PolicyEngine
from .registry import NodeRegistry
from .workflow import Edge, WorkflowDefinition


class DAGRunner:
    def __init__(self, registry: NodeRegistry, policy: PolicyEngine | None = None) -> None:
        self.registry = registry
        self.policy = policy or PolicyEngine()

    def run(
        self,
        workflow: WorkflowDefinition,
        initial_data: dict | None = None,
        max_total_steps: int = 200,
        schema_version: str = "1.0",
        on_node_start: Callable[[str], None] | None = None,
    ) -> RunState:
        state = RunState(
            run_id=str(uuid.uuid4()),
            schema_version=schema_version,
            data=dict(initial_data or {}),
        )

        current = workflow.start_node
        steps = 0
        visit_counts: dict[str, int] = {}

        while True:
            steps += 1
            if steps > max_total_steps:
                state.mark_failed(current, "max_total_steps exceeded")
                return state

            if on_node_start:
                on_node_start(current)

            spec = workflow.get_node(current)
            visit_counts[current] = visit_counts.get(current, 0) + 1
            if visit_counts[current] > spec.max_visits:
                state.mark_failed(current, f"max_visits exceeded: {current}")
                return state

            node = self.registry.create(spec.implementation_key)
            if not _is_schema_compatible(state.schema_version, node.contract.input_schema_version):
                state.mark_failed(
                    current,
                    (
                        f"schema mismatch at {current}: "
                        f"state={state.schema_version}, node_input={node.contract.input_schema_version}"
                    ),
                )
                return state

            final_status = "failure"
            final_issues: list[str] = []

            for attempt in range(1, spec.max_attempts + 1):
                started = time.perf_counter()
                error_text: str | None = None
                try:
                    result = node.run(state)
                    final_status = result.status
                    final_issues = list(result.issues)
                    if result.updates:
                        state.data.update(result.updates)
                    if result.status == "success":
                        state.schema_version = node.contract.output_schema_version
                except Exception as exc:  # pragma: no cover - defensive
                    result = None
                    final_status = "failure"
                    final_issues = ["exception"]
                    error_text = str(exc)

                duration_ms = int((time.perf_counter() - started) * 1000)
                state.append(
                    NodeExecutionRecord(
                        node_id=current,
                        attempt=attempt,
                        status=final_status,
                        duration_ms=duration_ms,
                        provider=(result.provider if result else None),
                        model=(result.model if result else None),
                        issues=final_issues,
                        metrics=(result.metrics if result else {}),
                        error=error_text,
                    )
                )

                decision = self.policy.decide(
                    result=result if result else _failure_result(),
                    attempt=attempt,
                    max_attempts=spec.max_attempts,
                )
                if decision.action == "retry":
                    continue
                break

            next_node = self._resolve_next(workflow.get_edges(current), final_status)
            if next_node is None:
                if final_status == "success":
                    state.mark_success(current)
                else:
                    state.mark_failed(current, f"node failed without outgoing failure edge: {current}")
                return state

            current = next_node

    def _resolve_next(self, edges: list[Edge], status: str) -> str | None:
        preferred = "success" if status == "success" else "failure"
        for edge in edges:
            if edge.condition == preferred:
                return edge.target
        for edge in edges:
            if edge.condition == "always":
                return edge.target
        return None


def _failure_result():
    from .contracts import NodeResult

    return NodeResult(status="failure")


def _is_schema_compatible(state_schema: str, node_input_schema: str) -> bool:
    return state_schema == node_input_schema
