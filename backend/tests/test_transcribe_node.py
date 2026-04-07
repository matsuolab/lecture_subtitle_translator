from pathlib import Path

from backend.pipeline.contracts import RunState
from backend.pipeline.nodes.extract_audio import ExtractAudioNode
from backend.pipeline.nodes.transcribe import TranscribeNode


def _state(data: dict):
    return RunState(run_id="r1", schema_version="1.0", data=data)


def test_extract_audio_passes_through_audio_source() -> None:
    node = ExtractAudioNode()
    temp_audio = Path(__file__).with_name('sample.wav')
    temp_audio.write_bytes(b'RIFFTEST')
    try:
        result = node.run(_state({"source_media_path": str(temp_audio)}))
    finally:
        temp_audio.unlink(missing_ok=True)

    assert result.status == "success"
    assert result.updates["audio_path"] == str(temp_audio)
    assert result.metrics["source_media_kind"] == "audio"


def test_transcribe_fallback_generates_segments_only_in_dev() -> None:
    node = TranscribeNode()
    result = node.run(_state({
        "execution_mode": "dev",
        "allow_transcribe_fallback": True,
        "transcript_text": "これはテストです。次の文です。",
    }))

    assert result.status == "success"
    segments = result.updates["transcript_segments"]
    assert len(segments) >= 2
    assert result.metrics.get("external_used") is False


def test_transcribe_production_fails_without_audio_path() -> None:
    node = TranscribeNode()
    result = node.run(_state({"execution_mode": "production"}))

    assert result.status == "failure"
    assert "audio_path is required for production transcription" in result.issues[0]


def test_transcribe_strict_external_fails_when_path_missing() -> None:
    node = TranscribeNode()
    result = node.run(
        _state(
            {
                "execution_mode": "production",
                "audio_path": "E:/not-found/audio.wav",
                "strict_external_whisperx": True,
            }
        )
    )

    assert result.status == "failure"
    assert "docker whisperx failed" in result.issues[0]
