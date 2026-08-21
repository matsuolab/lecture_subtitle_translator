import time
import json
from unittest.mock import patch

from backend.pipeline.contracts import RunState
from backend.pipeline.nodes.translate import (
    TranslateNode,
    _translate_segments_with_openai_compatible,
    _looks_untranslated,
    _resolve_direction,
    _resolve_runtime_config,
)
from backend.pipeline.service import PipelineService


def test_translate_node_uses_runtime_translation_provider() -> None:
    node = TranslateNode()
    state = RunState(
        run_id="run-1",
        schema_version="1.0",
        data={
            "corrected_segments": [{"id": 1, "ja_corrected": "翻訳を実行します。"}],
            "runtime_settings": {
                "translation_provider": "openai",
                "openai_api_key": "sk-secret",
            },
        },
    )

    with patch(
        "backend.pipeline.nodes.translate._translate_segments_with_openai_compatible",
        return_value=["We will run the translation."],
    ):
        result = node.run(state)

    assert result.status == "success"
    assert result.provider == "openai-api"
    assert result.model == "gpt-4.1-mini"
    assert result.metrics["translation_provider"] == "openai-api"
    assert result.updates["translated_segments"][0]["translation_provider"] == "OpenAI"


def test_translate_node_fails_without_required_api_key() -> None:
    node = TranslateNode()
    state = RunState(
        run_id="run-2",
        schema_version="1.0",
        data={
            "corrected_segments": [{"id": 1, "ja_corrected": "翻訳を実行します。"}],
            "runtime_settings": {
                "translation_provider": "openai",
            },
        },
    )

    result = node.run(state)

    assert result.status == "failure"
    assert result.issues == ["OpenAI API key is required before running the pipeline"]
    assert result.metrics["retryable"] is False


def test_service_redacts_runtime_setting_secrets() -> None:
    svc = PipelineService()

    with patch(
        "backend.pipeline.nodes.translate._translate_segments_with_openai_compatible",
        side_effect=lambda texts, *_args: [f"Translated {idx}" for idx, _ in enumerate(texts, start=1)],
    ):
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
            },
        )

        deadline = time.time() + 5.0
        result = svc.get_result(started["run_id"])
        while result is None and time.time() < deadline:
            time.sleep(0.05)
            result = svc.get_result(started["run_id"])

    assert result is not None
    runtime_settings = result["state"]["data"]["runtime_settings"]
    assert runtime_settings["openai_api_key"] == "***"
    assert runtime_settings["translation_provider"] == "openai"
    assert runtime_settings["openai_compatible_base_url"] == "http://127.0.0.1:8000/v1"


def test_translate_batches_large_segment_lists() -> None:
    runtime_settings = {"translation_provider": "openai", "openai_api_key": "sk-secret"}
    runtime = _resolve_runtime_config(runtime_settings)
    source_texts = [f"segment-{idx}" for idx in range(41)]
    seen_batches: list[list[str]] = []

    class _FakeResponse:
        def __init__(self, payload: str) -> None:
            self._payload = payload

        def read(self) -> bytes:
            return self._payload.encode("utf-8")

        def __enter__(self) -> "_FakeResponse":
            return self

        def __exit__(self, exc_type, exc, tb) -> None:
            return None

    def _fake_urlopen(request, timeout=120):  # type: ignore[no-untyped-def]
        body = json.loads(request.data.decode("utf-8"))
        batch = json.loads(body["messages"][1]["content"])["segments"]
        seen_batches.append(batch)
        payload = json.dumps(
            {
                "choices": [
                    {
                        "message": {
                            "content": json.dumps(
                                {"translations": [f"EN:{item}" for item in batch]},
                                ensure_ascii=False,
                            )
                        }
                    }
                ]
            }
        )
        return _FakeResponse(payload)

    with patch("backend.pipeline.nodes.translate.urllib_request.urlopen", side_effect=_fake_urlopen):
        translated = _translate_segments_with_openai_compatible(
            source_texts, runtime_settings, runtime, _resolve_direction(runtime_settings)
        )

    assert translated == [f"EN:segment-{idx}" for idx in range(41)]
    assert [len(batch) for batch in seen_batches] == [40, 1]


def test_resolve_direction_uses_transcription_language() -> None:
    """書きおこし言語から翻訳方向を決める。

    英語書きおこしのとき、字幕は日本語になる。ここが日→英に固定されていると、
    正しい日本語訳が _looks_untranslated に「未翻訳」と誤判定されてノードが必ず失敗する。
    """
    ja_to_en = _resolve_direction({"whisperx_language": "ja"})
    assert (ja_to_en.source_label, ja_to_en.target_label) == ("Japanese", "English")

    en_to_ja = _resolve_direction({"whisperx_language": "en"})
    assert (en_to_ja.source_label, en_to_ja.target_label) == ("English", "Japanese")

    # 地域つきコード（en-US 等）も英語として扱う
    assert _resolve_direction({"whisperx_language": "en-US"}).target_label == "Japanese"

    # 未指定・対応外の言語は従来どおり日→英に倒す（当てずっぽうのプロンプトを出さない）
    assert _resolve_direction({}).target_label == "English"
    assert _resolve_direction({"whisperx_language": "fr"}).target_label == "English"


def test_looks_untranslated_checks_target_language() -> None:
    """未翻訳判定はソース言語の字種が残っているかで見る。

    英→日では「日本語が多い＝未翻訳」ではなく「英語が多い＝未翻訳」になる。
    """
    ja_to_en = _resolve_direction({"whisperx_language": "ja"})
    en_to_ja = _resolve_direction({"whisperx_language": "en"})

    # 英→日: 正しい日本語訳は「翻訳済み」と判定される（この修正の主眼）
    assert not _looks_untranslated("This is a pen.", "これはペンです", en_to_ja)
    # 英→日: 英語のまま返ってきたら未翻訳
    assert _looks_untranslated("This is a pen.", "This is a pen.", en_to_ja)

    # 日→英: 従来どおりの判定
    assert not _looks_untranslated("これはペンです", "This is a pen.", ja_to_en)
    assert _looks_untranslated("これはペンです", "これはペンです", ja_to_en)

    # 方向によらず、空文字は未翻訳
    assert _looks_untranslated("This is a pen.", "", en_to_ja)
