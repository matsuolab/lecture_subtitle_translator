from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

Condition = Literal["success", "failure", "always"]


@dataclass(frozen=True)
class Edge:
    target: str
    condition: Condition = "always"


@dataclass(frozen=True)
class NodeSpec:
    id: str
    implementation_key: str
    max_attempts: int = 1
    max_visits: int = 20


@dataclass
class WorkflowDefinition:
    name: str
    start_node: str
    nodes: dict[str, NodeSpec]
    edges: dict[str, list[Edge]] = field(default_factory=dict)

    def get_node(self, node_id: str) -> NodeSpec:
        return self.nodes[node_id]

    def get_edges(self, node_id: str) -> list[Edge]:
        return self.edges.get(node_id, [])
