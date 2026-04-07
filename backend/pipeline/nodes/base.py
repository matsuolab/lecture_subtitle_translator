from __future__ import annotations

from dataclasses import dataclass

from ..contracts import NodeContract, NodeResult, RunState


@dataclass
class BaseStubNode:
    provider: str = "stub"
    model: str = "stub-v1"

    @property
    def contract(self) -> NodeContract:
        return NodeContract(input_schema_version="1.0", output_schema_version="1.0")

    def success(self, updates: dict, metrics: dict | None = None) -> NodeResult:
        return NodeResult(
            status="success",
            updates=updates,
            metrics=metrics or {},
            provider=self.provider,
            model=self.model,
        )

    def failure(self, issues: list[str], metrics: dict | None = None) -> NodeResult:
        return NodeResult(
            status="failure",
            issues=issues,
            metrics=metrics or {},
            provider=self.provider,
            model=self.model,
        )

    def run(self, state: RunState) -> NodeResult:  # pragma: no cover - abstract-ish
        raise NotImplementedError
