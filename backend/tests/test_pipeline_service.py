import time
from unittest.mock import patch

from backend.pipeline.service import PipelineService

_STUB_TRANSLATE = "backend.pipeline.nodes.translate._translate_segments_with_openai_compatible"


def _stub_en(texts: list[str], *_args, **_kwargs) -> list[str]:
    return [f"Translation {i + 1}" for i in range(len(texts))]


def _wait_for_finish(svc: PipelineService, run_id: str, timeout: float = 10.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        status = svc.get_status(run_id)
        assert status is not None
        if status["status"] in ("success", "failed"):
            return status
        time.sleep(0.05)
    raise TimeoutError(f"run {run_id} did not finish within {timeout}s")


def test_service_start_status_result() -> None:
    svc = PipelineService()

    # Patch must stay active for background thread execution
    with patch(_STUB_TRANSLATE, side_effect=_stub_en):
        started = svc.start_run({
            "workflow": "drop_first_with_quality_v1",
            "source_name": "lecture.mp4",
            "initial_data": {
                "execution_mode": "dev",
                "allow_transcribe_fallback": True,
                "transcript_text": "これはテストです。次の文です。",
                "max_cps": 99.0,
                "glossary_terms": [],
                "semantic_score_override": 0.9,
                "runtime_settings": {"translation_provider": "openai", "openai_api_key": "sk-test"},
            },
        })

        run_id = started["run_id"]
        assert started["status"] == "queued"

        status = _wait_for_finish(svc, run_id)

    assert status["status"] == "success"

    result = svc.get_result(run_id)
    assert result is not None
    assert result["audit"]["node_traces"]
    assert "review_items" in result["audit"]


def test_service_result_not_found() -> None:
    svc = PipelineService()
    assert svc.get_status("missing") is None
    assert svc.get_result("missing") is None
    assert svc.cancel_run("missing") is None
