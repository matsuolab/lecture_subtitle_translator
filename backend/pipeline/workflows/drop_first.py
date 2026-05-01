from __future__ import annotations

from ..workflow import Edge, NodeSpec, WorkflowDefinition


def drop_first_v1() -> WorkflowDefinition:
    nodes = {
        "extract_audio": NodeSpec(id="extract_audio", implementation_key="extract_audio", max_visits=2),
        "transcribe": NodeSpec(id="transcribe", implementation_key="transcribe", max_visits=2),
        "correct": NodeSpec(id="correct", implementation_key="correct", max_visits=2),
        "translate": NodeSpec(id="translate", implementation_key="translate", max_visits=2),
        "subtitle": NodeSpec(id="subtitle", implementation_key="subtitle", max_visits=2),
    }
    edges = {
        "extract_audio": [Edge(target="transcribe", condition="success")],
        "transcribe": [Edge(target="correct", condition="success")],
        "correct": [Edge(target="translate", condition="success")],
        "translate": [Edge(target="subtitle", condition="success")],
        "subtitle": [],
    }
    return WorkflowDefinition(name="drop_first_v1", start_node="extract_audio", nodes=nodes, edges=edges)


def drop_first_with_quality_v1() -> WorkflowDefinition:
    nodes = {
        "extract_audio": NodeSpec(id="extract_audio", implementation_key="extract_audio", max_visits=2),
        "transcribe": NodeSpec(id="transcribe", implementation_key="transcribe", max_visits=2),
        "correct": NodeSpec(id="correct", implementation_key="correct", max_visits=2),
        "translate": NodeSpec(id="translate", implementation_key="translate", max_visits=6),
        "semantic_check": NodeSpec(id="semantic_check", implementation_key="semantic_check", max_visits=6),
        "terminology_check": NodeSpec(id="terminology_check", implementation_key="terminology_check", max_visits=6),
        "subtitle": NodeSpec(id="subtitle", implementation_key="subtitle", max_visits=6),
        "cps_guard": NodeSpec(id="cps_guard", implementation_key="cps_guard", max_visits=6),
    }
    edges = {
        "extract_audio": [Edge(target="transcribe", condition="success")],
        "transcribe": [Edge(target="correct", condition="success")],
        "correct": [Edge(target="translate", condition="success")],
        "translate": [Edge(target="semantic_check", condition="success")],
        "semantic_check": [
            Edge(target="terminology_check", condition="success"),
            Edge(target="translate", condition="failure"),
        ],
        "terminology_check": [
            Edge(target="subtitle", condition="success"),
            Edge(target="translate", condition="failure"),
        ],
        "subtitle": [Edge(target="cps_guard", condition="success")],
        "cps_guard": [
            Edge(target="translate", condition="failure"),
        ],
    }
    return WorkflowDefinition(
        name="drop_first_with_quality_v1",
        start_node="extract_audio",
        nodes=nodes,
        edges=edges,
    )


def managed_transcript_v1() -> WorkflowDefinition:
    nodes = {
        "transcribe": NodeSpec(id="transcribe", implementation_key="transcribe", max_visits=2),
    }
    edges = {
        "transcribe": [],
    }
    return WorkflowDefinition(name="managed_transcript_v1", start_node="transcribe", nodes=nodes, edges=edges)
