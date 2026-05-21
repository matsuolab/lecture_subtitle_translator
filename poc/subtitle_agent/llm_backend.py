"""LLMバックエンド抽象 — 本番モデル差し替えとPoCのClaude委譲を同じ口で扱う.

本番 backend/pipeline/nodes/translate.py は全モデルを OpenAI互換
`/chat/completions` エンドポイント `(base_url, api_key, model)` として扱う
(Gemini も OpenAI互換経由)。PoC の「強モデル役」(分割候補提案・メタ進化) だけは
ログイン済みサブスクリプションを使うため `claude -p` に委譲する。

強モデルを使う関数 (cue.re_segment / evolution.evolve_prompts) は LLMBackend を
引数で受け取り、実体は呼び出し元 (cli.py) が選ぶ:
  - PoC          : ClaudeCliBackend
  - 本番         : 設定モデルの OpenAICompatibleBackend
"""

import hashlib
import json
import shutil
import subprocess
import time
from pathlib import Path
from typing import Protocol

import openai

from poc.subtitle_agent.cost import TokenUsage


class LLMBackend(Protocol):
    """強モデル役の最小インターフェース。"""

    def complete(self, system: str, user: str, temperature: float = 0.2) -> str:
        """system 指示と user 入力から応答テキストを返す。"""
        ...


class OpenAICompatibleBackend:
    """OpenAI互換 `/chat/completions` バックエンド。本番モデル・ローカル gemma 共通。

    一時エラーに備え retries 回までリトライし、全失敗時は RuntimeError を投げる
    (ClaudeCliBackend と挙動を揃え、re_segment のフォールバックが捕捉できる)。
    """

    def __init__(
        self, base_url: str, api_key: str, model: str, retries: int = 3
    ) -> None:
        self._client = openai.OpenAI(base_url=base_url, api_key=api_key)
        self._model = model
        self._retries = retries
        # トークン利用量の累積 (実 API 呼び出しのみ計上)
        self._calls = 0
        self._prompt_tokens = 0
        self._cached_tokens = 0
        self._completion_tokens = 0

    @property
    def model(self) -> str:
        return self._model

    @property
    def token_usage(self) -> TokenUsage:
        """このバックエンドの累積トークン利用量。コスト算出に用いる。"""
        return TokenUsage(
            model=self._model,
            calls=self._calls,
            prompt_tokens=self._prompt_tokens,
            cached_tokens=self._cached_tokens,
            completion_tokens=self._completion_tokens,
        )

    def _record_usage(self, response: object) -> None:
        """API レスポンスの usage を累積する。"""
        usage = getattr(response, "usage", None)
        if usage is None:
            return
        self._calls += 1
        self._prompt_tokens += getattr(usage, "prompt_tokens", 0) or 0
        self._completion_tokens += getattr(usage, "completion_tokens", 0) or 0
        details = getattr(usage, "prompt_tokens_details", None)
        if details is not None:
            self._cached_tokens += getattr(details, "cached_tokens", 0) or 0

    def complete(self, system: str, user: str, temperature: float = 0.2) -> str:
        last_err = ""
        for attempt in range(self._retries):
            try:
                response = self._client.chat.completions.create(
                    model=self._model,
                    messages=[
                        {"role": "system", "content": system},
                        {"role": "user", "content": user},
                    ],
                    temperature=temperature,
                )
                self._record_usage(response)
                return (response.choices[0].message.content or "").strip()
            except Exception as e:  # noqa: BLE001 - 種別を問わずリトライ対象
                last_err = str(e)
                if attempt < self._retries - 1:
                    time.sleep(2 * (attempt + 1))
        raise RuntimeError(
            f"OpenAI互換API ({self._model}) が {self._retries} 回失敗しました "
            f"— {last_err}"
        )


class ClaudeCliBackend:
    """`claude -p` サブプロセスバックエンド。PoC専用の強モデル役。

    Claude Code CLI のログイン済み認証をそのまま使うため ANTHROPIC_API_KEY は不要。
    CLI は system/user を分離しないため両者を1プロンプトに連結する。
    temperature は CLI が受け付けないため無視する。
    """

    def __init__(self, timeout: int = 300, retries: int = 3) -> None:
        self._timeout = timeout
        self._retries = retries

    @staticmethod
    def available() -> bool:
        """claude CLI が PATH 上に存在するか。"""
        return shutil.which("claude") is not None

    def complete(self, system: str, user: str, temperature: float = 0.2) -> str:
        """claude -p を呼ぶ。一時エラーに備え retries 回までリトライする。

        全リトライ失敗時は RuntimeError。呼び出し側 (re_segment) はこれを捕捉し
        当該セグメントを均等分割にフォールバックさせるため、1件の失敗で実行
        全体は止まらない。
        """
        exe = shutil.which("claude")
        if exe is None:
            raise RuntimeError(
                "claude CLI が見つかりません。Claude Code をインストールし "
                "ログインしてください。"
            )
        prompt = f"{system}\n\n{user}" if system else user
        last_err = ""
        for attempt in range(self._retries):
            try:
                result = subprocess.run(
                    [exe, "-p", prompt],
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    timeout=self._timeout,
                )
            except subprocess.TimeoutExpired:
                last_err = f"timeout ({self._timeout}s)"
            else:
                if result.returncode == 0:
                    return (result.stdout or "").strip()
                last_err = (
                    f"code {result.returncode} | "
                    f"stderr={(result.stderr or '').strip()[:300]} | "
                    f"stdout={(result.stdout or '').strip()[:300]}"
                )
            if attempt < self._retries - 1:
                time.sleep(2 * (attempt + 1))
        raise RuntimeError(
            f"claude -p が {self._retries} 回失敗しました — {last_err}"
        )


class CachingBackend:
    """任意の LLMBackend をディスクキャッシュで包む。

    ASR書き起こしキャッシュ (cache.py) とは別物。これは強モデル呼び出し
    (再分割の候補提案・メタ進化) の応答をキャッシュする。

    キーは (system + user) の SHA-256。同一プロンプトの claude 呼び出しは
    世代をまたいで、また実験の再実行をまたいで再利用される。
    temperature はキー・呼び出しから除外する — キャッシュにより呼び出しは
    決定論化するが、PoC最適化ハーネスでは再現性としてむしろ望ましい。
    """

    def __init__(self, inner: LLMBackend, cache_path: str | Path) -> None:
        self._inner = inner
        self._path = Path(cache_path)
        self._cache: dict[str, str] = {}
        if self._path.exists():
            self._cache = json.loads(self._path.read_text(encoding="utf-8"))
        self._hits = 0
        self._misses = 0

    @staticmethod
    def _key(system: str, user: str) -> str:
        h = hashlib.sha256()
        h.update(system.encode("utf-8"))
        h.update(b"\x00")
        h.update(user.encode("utf-8"))
        return h.hexdigest()

    def complete(self, system: str, user: str, temperature: float = 0.2) -> str:
        key = self._key(system, user)
        cached = self._cache.get(key)
        if cached is not None:
            self._hits += 1
            return cached
        self._misses += 1
        result = self._inner.complete(system, user, temperature)
        self._cache[key] = result
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._path.write_text(
            json.dumps(self._cache, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        return result

    @property
    def stats(self) -> tuple[int, int]:
        """(キャッシュヒット数, ミス数)。"""
        return self._hits, self._misses
