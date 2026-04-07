"""
字幕制約と品質閾値の管理モジュール。

YAMLファイルまたは環境変数で後から調整可能。
コードを触らずにCPS・文字数・フラグ閾値を変更できる。

設定ファイルのパス: CONSTRAINTS_FILE 環境変数（デフォルト: constraints.yaml）
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import yaml  # type: ignore[import]


@dataclass(frozen=True)
class SubtitleConstraints:
    """言語ごとの字幕制約。"""
    max_chars: int          # 1ブロックの最大文字数
    max_cps: float          # 最大 Characters Per Second
    max_retry: int          # CPS違反時の再プロンプト最大試行回数


@dataclass(frozen=True)
class QualityThresholds:
    """Embedding距離によるフラグ閾値。"""
    correction: float       # 日本語補正の乖離フラグ（コサイン距離）
    translation: float      # 英訳の乖離フラグ（コサイン距離）


@dataclass(frozen=True)
class ConstraintsConfig:
    """全制約設定のコンテナ。"""
    # 言語コード → SubtitleConstraints のマップ
    # キー: ISO 639-1 言語コード（"en", "ja", "zh" 等）
    # "_default" は未定義言語のフォールバック
    subtitle: dict[str, SubtitleConstraints]
    quality: QualityThresholds

    def get_subtitle(self, lang: str) -> SubtitleConstraints:
        """言語コードに対応する字幕制約を返す。未定義なら _default を使う。"""
        return self.subtitle.get(lang) or self.subtitle["_default"]


# ---------------------------------------------------------------------------
# デフォルト値（constraints.yaml が存在しない場合のフォールバック）
# ---------------------------------------------------------------------------

_DEFAULTS: dict = {
    "subtitle": {
        "_default": {"max_chars": 40, "max_cps": 15.0, "max_retry": 3},
        "en":       {"max_chars": 42, "max_cps": 17.0, "max_retry": 3},
        "ja":       {"max_chars": 20, "max_cps": 8.0,  "max_retry": 3},
        "zh":       {"max_chars": 16, "max_cps": 7.0,  "max_retry": 3},
        "ko":       {"max_chars": 20, "max_cps": 8.0,  "max_retry": 3},
    },
    "quality": {
        "correction": 0.15,
        "translation": 0.25,
    },
}


def load_constraints(config_path: str | None = None) -> ConstraintsConfig:
    """
    YAML ファイルから制約設定を読み込む。

    Args:
        config_path: YAML ファイルパス。
                     省略時は CONSTRAINTS_FILE 環境変数 →
                     スクリプトと同ディレクトリの constraints.yaml の順で探す。

    Returns:
        ConstraintsConfig（ファイルが存在しない場合はデフォルト値を使用）
    """
    path = (
        config_path
        or os.getenv("CONSTRAINTS_FILE")
        or str(Path(__file__).parent / "constraints.yaml")
    )

    raw: dict = dict(_DEFAULTS)

    if Path(path).exists():
        with open(path, encoding="utf-8") as f:
            loaded = yaml.safe_load(f) or {}
        # ファイルの値でデフォルトを上書き（深いマージ）
        raw = _deep_merge(_DEFAULTS, loaded)

    subtitle_map: dict[str, SubtitleConstraints] = {}
    for lang, vals in raw["subtitle"].items():
        subtitle_map[lang] = SubtitleConstraints(
            max_chars=int(vals["max_chars"]),
            max_cps=float(vals["max_cps"]),
            max_retry=int(vals["max_retry"]),
        )

    quality = QualityThresholds(
        correction=float(raw["quality"]["correction"]),
        translation=float(raw["quality"]["translation"]),
    )

    return ConstraintsConfig(subtitle=subtitle_map, quality=quality)


def apply_overrides(
    config: ConstraintsConfig,
    lang: str = "_default",
    max_chars: int | None = None,
    max_cps: float | None = None,
    max_retry: int | None = None,
    correction_threshold: float | None = None,
    translation_threshold: float | None = None,
) -> ConstraintsConfig:
    """
    ConstraintsConfig の一部の値を上書きした新しいインスタンスを返す。

    プロジェクト設定ファイル（YAML）の値を一時的に変えたい場合に使用。
    設定ファイル自体は変更しない。

    Args:
        config:                  元の ConstraintsConfig
        lang:                    上書き対象の言語コード（"en", "ja" 等）
        max_chars / max_cps / max_retry: 字幕制約の上書き値
        correction_threshold / translation_threshold: 品質閾値の上書き値

    Returns:
        上書き済みの新しい ConstraintsConfig
    """
    # 字幕制約の上書き
    new_subtitle = dict(config.subtitle)
    if any(v is not None for v in [max_chars, max_cps, max_retry]):
        base = config.get_subtitle(lang)
        new_subtitle[lang] = SubtitleConstraints(
            max_chars=max_chars if max_chars is not None else base.max_chars,
            max_cps=max_cps if max_cps is not None else base.max_cps,
            max_retry=max_retry if max_retry is not None else base.max_retry,
        )

    # 品質閾値の上書き
    new_quality = QualityThresholds(
        correction=(
            correction_threshold
            if correction_threshold is not None
            else config.quality.correction
        ),
        translation=(
            translation_threshold
            if translation_threshold is not None
            else config.quality.translation
        ),
    )

    return ConstraintsConfig(subtitle=new_subtitle, quality=new_quality)


def _deep_merge(base: dict, override: dict) -> dict:
    """override で base を再帰的に上書きする（イミュータブルに新しい dict を返す）。"""
    result = dict(base)
    for key, val in override.items():
        if key in result and isinstance(result[key], dict) and isinstance(val, dict):
            result[key] = _deep_merge(result[key], val)
        else:
            result[key] = val
    return result
