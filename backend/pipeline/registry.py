from __future__ import annotations

from collections.abc import Callable
from typing import Protocol

from .contracts import NodeContract, NodeResult, RunState


class Node(Protocol):
    contract: NodeContract

    def run(self, state: RunState) -> NodeResult:
        ...


class NodeRegistry:
    def __init__(self) -> None:
        self._factories: dict[str, Callable[[], Node]] = {}

    def register(self, key: str, factory: Callable[[], Node]) -> None:
        self._factories[key] = factory

    def create(self, key: str) -> Node:
        if key not in self._factories:
            raise KeyError(f"node implementation is not registered: {key}")
        return self._factories[key]()
