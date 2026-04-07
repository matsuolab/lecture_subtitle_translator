from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

RunStatus = Literal["success", "failure"]


@dataclass(frozen=True)
class NodeContract:
    """Versioned contract for node I/O."""

    input_schema_version: str
    output_schema_version: str


@dataclass
class NodeResult:
    """Node execution result."""

    status: RunStatus
    updates: dict[str, Any] = field(default_factory=dict)
    issues: list[str] = field(default_factory=list)
    metrics: dict[str, Any] = field(default_factory=dict)
    provider: str | None = None
    model: str | None = None


@dataclass
class NodeExecutionRecord:
    node_id: str
    attempt: int
    status: RunStatus
    duration_ms: int
    provider: str | None
    model: str | None
    issues: list[str] = field(default_factory=list)
    metrics: dict[str, Any] = field(default_factory=dict)
    error: str | None = None


@dataclass
class RunState:
    """Persistent run state for reporting/debugging."""

    run_id: str
    schema_version: str
    data: dict[str, Any] = field(default_factory=dict)
    records: list[NodeExecutionRecord] = field(default_factory=list)
    status: Literal["running", "success", "failed"] = "running"
    final_node: str | None = None
    error: str | None = None

    def append(self, record: NodeExecutionRecord) -> None:
        self.records.append(record)

    def mark_success(self, node_id: str) -> None:
        self.status = "success"
        self.final_node = node_id

    def mark_failed(self, node_id: str, message: str) -> None:
        self.status = "failed"
        self.final_node = node_id
        self.error = message
