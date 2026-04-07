"""
DockerCLI WhisperX Provider。

jim60105/docker-whisperX イメージを `docker run` で実行し、
JSON 出力をパースして TranscriptSegment[] を返す。

- HTTPサーバー不要（CLI ツールとして動作）
- 単語レベルタイムスタンプあり（--output_format json）
- ローカルテスト・本番 AWS Batch どちらにも対応する設計の原型

参考: docs/research/20260403_whisperx_docker_architecture.md
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import uuid
from pathlib import Path

from ..models.segment import TranscriptSegment, WordTimestamp
from .base import TranscribeProvider


class DockerCLIWhisperXProvider(TranscribeProvider):
    """
    docker run でWhisperXを実行するProvider。

    環境変数:
        WHISPERX_DOCKER_IMAGE  : 使用するイメージ（デフォルト: ghcr.io/jim60105/whisperx:large-v3-ja）
        WHISPERX_BATCH_SIZE    : バッチサイズ（VRAM不足時は下げる、デフォルト: 8）
        WHISPERX_COMPUTE_TYPE  : float16 / int8（デフォルト: float16）
        WHISPERX_CACHE_VOLUME  : HuggingFaceキャッシュ用 Docker ボリューム名（デフォルト: whisperx_hf_cache）
                                 初回実行時に pyannote/speaker-diarization-community-1 (~600MB) を自動DL。
                                 以降はボリュームから読み込むため再DL不要。
        HF_TOKEN               : 【必須】--diarize 未使用でも whisperX が起動時に
                                 pyannote/speaker-diarization-community-1 を無条件ロードするため常に必要。
                                 HuggingFace で利用規約に同意の上、Access Token を発行すること。
    """

    # no_model / latest タグ判定用サフィックスセット
    _NO_MODEL_TAGS: frozenset[str] = frozenset({"no_model", "latest"})

    def __init__(
        self,
        image: str | None = None,
        batch_size: int | None = None,
        compute_type: str | None = None,
        hf_token: str | None = None,
        cache_volume: str | None = None,
        timeout: int | None = None,
        model_size: str | None = None,
        language: str | None = None,
    ) -> None:
        self._image = image or os.getenv(
            "WHISPERX_DOCKER_IMAGE",
            "ghcr.io/jim60105/whisperx:large-v3-ja",
        )
        self._batch_size = batch_size or int(os.getenv("WHISPERX_BATCH_SIZE", "8"))
        self._compute_type = compute_type or os.getenv(
            "WHISPERX_COMPUTE_TYPE", "float16"
        )
        self._hf_token = hf_token or os.getenv("HF_TOKEN")
        # HuggingFace キャッシュを Docker ボリュームに永続化（初回DL後は再DL不要）
        self._cache_volume = cache_volume or os.getenv(
            "WHISPERX_CACHE_VOLUME", "whisperx_hf_cache"
        )
        # 長い音声ファイルに備えてタイムアウトを長めに設定（デフォルト: 1時間）
        self._timeout = timeout or int(os.getenv("WHISPERX_TIMEOUT", "3600"))
        # no_model / latest タグ使用時に明示指定が必要な --model / --language
        self._model_size = model_size or os.getenv("WHISPERX_MODEL", "large-v3")
        self._language = language or os.getenv("WHISPERX_LANGUAGE", "ja")

    def _is_no_model_tag(self) -> bool:
        """イメージタグが no_model / latest かどうかを判定する。"""
        tag = self._image.split(":")[-1] if ":" in self._image else ""
        return tag in self._NO_MODEL_TAGS

    async def transcribe(self, audio_path: str) -> list[TranscriptSegment]:
        import asyncio

        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, self._transcribe_sync, audio_path)

    def _transcribe_sync(self, audio_path: str) -> list[TranscriptSegment]:
        audio = Path(audio_path).resolve()
        if not audio.exists():
            raise FileNotFoundError(f"音声ファイルが見つかりません: {audio}")

        # Docker コンテナ内で日本語ファイル名が UnicodeEncodeError を引き起こすため、
        # ASCII名の一時ファイルにコピーしてから処理する。
        with tempfile.TemporaryDirectory() as tmp_dir:
            safe_stem = f"audio_{uuid.uuid4().hex[:8]}"
            safe_audio = Path(tmp_dir) / f"{safe_stem}{audio.suffix}"
            shutil.copy2(audio, safe_audio)

            with tempfile.TemporaryDirectory() as tmp_output:
                cmd = self._build_command(safe_audio, tmp_output)
                self._run_docker(cmd)
                return self._load_result(safe_stem, tmp_output)

    def _build_command(self, audio: Path, output_dir: str) -> list[str]:
        """docker run コマンドを組み立てる。"""
        # Windows パスを Docker が受け付ける形式に変換（バックスラッシュ → スラッシュ）
        input_mount = _to_docker_path(audio.parent)
        output_mount = _to_docker_path(Path(output_dir))

        cmd = [
            "docker", "run", "--gpus", "all", "--rm",
            "-v", f"{input_mount}:/app/input:ro",
            "-v", f"{output_mount}:/app/output",
            # pyannote/speaker-diarization-community-1 をキャッシュボリュームに永続化。
            # 初回実行時はダウンロードが走る（~600MB）。以降はボリュームから読み込む。
            "-v", f"{self._cache_volume}:/.cache",
            # HF_TOKEN: --diarize 未使用でも古いバージョンの whisperX が DiarizationPipeline を
            # 無条件ロードするため念のため渡す。未設定の場合は空文字（HF Hub がゲストモードで動作）。
            "-e", f"HF_TOKEN={self._hf_token or ''}",
            # HTTP ヘッダーの latin-1 エンコードエラーを回避するためロケールを ASCII に固定
            "-e", "LC_ALL=C",
            "-e", "LC_CTYPE=C",
            # コンテナのホスト名を固定（Windows ホスト名が日本語の場合の対策）
            "--hostname", "whisperx-worker",
            self._image,
            "--",
            "--output_format", "json",
            "--output_dir", "/app/output",
            "--batch_size", str(self._batch_size),
            "--compute_type", self._compute_type,
            # silero VAD はイメージに事前ロード済み（pyannote VAD はキャッシュ外のため使用しない）
            "--vad_method", "silero",
            # 日本語は単語スペースがないため文字レベルのタイムスタンプが必要
            "--return_char_alignments",
            f"/app/input/{audio.name}",
        ]

        # no_model / latest タグは ENTRYPOINT に --model / --language が含まれないため明示指定
        if self._is_no_model_tag():
            cmd.extend(["--model", self._model_size, "--language", self._language])

        # HF_TOKEN が設定されている場合のみ --hf_token を渡す（話者分離は使わない）
        if self._hf_token:
            cmd.extend(["--hf_token", self._hf_token])

        return cmd

    def _run_docker(self, cmd: list[str]) -> None:
        """docker run を実行し、エラー時は RuntimeError を送出する。"""
        result = subprocess.run(
            cmd,
            capture_output=True,
            encoding="utf-8",
            errors="replace",   # デコード失敗文字を ? に置換（cp932 問題の回避）
            timeout=self._timeout,
        )
        if result.returncode != 0:
            raise RuntimeError(
                f"docker-whisperX が終了コード {result.returncode} で失敗しました。\n"
                f"--- stderr ---\n{result.stderr}\n"
                f"--- stdout ---\n{result.stdout}"
            )

    def _load_result(self, stem: str, output_dir: str) -> list[TranscriptSegment]:
        """出力JSONを読み込んで TranscriptSegment[] に変換する。"""
        json_path = Path(output_dir) / f"{stem}.json"
        if not json_path.exists():
            raise FileNotFoundError(
                f"WhisperX のJSON出力が見つかりません: {json_path}\n"
                "docker run は成功しましたが出力ファイルが生成されていない可能性があります。"
            )

        with open(json_path, encoding="utf-8") as f:
            data = json.load(f)

        return _parse_whisperx_json(data)


# ---------------------------------------------------------------------------
# JSON パーサー（モジュールレベルに置いてテストしやすくする）
# ---------------------------------------------------------------------------

def _parse_whisperx_json(data: dict) -> list[TranscriptSegment]:
    """
    WhisperX の --output_format json 出力をパースする。

    注意点（docs/research/20260403_whisperx_docker_architecture.md より）:
    - words[].start / end / score はアライメント失敗時に省略される（NaN→フィールド欠損）
    - start/end が欠損している単語は無音区間等を意味するためスキップする
    """
    segments: list[TranscriptSegment] = []

    for i, seg in enumerate(data.get("segments", [])):
        words = tuple(
            WordTimestamp(
                word=w.get("word", w.get("char", "")),
                start=float(w["start"]),
                end=float(w["end"]),
                confidence=float(w.get("score", 1.0)),
            )
            for w in seg.get("words", [])
            if "start" in w and "end" in w  # 欠損フィールドをスキップ
        )

        segments.append(
            TranscriptSegment(
                id=i,
                start=float(seg["start"]),
                end=float(seg["end"]),
                text=seg.get("text", "").strip(),
                words=words,
            )
        )

    return segments


def _to_docker_path(path: Path) -> str:
    """
    Windows の絶対パスを Docker ボリュームマウントで使える形式に変換する。

    例: C:\\Users\\foo\\bar → C:/Users/foo/bar
    Linux/Mac では変換不要。
    """
    return str(path).replace("\\", "/")
