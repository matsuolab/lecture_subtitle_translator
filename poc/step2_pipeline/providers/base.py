"""
Provider 抽象インターフェース。
LLM / Embedding / Transcribe の3種を定義。
環境変数で実装を切り替える（OpenAI / Gemini / local）。
"""

from __future__ import annotations

import math
from abc import ABC, abstractmethod
from typing import Any

from ..models.segment import TranscriptSegment


class LLMProvider(ABC):
    """テキスト生成 LLM の抽象インターフェース。"""

    def __init__(self) -> None:
        self._usage_log: list[dict[str, Any]] = []

    @abstractmethod
    async def complete(
        self,
        messages: list[dict[str, str]],
        temperature: float = 0.3,
        max_tokens: int = 4096,
    ) -> str:
        """チャット補完を実行してテキストを返す。"""
        ...

    @abstractmethod
    def model_name(self) -> str:
        """使用しているモデル名を返す。"""
        ...

    def _record_usage(self, tokens_in: int, tokens_out: int) -> None:
        """サブクラスが呼び出してトークン使用量を記録する。"""
        self._usage_log.append({
            "model": self.model_name(),
            "tokens_in": tokens_in,
            "tokens_out": tokens_out,
        })

    def flush_usage(self) -> list[dict[str, Any]]:
        """蓄積した使用量ログを取り出してリセットする。"""
        log = list(self._usage_log)
        self._usage_log.clear()
        return log


class EmbedProvider(ABC):
    """テキスト埋め込み（Embedding）の抽象インターフェース。"""

    def __init__(self) -> None:
        self._usage_log: list[dict[str, Any]] = []

    @abstractmethod
    async def embed(self, text: str) -> list[float]:
        """テキストをベクトルに変換して返す。"""
        ...

    @abstractmethod
    def dimensions(self) -> int:
        """埋め込みベクトルの次元数を返す。"""
        ...

    @abstractmethod
    def model_name(self) -> str:
        """使用しているモデル名を返す。"""
        ...

    def _record_usage(self, tokens_in: int) -> None:
        self._usage_log.append({
            "model": self.model_name(),
            "tokens_in": tokens_in,
            "tokens_out": 0,
        })

    def flush_usage(self) -> list[dict[str, Any]]:
        log = list(self._usage_log)
        self._usage_log.clear()
        return log

    def cosine_distance(self, a: list[float], b: list[float]) -> float:
        """コサイン距離 (0=同一, 1=直交, 2=逆) を返す。"""
        dot = sum(x * y for x, y in zip(a, b))
        norm_a = math.sqrt(sum(x * x for x in a))
        norm_b = math.sqrt(sum(x * x for x in b))
        if norm_a == 0 or norm_b == 0:
            return 1.0
        return 1.0 - dot / (norm_a * norm_b)


class TranscribeProvider(ABC):
    """音声書き起こしの抽象インターフェース。"""

    @abstractmethod
    async def transcribe(self, audio_path: str) -> list[TranscriptSegment]:
        """音声ファイルを書き起こしてセグメントリストを返す。"""
        ...
