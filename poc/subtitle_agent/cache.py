"""WhisperX 書き起こし結果のキャッシュライフサイクル管理.

旧PoC `cps_autonomous_agent_poc.py` の check_and_create_cache を移植。
動画から音声抽出 → WhisperX 書き起こし → 日本語校正を行い結果をキャッシュ。
2回目以降はキャッシュから即時ロードする。
"""

import json
import sys
import uuid
from pathlib import Path

# プロジェクトルートを sys.path に追加し backend モジュールを import 可能にする
PROJECT_ROOT = Path(__file__).resolve().parents[2]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.append(str(PROJECT_ROOT))

from backend.pipeline.contracts import RunState  # noqa: E402
from backend.pipeline.nodes.correct import CorrectNode  # noqa: E402
from backend.pipeline.nodes.extract_audio import ExtractAudioNode  # noqa: E402
from backend.pipeline.nodes.transcribe import TranscribeNode  # noqa: E402

CACHE_DIR = Path(__file__).resolve().parent.parent / "cache"


def load_or_build_cache(video_path: str, force: bool = False) -> list[dict]:
    """動画から書き起こしキャッシュをロード、なければ生成する。

    返り値の各セグメントは id/start/end/text/ja/words/ja_corrected を持つ。
    """
    video_path = str(Path(video_path).resolve())
    if not Path(video_path).exists():
        raise FileNotFoundError(f"動画ファイルが見つかりません: {video_path}")

    video_stem = Path(video_path).stem
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache_file = CACHE_DIR / f"{video_stem}_cache.json"

    if cache_file.exists() and not force:
        print(f"\n[CACHE] キャッシュファイルを発見: {cache_file}")
        print("[CACHE] 書き起こし処理をスキップしキャッシュをロードします。")
        with open(cache_file, "r", encoding="utf-8") as f:
            return json.load(f)

    print(f"\n[CACHE] 新規キャッシュ生成を開始します。動画: {video_path}")
    print("[CACHE] ※この処理には数分〜十数分かかる場合があります。")

    state = RunState(run_id=f"sa-run-{uuid.uuid4().hex[:8]}", schema_version="v3")
    state.data["source_media_path"] = video_path
    state.data["execution_mode"] = "production"
    state.data["allow_transcribe_fallback"] = False

    print("\n[PIPELINE] >>> 1. ffmpeg による音声抽出を実行します...")
    res_extract = ExtractAudioNode().run(state)
    if res_extract.status == "failure":
        raise RuntimeError(f"ffmpeg音声抽出に失敗: {res_extract.issues}")
    state.data.update(res_extract.updates)
    print(f"[PIPELINE] 音声抽出成功: {state.data.get('audio_path')}")

    print("\n[PIPELINE] >>> 2. Docker上の WhisperX 書き起こしを実行します...")
    state.data["runtime_settings"] = {
        "whisperx_execution_backend": "docker",
        "whisperx_docker_image": "ghcr.io/jim60105/whisperx:large-v3-ja",
    }
    state.data["strict_external_whisperx"] = True
    res_transcribe = TranscribeNode().run(state)
    if res_transcribe.status == "failure":
        raise RuntimeError(f"WhisperX書き起こしに失敗: {res_transcribe.issues}")
    state.data.update(res_transcribe.updates)
    print(
        "[PIPELINE] WhisperX書き起こし成功: "
        f"{len(state.data.get('transcript_segments', []))} セグメント取得。"
    )

    print("\n[PIPELINE] >>> 3. 決定論的日本語校正 (CorrectNode) を実行します...")
    res_correct = CorrectNode().run(state)
    if res_correct.status == "failure":
        raise RuntimeError(f"日本語校正に失敗: {res_correct.issues}")
    state.data.update(res_correct.updates)

    corrected_segments = state.data["corrected_segments"]
    print(f"[PIPELINE] 日本語校正成功: 全 {len(corrected_segments)} セグメント。")

    print(f"\n[CACHE] キャッシュファイルとして保存します: {cache_file}")
    with open(cache_file, "w", encoding="utf-8") as f:
        json.dump(corrected_segments, f, ensure_ascii=False, indent=2)

    return corrected_segments
