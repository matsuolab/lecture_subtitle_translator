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


# --- device / compute_type / language の解決 -------------------------------


def test_resolve_device_normalizes_and_defaults_to_cuda() -> None:
    from backend.pipeline.nodes.transcribe import _resolve_device

    assert _resolve_device("cpu") == "cpu"
    assert _resolve_device("CUDA") == "cuda"
    assert _resolve_device(" cpu ") == "cpu"
    # 未知の値・空文字は従来動作（cuda）へ倒す
    assert _resolve_device("mps") == "cuda"
    assert _resolve_device("") == "cuda"


def test_resolve_compute_type_falls_back_to_int8_on_cpu() -> None:
    from backend.pipeline.nodes.transcribe import _resolve_compute_type

    # CTranslate2 の CPU バックエンドは float16 を扱えない
    assert _resolve_compute_type("cpu", "float16") == "int8"
    assert _resolve_compute_type("cpu", "FP16") == "int8"
    # CPU でも扱える型はそのまま
    assert _resolve_compute_type("cpu", "int8") == "int8"
    # GPU 実行時は指定どおり
    assert _resolve_compute_type("cuda", "float16") == "float16"


def test_docker_command_omits_gpus_flag_on_cpu(monkeypatch, tmp_path) -> None:
    """CPU 実行では --gpus を付けない（NVIDIA ランタイムが無い環境で daemon が失敗するため）。"""
    from backend.pipeline.nodes import transcribe as mod

    captured: dict = {}

    def fake_run(cmd, timeout):
        captured["cmd"] = cmd
        # 出力 JSON を作らずに失敗させ、コマンド構築だけを検証する
        return 1

    monkeypatch.setattr(mod, "_run_docker_streaming", fake_run)
    audio = tmp_path / "a.wav"
    audio.write_bytes(b"RIFFTEST")

    for device, expect_gpus in (("cpu", False), ("cuda", True)):
        try:
            mod._run_docker_whisperx(
                audio_path=audio,
                image="ghcr.io/jim60105/whisperx:base-en",
                hf_token="",
                batch_size=4,
                compute_type="float16",
                cache_volume="vol",
                timeout=10,
                model_size="base",
                language="en",
                device=device,
            )
        except RuntimeError:
            pass  # 終了コード 1 で失敗するのは想定どおり

        cmd = captured["cmd"]
        assert ("--gpus" in cmd) is expect_gpus, f"device={device}"
        assert cmd[cmd.index("--device") + 1] == device
        expected_compute = "int8" if device == "cpu" else "float16"
        assert cmd[cmd.index("--compute_type") + 1] == expected_compute


def test_runtime_settings_override_language_and_device(monkeypatch, tmp_path) -> None:
    """書きおこし言語と device は runtime_settings を env より優先する。"""
    from backend.pipeline.nodes import transcribe as mod

    captured: dict = {}

    def fake_docker(**kwargs):
        captured.update(kwargs)
        return [{"start": 0.0, "end": 1.0, "text": "hello", "ja": "hello"}]

    monkeypatch.setattr(mod, "_run_docker_whisperx", fake_docker)
    monkeypatch.setenv("WHISPERX_LANGUAGE", "ja")
    monkeypatch.setenv("WHISPERX_DEVICE", "cuda")
    audio = tmp_path / "a.wav"
    audio.write_bytes(b"RIFFTEST")

    node = mod.TranscribeNode()
    result = node.run(
        _state(
            {
                "execution_mode": "production",
                "audio_path": str(audio),
                "runtime_settings": {
                    "whisperx_execution_backend": "docker",
                    "whisperx_docker_image": "ghcr.io/jim60105/whisperx:no_model",
                    "whisperx_language": "en",
                    "whisperx_device": "cpu",
                },
            }
        )
    )

    assert result.status == "success"
    assert captured["language"] == "en"
    assert captured["device"] == "cpu"
