"""
環境変数から設定を読み込むモジュール。

補正・翻訳・分割それぞれ独立した LLM を設定できる。
例: 補正は gemini-2.5-flash（安価）、翻訳は gpt-4.1（高品質）

コピー用テンプレート: .env.example を参照
"""

from __future__ import annotations

import os
from dataclasses import dataclass

from .providers.base import EmbedProvider, LLMProvider, TranscribeProvider


# ---------------------------------------------------------------------------
# LLM 設定（タスク別）
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class LLMConfig:
    """1つの LLM タスク（補正 / 翻訳 / 分割）の設定。"""
    provider: str          # "openai" | "gemini"
    openai_model: str
    gemini_model: str

    def effective_model(self) -> str:
        return self.openai_model if self.provider == "openai" else self.gemini_model


# ---------------------------------------------------------------------------
# パイプライン全体の設定
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class PipelineConfig:
    # --- WhisperX バックエンド ---
    # "remote" | "local" | "aws_batch" | "openai"
    whisperx_backend: str

    # リモートサーバー WhisperX（デフォルト・メインバックエンド）
    whisperx_server_url: str      # 例: http://192.168.1.10:9092
    whisperx_language: str        # 書き起こし言語コード（例: "ja"）

    # ローカル WhisperX
    whisperx_model: str           # "large-v3", "medium", etc.
    whisperx_device: str          # "cuda" | "cpu"
    whisperx_compute_type: str    # "float16" | "int8" | "float32"
    hf_token: str | None          # 話者分離に必要（任意）

    # AWS Batch WhisperX
    aws_batch_job_queue: str
    aws_batch_job_definition: str
    aws_s3_bucket: str
    aws_region: str
    aws_batch_poll_interval: int  # 秒

    # --- タスク別 LLM 設定 ---
    correction_llm: LLMConfig     # 日本語補正用
    translation_llm: LLMConfig    # 英訳用
    split_llm: LLMConfig          # 字幕分割・CPS修正用

    # --- Embedding バックエンド ---
    # "openai" | "gemini"
    embed_provider: str
    openai_embed_model: str
    gemini_embed_model: str

    # --- 品質チェック閾値 ---
    correction_flag_threshold: float
    translation_flag_threshold: float

    # --- LLM バッチサイズ ---
    llm_batch_size: int

    # --- 出力ディレクトリ ---
    output_dir: str


def load_config() -> PipelineConfig:
    """環境変数から PipelineConfig を生成する。"""
    return PipelineConfig(
        # WhisperX
        whisperx_backend=os.getenv("WHISPERX_BACKEND", "remote"),
        whisperx_server_url=os.getenv("WHISPERX_SERVER_URL", "http://127.0.0.1:9092"),
        whisperx_language=os.getenv("WHISPERX_LANGUAGE", "ja"),
        whisperx_model=os.getenv("WHISPERX_MODEL", "large-v3"),
        whisperx_device=os.getenv("WHISPERX_DEVICE", "cuda"),
        whisperx_compute_type=os.getenv("WHISPERX_COMPUTE_TYPE", "float16"),
        hf_token=os.getenv("HF_TOKEN"),

        # AWS Batch
        aws_batch_job_queue=os.getenv("AWS_BATCH_JOB_QUEUE", ""),
        aws_batch_job_definition=os.getenv("AWS_BATCH_JOB_DEFINITION", ""),
        aws_s3_bucket=os.getenv("AWS_S3_BUCKET", ""),
        aws_region=os.getenv("AWS_REGION", "ap-northeast-1"),
        aws_batch_poll_interval=int(os.getenv("AWS_BATCH_POLL_INTERVAL", "30")),

        # 補正 LLM（デフォルト: gemini-2.5-flash で安価に）
        correction_llm=LLMConfig(
            provider=os.getenv("CORRECTION_LLM_PROVIDER", "gemini"),
            openai_model=os.getenv("CORRECTION_OPENAI_MODEL", "gpt-4.1-mini"),
            gemini_model=os.getenv("CORRECTION_GEMINI_MODEL", "gemini-2.5-flash"),
        ),

        # 翻訳 LLM（デフォルト: gpt-4.1 で高品質に）
        translation_llm=LLMConfig(
            provider=os.getenv("TRANSLATION_LLM_PROVIDER", "openai"),
            openai_model=os.getenv("TRANSLATION_OPENAI_MODEL", "gpt-4.1"),
            gemini_model=os.getenv("TRANSLATION_GEMINI_MODEL", "gemini-2.5-flash"),
        ),

        # 分割・CPS修正 LLM（軽量タスクなので安価モデルで十分）
        split_llm=LLMConfig(
            provider=os.getenv("SPLIT_LLM_PROVIDER", "openai"),
            openai_model=os.getenv("SPLIT_OPENAI_MODEL", "gpt-4.1-mini"),
            gemini_model=os.getenv("SPLIT_GEMINI_MODEL", "gemini-2.5-flash"),
        ),

        # Embedding
        embed_provider=os.getenv("EMBED_PROVIDER", "openai"),
        openai_embed_model=os.getenv("OPENAI_EMBED_MODEL", "text-embedding-3-small"),
        gemini_embed_model=os.getenv(
            "GEMINI_EMBED_MODEL", "models/text-embedding-004"
        ),

        # 閾値
        correction_flag_threshold=float(
            os.getenv("CORRECTION_FLAG_THRESHOLD", "0.15")
        ),
        translation_flag_threshold=float(
            os.getenv("TRANSLATION_FLAG_THRESHOLD", "0.25")
        ),

        llm_batch_size=int(os.getenv("LLM_BATCH_SIZE", "20")),
        output_dir=os.getenv("OUTPUT_DIR", "./output"),
    )


