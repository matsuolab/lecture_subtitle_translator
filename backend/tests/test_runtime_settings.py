from backend.pipeline.contracts import RunState
from backend.pipeline.nodes.translate import TranslateNode
from backend.pipeline.service import PipelineService


def test_translate_node_uses_runtime_translation_provider() -> None:
    node = TranslateNode()
    state = RunState(
        run_id="run-1",
        schema_version="1.0",
        data={
            "corrected_segments": [{"id": 1, "ja_corrected": "翻訳を実行します。"}],
            "runtime_settings": {
                "translation_provider": "gemini",
                "gemini_api_key": "secret-key",
            },
        },
    )

    result = node.run(state)

    assert result.status == "success"
    assert result.provider == "gemini-api"
    assert result.model == "gemini-2.5-flash (planned)"
    assert result.metrics["translation_provider"] == "gemini-api"
    assert result.updates["translated_segments"][0]["translation_provider"] == "Gemini"


def test_service_redacts_runtime_setting_secrets() -> None:
    svc = PipelineService()

    started = svc.start_run(
        {
            "workflow": "drop_first_with_quality_v1",
            "source_name": "lecture.mp4",
            "initial_data": {
                "execution_mode": "dev",
                "allow_transcribe_fallback": True,
                "transcript_text": "これはテストです。次の文です。",
                "max_cps": 99.0,
                "glossary_terms": [],
                "semantic_score_override": 0.9,
                "runtime_settings": {
                    "translation_provider": "openai",
                    "openai_api_key": "sk-secret",
                    "openai_compatible_base_url": "http://127.0.0.1:8000/v1",
                },
            },
        }
    )

    result = svc.get_result(started["run_id"])

    assert result is not None
    runtime_settings = result["state"]["data"]["runtime_settings"]
    assert runtime_settings["openai_api_key"] == "***"
    assert runtime_settings["translation_provider"] == "openai"
    assert runtime_settings["openai_compatible_base_url"] == "http://127.0.0.1:8000/v1"
