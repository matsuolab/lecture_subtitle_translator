from backend.pipeline.bootstrap import build_default_registry
from backend.pipeline.contracts import NodeContract, NodeResult
from backend.pipeline.registry import NodeRegistry
from backend.pipeline.runner import DAGRunner
from backend.pipeline.workflow import NodeSpec, WorkflowDefinition
from backend.pipeline.workflows import drop_first_v1, drop_first_with_quality_v1


class _IncompatibleNode:
    contract = NodeContract(input_schema_version="2.0", output_schema_version="2.0")

    def run(self, state):
        return NodeResult(status="success", updates={"ok": True})


def test_drop_first_v1_success() -> None:
    runner = DAGRunner(build_default_registry())
    state = runner.run(
        drop_first_v1(),
        initial_data={
            "source_name": "lecture.mp4",
            "execution_mode": "dev",
            "allow_transcribe_fallback": True,
            "transcript_text": "これはテストです。次の文です。",
        },
    )

    assert state.status == "success"
    assert "subtitle_blocks" in state.data
    assert len(state.data["subtitle_blocks"]) >= 1
    assert [r.node_id for r in state.records] == ["extract_audio", "transcribe", "correct", "translate", "subtitle"]


def test_quality_workflow_success_with_relaxed_constraints() -> None:
    runner = DAGRunner(build_default_registry())
    state = runner.run(
        drop_first_with_quality_v1(),
        initial_data={
            "source_name": "lecture.mp4",
            "execution_mode": "dev",
            "allow_transcribe_fallback": True,
            "transcript_text": "これはテストです。次の文です。",
            "max_cps": 99.0,
            "glossary_terms": [],
            "semantic_score_override": 0.9,
        },
    )

    assert state.status == "success"
    assert state.data.get("cps_violation_count") == 0


def test_quality_workflow_stops_when_semantic_loop_exceeds_visit_limit() -> None:
    runner = DAGRunner(build_default_registry())
    state = runner.run(
        drop_first_with_quality_v1(),
        initial_data={
            "source_name": "lecture.mp4",
            "execution_mode": "dev",
            "allow_transcribe_fallback": True,
            "transcript_text": "これはテストです。次の文です。",
            "semantic_threshold": 0.95,
            "semantic_score_override": 0.7,
            "max_cps": 99.0,
        },
        max_total_steps=100,
    )

    assert state.status == "failed"
    assert state.error == "max_visits exceeded: translate"


def test_runner_fails_on_schema_mismatch() -> None:
    registry = NodeRegistry()
    registry.register("incompatible", _IncompatibleNode)
    workflow = WorkflowDefinition(
        name="schema_mismatch",
        start_node="x",
        nodes={"x": NodeSpec(id="x", implementation_key="incompatible")},
        edges={"x": []},
    )

    state = DAGRunner(registry).run(workflow, schema_version="1.0")

    assert state.status == "failed"
    assert state.error == "schema mismatch at x: state=1.0, node_input=2.0"