# ---------------------------------------------------------------------------
# Providers コンテナ
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class Providers:
    """パイプライン全体で使う Provider インスタンスをまとめるコンテナ。"""
    correction_llm: LLMProvider
    translation_llm: LLMProvider
    split_llm: LLMProvider
    embed: EmbedProvider
    transcribe: TranscribeProvider


def _build_llm(cfg: LLMConfig) -> LLMProvider:
    if cfg.provider == "openai":
        from .providers.openai_provider import OpenAILLMProvider
        return OpenAILLMProvider(model=cfg.openai_model)
    if cfg.provider == "gemini":
        from .providers.gemini_provider import GeminiLLMProvider
        return GeminiLLMProvider(model=cfg.gemini_model)
    raise ValueError(f"未知の LLM provider: {cfg.provider!r}")


def build_providers(config: PipelineConfig) -> Providers:
    """設定に基づいて Providers を生成して返す。"""
    # タスク別 LLM
    correction_llm = _build_llm(config.correction_llm)
    translation_llm = _build_llm(config.translation_llm)
    split_llm = _build_llm(config.split_llm)

    # Embedding
    if config.embed_provider == "openai":
        from .providers.openai_provider import OpenAIEmbedProvider
        embed: EmbedProvider = OpenAIEmbedProvider(model=config.openai_embed_model)
    elif config.embed_provider == "gemini":
        from .providers.gemini_provider import GeminiEmbedProvider
        embed = GeminiEmbedProvider(model=config.gemini_embed_model)
    else:
        raise ValueError(f"未知の EMBED_PROVIDER: {config.embed_provider!r}")

    # Transcribe (WhisperX)
    if config.whisperx_backend == "remote":
        from .providers.remote_whisperx_provider import RemoteWhisperXProvider
        transcribe: TranscribeProvider = RemoteWhisperXProvider(
            base_url=config.whisperx_server_url,
            language=config.whisperx_language,
        )
    elif config.whisperx_backend == "local":
        from .providers.local_whisperx_provider import LocalWhisperXProvider
        transcribe = LocalWhisperXProvider(
            model_size=config.whisperx_model,
            device=config.whisperx_device,
            compute_type=config.whisperx_compute_type,
            hf_token=config.hf_token,
        )
    elif config.whisperx_backend == "aws_batch":
        from .providers.aws_batch_whisperx_provider import AWSBatchWhisperXProvider
        transcribe = AWSBatchWhisperXProvider(
            job_queue=config.aws_batch_job_queue,
            job_definition=config.aws_batch_job_definition,
            s3_bucket=config.aws_s3_bucket,
            region=config.aws_region,
            poll_interval=config.aws_batch_poll_interval,
        )
    elif config.whisperx_backend == "docker_cli":
        from .providers.docker_cli_whisperx_provider import DockerCLIWhisperXProvider
        transcribe = DockerCLIWhisperXProvider(
            compute_type=config.whisperx_compute_type,
            hf_token=config.hf_token,
            model_size=config.whisperx_model,
            language=config.whisperx_language,
        )
    elif config.whisperx_backend == "openai":
        from .providers.openai_provider import OpenAITranscribeProvider
        transcribe = OpenAITranscribeProvider()
    else:
        raise ValueError(f"未知の WHISPERX_BACKEND: {config.whisperx_backend!r}")

    return Providers(
        correction_llm=correction_llm,
        translation_llm=translation_llm,
        split_llm=split_llm,
        embed=embed,
        transcribe=transcribe,
    )
