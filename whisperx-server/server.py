"""
WhisperX HTTP サーバー。
ghcr.io/jim60105/whisperx:large-v3-ja をベースにした FastAPI ラッパー。

エンドポイント:
    GET  /health            — ヘルスチェック
    POST /transcribe        — WAV を受け取り単語タイムスタンプ付き JSON を返す

レスポンス形式（whisperxProvider.ts の Zod スキーマに合わせた形式）:
    {
        "segments": [
            {
                "start": 0.0,
                "end":   2.5,
                "text":  "テキスト",
                "words": [
                    {"word": "テキスト", "start": 0.1, "end": 0.8, "score": 0.92}
                ]
            }
        ]
    }

注意点（調査ログ 20260403_whisperx_docker_architecture.md より）:
- words[].start / end は NaN のとき JSON から省略される → パーサーでスキップ必要
- 現在の WhisperX イメージ実装では `return_char_level_alignments` 非対応のため渡さない
- --vad_method silero はイメージキャッシュ済みのため起動が速い
- HuggingFace Token は --diarize なしなら不要
"""
from __future__ import annotations

import os
import tempfile
import uuid
import hashlib
from pathlib import Path

import whisperx
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

# ---------------------------------------------------------------------------
# 設定（環境変数で上書き可能）
# ---------------------------------------------------------------------------

DEVICE = os.getenv("WHISPERX_DEVICE", "cuda")
COMPUTE_TYPE = os.getenv("WHISPERX_COMPUTE_TYPE", "float16")  # VRAM不足時は int8
MODEL_SIZE = os.getenv("WHISPERX_MODEL", "large-v3")
BATCH_SIZE = int(os.getenv("WHISPERX_BATCH_SIZE", "8"))       # VRAM不足時は 4


def _compute_server_version() -> str:
    return hashlib.sha256(Path(__file__).read_bytes()).hexdigest()[:16]


SERVER_VERSION = _compute_server_version()

# ---------------------------------------------------------------------------
# アプリ初期化
# ---------------------------------------------------------------------------

app = FastAPI(title="WhisperX Transcription Server", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["POST", "GET"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# モデルをアプリ起動時に一度だけロードする（リクエストごとのロードを避ける）
# large-v3-ja タグはモデルキャッシュ済みなのでダウンロードは発生しない
# ---------------------------------------------------------------------------

print(
    f"[startup] モデルロード中: {MODEL_SIZE} / device={DEVICE} / "
    f"compute={COMPUTE_TYPE} / version={SERVER_VERSION}"
)
_whisper_model = whisperx.load_model(
    MODEL_SIZE,
    DEVICE,
    compute_type=COMPUTE_TYPE,
    # Silero VAD はイメージキャッシュ済み。pyannote VAD より起動が速い
    vad_method="silero",
)
print("[startup] モデルロード完了。リクエスト受付中...")

# アライメントモデルは言語ごとにキャッシュする（同一言語のリクエストを効率化）
_align_models: dict[str, tuple] = {}


def _get_align_model(language: str) -> tuple:
    if language not in _align_models:
        print(f"[align] アライメントモデルロード中: {language}")
        model, metadata = whisperx.load_align_model(
            language_code=language,
            device=DEVICE,
        )
        _align_models[language] = (model, metadata)
    return _align_models[language]


# ---------------------------------------------------------------------------
# エンドポイント
# ---------------------------------------------------------------------------

@app.get("/health")
def health() -> dict:
    return {
        "status": "ok",
        "model": MODEL_SIZE,
        "device": DEVICE,
        "compute_type": COMPUTE_TYPE,
        "server_version": SERVER_VERSION,
    }


@app.post("/transcribe")
async def transcribe(
    file: UploadFile = File(..., description="WAV or other audio file"),
    language: str = Form("ja", description="言語コード（例: ja / en / zh）"),
) -> dict:
    """
    音声ファイルを受け取り、WhisperX で書き起こして単語レベルタイムスタンプを返す。

    - Content-Type: multipart/form-data
    - file: WAV バイナリ
    - language: 言語コード（デフォルト: ja）
    """
    suffix = Path(file.filename or "audio.wav").suffix or ".wav"
    tmp_path = Path(tempfile.gettempdir()) / f"whisperx_{uuid.uuid4().hex[:8]}{suffix}"

    try:
        content = await file.read()
        tmp_path.write_bytes(content)

        # 書き起こし
        audio = whisperx.load_audio(str(tmp_path))
        result = _whisper_model.transcribe(
            audio,
            batch_size=BATCH_SIZE,
            language=language,
        )

        # 単語レベルアライメント
        try:
            align_model, metadata = _get_align_model(language)
            result = whisperx.align(
                result["segments"],
                align_model,
                metadata,
                audio,
                DEVICE,
            )
            aligned_words = sum(len(seg.get("words", [])) for seg in result.get("segments", []))
            print(
                f"[align] success language={language} "
                f"segments={len(result.get('segments', []))} words={aligned_words}"
            )
        except Exception as align_err:
            # アライメント失敗時は書き起こし結果のみで返す（タイムスタンプ精度は落ちる）
            print(f"[warn] アライメント失敗（書き起こし結果のみ返却）: {align_err}")

        return _format_response(result)

    except Exception as exc:
        print(f"[error] transcribe 失敗: {exc}")
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    finally:
        tmp_path.unlink(missing_ok=True)


# ---------------------------------------------------------------------------
# レスポンス整形
# ---------------------------------------------------------------------------

def _format_response(result: dict) -> dict:
    """
    WhisperX の出力を whisperxProvider.ts の Zod スキーマに合わせた形式に変換する。
    words[].start / end が欠損している単語はスキップする（アライメント失敗箇所）。
    """
    segments = []

    for seg in result.get("segments", []):
        words = []
        for w in seg.get("words", []):
            # start / end が欠損している単語は NaN のためスキップ
            if "start" not in w or "end" not in w:
                continue
            words.append({
                "word": w.get("word") or w.get("char", ""),
                "start": float(w["start"]),
                "end": float(w["end"]),
                "score": float(w.get("score", 1.0)),
            })

        segments.append({
            "start": float(seg["start"]),
            "end": float(seg["end"]),
            "text": seg.get("text", "").strip(),
            "words": words,
        })

    return {"segments": segments}
